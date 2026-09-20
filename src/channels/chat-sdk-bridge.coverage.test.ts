/**
 * Coverage-uplift tests for the Chat SDK bridge — the surfaces the sibling
 * chat-sdk-bridge*.test.ts files leave out:
 *
 *  - inbound serialization (attachments, reply context, author projection)
 *    driven through the REAL Chat dispatch for every registered path
 *    (subscribed / mention / DM / plain);
 *  - onAction edge cases (foreign ids, short ids, no render row, edit failure,
 *    index out of range, anonymous actor);
 *  - the Discord-style gateway path: local forwarded-event webhook server,
 *    interaction handling (fetch is stubbed — nothing leaves the process),
 *    listener restart backoff and abort on teardown;
 *  - deliver(): edit/reaction/ask_question/card/text/file branches;
 *  - the small exported helpers (app-context cache, terminal card, splitter).
 */
import http from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, Chat } from 'chat';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createPendingApproval } from '../db/sessions.js';
import { log } from '../log.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  appContextEntities,
  attachAppContext,
  buildTerminalApprovalCard,
  cacheAppContext,
  createChatSdkBridge,
  registerBridgeInboundPolicy,
  setAgentDmOpenedHandler,
  setMembershipHandler,
  splitForLimit,
  takeAppContext,
  type MembershipEvent,
} from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface ChatDriver {
  processMessage(adapter: Adapter, threadId: string, message: unknown): Promise<void>;
}

interface Recorded {
  posts: Array<{ threadId: string; message: AdapterPostableMessage }>;
  edits: Array<{ threadId: string; messageId: string; message: AdapterPostableMessage }>;
  reactions: Array<{ threadId: string; messageId: string; emoji: string }>;
  typing: string[];
  webhooks: Array<{ headers: Record<string, string>; body: string }>;
}

interface GatewayStart {
  webhookUrl: string | undefined;
  durationMs: number | undefined;
  signal: AbortSignal | undefined;
  resolveListener: () => void;
  rejectListener: (err: unknown) => void;
}

interface StubOptions {
  name?: string;
  isDM?: (threadId: string) => boolean;
  postReturnsUndefined?: boolean;
  editThrows?: Error;
  webhookThrows?: Error;
  gateway?: boolean;
  gatewayNoWaitUntil?: boolean;
}

function makeAdapter(opts: StubOptions = {}) {
  const calls: Recorded = { posts: [], edits: [], reactions: [], typing: [], webhooks: [] };
  const gatewayStarts: GatewayStart[] = [];
  let captured: ChatDriver | null = null;
  const adapter = {
    name: opts.name ?? 'slack',
    initialize: async (chat: ChatDriver) => {
      captured = chat;
    },
    channelIdFromThreadId: (threadId: string) => threadId.split(':').slice(0, 2).join(':'),
    isDM: opts.isDM,
    postMessage: async (threadId: string, message: AdapterPostableMessage) => {
      calls.posts.push({ threadId, message });
      return opts.postReturnsUndefined ? undefined : { id: `post-${calls.posts.length}`, threadId, raw: {} };
    },
    editMessage: async (threadId: string, messageId: string, message: AdapterPostableMessage) => {
      if (opts.editThrows) throw opts.editThrows;
      calls.edits.push({ threadId, messageId, message });
      return { id: messageId, threadId, raw: {} };
    },
    addReaction: async (threadId: string, messageId: string, emoji: string) => {
      calls.reactions.push({ threadId, messageId, emoji });
    },
    startTyping: async (threadId: string) => {
      calls.typing.push(threadId);
    },
    handleWebhook: async (req: Request) => {
      calls.webhooks.push({ headers: Object.fromEntries(req.headers.entries()), body: await req.text() });
      if (opts.webhookThrows) throw opts.webhookThrows;
      return new Response('ok');
    },
  } as Record<string, unknown>;
  if (opts.gateway) {
    adapter.startGatewayListener = async (
      options: { waitUntil?: (p: Promise<unknown>) => void },
      durationMs?: number,
      signal?: AbortSignal,
      webhookUrl?: string,
    ) => {
      const start: GatewayStart = {
        webhookUrl,
        durationMs,
        signal,
        resolveListener: () => {},
        rejectListener: () => {},
      };
      if (!opts.gatewayNoWaitUntil) {
        const listener = new Promise<void>((resolve, reject) => {
          start.resolveListener = resolve;
          start.rejectListener = reject;
        });
        options.waitUntil?.(listener);
      }
      gatewayStarts.push(start);
      return new Response('started');
    };
  }
  return {
    adapter: adapter as unknown as Adapter,
    calls,
    gatewayStarts,
    chat: (): ChatDriver => {
      if (!captured) throw new Error('adapter not initialized — call bridge.setup() first');
      return captured;
    },
  };
}

let nextMessageId = 0;

interface MessageOptions {
  author?: Record<string, unknown> | undefined;
  isMention?: boolean;
  attachments?: unknown[];
  raw?: unknown;
  id?: string;
}

/** Duck-typed Chat SDK message — the fields the SDK dispatch + bridge read. */
function makeMessage(text: string, opts: MessageOptions = {}): Record<string, unknown> {
  const id = opts.id ?? `msg-${++nextMessageId}`;
  const author =
    'author' in opts
      ? opts.author
      : { userId: 'U123', userName: 'human', fullName: 'A Human', isBot: false, isMe: false };
  const payload: Record<string, unknown> = { id, text };
  if (author !== undefined) payload.author = author;
  return {
    ...payload,
    // The SDK reads message.author.* for logging/isMe before dispatch.
    author: author ?? { isMe: false },
    attachments: opts.attachments ?? [],
    isMention: opts.isMention ?? false,
    metadata: { dateSent: new Date('2026-01-01T00:00:00.000Z') },
    raw: opts.raw,
    toJSON: () => ({ ...payload, raw: opts.raw }),
  };
}

interface InboundCall {
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

function makeHostConfig() {
  const calls: InboundCall[] = [];
  const actions: string[] = [];
  const hostConfig: ChannelSetup = {
    onInbound: (platformId, threadId, message) => {
      calls.push({ platformId, threadId, message });
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: (questionId, selectedOption, userId) => {
      actions.push(`${questionId}:${selectedOption}:${userId}`);
    },
  };
  return { hostConfig, calls, actions };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatOf = (bridge: unknown): Chat => (bridge as any)._chat as Chat;

async function dispatch(fire: (options: { waitUntil: (p: Promise<unknown>) => void }) => void): Promise<void> {
  let task: Promise<unknown> | undefined;
  fire({
    waitUntil: (p) => {
      task = p;
    },
  });
  await task;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function postJson(url: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createPendingApproval({
    approval_id: 'q-1',
    session_id: null,
    request_id: 'q-1',
    action: 'test_action',
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'Approval needed',
    question: 'Allow it?',
    options_json: JSON.stringify([
      { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
      { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
    ]),
  });
});

afterEach(async () => {
  await closeDb();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setAgentDmOpenedHandler(() => {});
});

// ---------------------------------------------------------------------------
// Agent-DM opened hook
// ---------------------------------------------------------------------------

// FIRST in the file on purpose: the handler slot is a module-level singleton
// that can only ever be null before the first registration (afterEach parks
// a no-op there), so the "no handler" arm is reachable only from test #1.
describe('agent-DM opened hook', () => {
  it('with no handler registered the event still caches the app context', async () => {
    const { adapter } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(makeHostConfig().hostConfig);
    await dispatch((options) =>
      chatOf(bridge).processAssistantThreadStarted(
        { adapter, channelId: 'D7', context: { channelId: 'C7' }, threadId: 'D7:1', threadTs: '1', userId: 'U7' },
        options,
      ),
    );
    expect(takeAppContext('slack', 'D7', 'U7')).toEqual([{ type: 'channel', id: 'C7' }]);
    await bridge.teardown();
  });

  it('an async-rejecting handler is logged, not thrown into SDK dispatch', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const boom = new Error('async boom');
    setAgentDmOpenedHandler(async () => {
      throw boom;
    });
    const { adapter } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(makeHostConfig().hostConfig);
    await dispatch((options) =>
      chatOf(bridge).processAssistantThreadStarted(
        { adapter, channelId: 'D8', context: {}, threadId: 'D8:1', threadTs: '1', userId: 'U8' },
        options,
      ),
    );
    await tick();
    expect(warn).toHaveBeenCalledWith('Agent-DM opened handler failed', { channelId: 'D8', err: boom });
    await bridge.teardown();
  });

  it('a synchronously throwing handler is logged too', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const boom = new Error('sync boom');
    setAgentDmOpenedHandler(() => {
      throw boom;
    });
    const { adapter } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(makeHostConfig().hostConfig);
    await dispatch((options) =>
      chatOf(bridge).processAssistantThreadStarted(
        { adapter, channelId: 'D9', context: {}, threadId: 'D9:1', threadTs: '1', userId: 'U9' },
        options,
      ),
    );
    expect(warn).toHaveBeenCalledWith('Agent-DM opened handler threw', { channelId: 'D9', err: boom });
    await bridge.teardown();
  });
});

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

describe('helpers', () => {
  it('rejects non-URL-safe instance names at construction', () => {
    const { adapter } = makeAdapter();
    expect(() => createChatSdkBridge({ adapter, instance: 'a:b', supportsThreads: true })).toThrow(/URL-safe/);
    expect(() => createChatSdkBridge({ adapter, instance: 'ok-name', supportsThreads: true })).not.toThrow();
  });

  it('takeAppContext drops an expired entry (and consumes it)', () => {
    const t0 = 5_000_000;
    cacheAppContext('slack', 'D1', 'U1', [{ type: 'channel', id: 'C1' }], t0);
    expect(takeAppContext('slack', 'D1', 'U1', t0 + 5 * 60 * 1000 + 1)).toBeUndefined();
    expect(takeAppContext('slack', 'D1', 'U1', t0)).toBeUndefined();
  });

  it('attachAppContext never overwrites a context the SDK already attached', () => {
    cacheAppContext('slack', 'D1', 'U1', [{ type: 'channel', id: 'C1' }]);
    const content: Record<string, unknown> = { app_context: { entities: [{ type: 'list', id: 'L1' }] } };
    attachAppContext(content, 'slack', 'D1', 'U1');
    expect(content.app_context).toEqual({ entities: [{ type: 'list', id: 'L1' }] });
    // The cached entry is untouched because the early return happens before the take.
    expect(takeAppContext('slack', 'D1', 'U1')).toEqual([{ type: 'channel', id: 'C1' }]);
  });

  it('splitForLimit returns the text as-is under the limit and hard-cuts when no whitespace exists', () => {
    expect(splitForLimit('fits', 10)).toEqual(['fits']);
    expect(splitForLimit('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('appContextEntities reads a top-level entities array and tolerates malformed entries', () => {
    const event = {
      channelId: 'D1',
      userId: 'U1',
      entities: [
        { type: 'channel', channel_id: 'C1' },
        { type: 'list', entity_id: 'L1' },
        { type: 'canvas', id: 42 }, // non-string id — dropped
        { type: 7, id: 'X' }, // non-string type — dropped
        null,
        'garbage',
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(appContextEntities(event as any)).toEqual([
      { type: 'channel', id: 'C1' },
      { type: 'list', id: 'L1' },
    ]);
  });

  it('appContextEntities yields nothing without entities or a context channel id', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(appContextEntities({ channelId: 'D1', userId: 'U1' } as any)).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(appContextEntities({ channelId: 'D1', userId: 'U1', context: { channelId: '' } } as any)).toEqual([]);
  });

  it('cacheAppContext with no entities clears the slot; attachAppContext leaves content alone when nothing is cached', () => {
    cacheAppContext('slack', 'D1', 'U1', [{ type: 'channel', id: 'C1' }]);
    cacheAppContext('slack', 'D1', 'U1', []);
    expect(takeAppContext('slack', 'D1', 'U1')).toBeUndefined();

    const content: Record<string, unknown> = { text: 'hi' };
    attachAppContext(content, 'slack', 'D1', 'U1');
    expect(content).toEqual({ text: 'hi' });
  });

  it('buildTerminalApprovalCard omits the question block when the question is empty', () => {
    const card = buildTerminalApprovalCard({ title: 'T', question: '', resolution: 'done' }) as unknown as {
      title: string;
      children: Array<{ type: string; content?: string; style?: string }>;
    };
    expect(card.title).toBe('T');
    expect(card.children).toEqual([{ type: 'text', content: 'done', style: 'muted' }]);
  });

  it('splitForLimit drops an all-whitespace tail instead of emitting an empty chunk', () => {
    expect(splitForLimit('abcde ', 5)).toEqual(['abcde']);
  });

  it('registerBridgeInboundPolicy warns when a channel type is registered twice and the last wrap wins', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const applied: string[] = [];
    registerBridgeInboundPolicy('coverage-only-platform', (setup, key) => {
      applied.push(`first:${key}`);
      return setup;
    });
    registerBridgeInboundPolicy('coverage-only-platform', async (setup, key) => {
      applied.push(`second:${key}`);
      return setup;
    });
    expect(warn).toHaveBeenCalledWith('Bridge inbound policy overwritten', { channelType: 'coverage-only-platform' });

    const { adapter } = makeAdapter({ name: 'coverage-only-platform' });
    const bridge = createChatSdkBridge({ adapter, instance: 'cop-two', supportsThreads: true });
    await bridge.setup(makeHostConfig().hostConfig);
    expect(applied).toEqual(['second:cop-two']);
    await bridge.teardown();
  });
});

// ---------------------------------------------------------------------------
// Membership hook + polling adapters
// ---------------------------------------------------------------------------

describe('membership hook', () => {
  it('forwards member_joined_channel to the channel-type handler; contains sync throws and async rejections', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const events: MembershipEvent[] = [];
    let mode: 'record' | 'throw' | 'reject' = 'record';
    const syncBoom = new Error('sync');
    const asyncBoom = new Error('async');
    setMembershipHandler('cov-platform', (event) => {
      if (mode === 'throw') throw syncBoom;
      if (mode === 'reject') return Promise.reject(asyncBoom);
      events.push(event);
    });
    // A second registration overwrites with a warning.
    setMembershipHandler('cov-platform', (event) => {
      if (mode === 'throw') throw syncBoom;
      if (mode === 'reject') return Promise.reject(asyncBoom);
      events.push(event);
    });
    expect(warn).toHaveBeenCalledWith('Membership handler overwritten', { channelType: 'cov-platform' });

    const { adapter } = makeAdapter({ name: 'cov-platform' });
    const bridge = createChatSdkBridge({ adapter, instance: 'cov-two', supportsThreads: true });
    await bridge.setup(makeHostConfig().hostConfig);
    const join = (channelId: string, options: { waitUntil: (p: Promise<unknown>) => void }) =>
      chatOf(bridge).processMemberJoinedChannel({ adapter, channelId, userId: 'U1', inviterId: 'U0' }, options);

    await dispatch((o) => join('C1', o));
    expect(events).toEqual([
      { instance: 'cov-two', channelType: 'cov-platform', channelId: 'C1', userId: 'U1', inviterId: 'U0' },
    ]);

    mode = 'throw';
    await dispatch((o) => join('C2', o));
    expect(error).toHaveBeenCalledWith('Membership handler threw', {
      channelType: 'cov-platform',
      channelId: 'C2',
      userId: 'U1',
      err: syncBoom,
    });

    mode = 'reject';
    await dispatch((o) => join('C3', o));
    await tick();
    expect(error).toHaveBeenCalledWith('Membership handler failed', {
      channelType: 'cov-platform',
      channelId: 'C3',
      userId: 'U1',
      err: asyncBoom,
    });

    // A platform with no handler: silent no-op.
    const other = makeAdapter({ name: 'cov-unhandled' });
    const otherBridge = createChatSdkBridge({ adapter: other.adapter, supportsThreads: true });
    await otherBridge.setup(makeHostConfig().hostConfig);
    await dispatch((o) =>
      chatOf(otherBridge).processMemberJoinedChannel({ adapter: other.adapter, channelId: 'C9', userId: 'U9' }, o),
    );
    expect(events).toHaveLength(1);
    await otherBridge.teardown();
    await bridge.teardown();
  });
});

describe('polling adapters', () => {
  it('register no webhook route when the adapter resolves runtimeMode=polling during initialize', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
    const stub = makeAdapter({ name: 'telegram' });
    const raw = stub.adapter as unknown as { runtimeMode?: string; initialize: () => Promise<void> };
    const inner = raw.initialize;
    raw.initialize = async (...args: unknown[]) => {
      await (inner as (...a: unknown[]) => Promise<void>)(...args);
      raw.runtimeMode = 'polling';
    };
    const bridge = createChatSdkBridge({ adapter: stub.adapter, supportsThreads: false });
    await bridge.setup(makeHostConfig().hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Polling adapter: no webhook route registered', { adapter: 'telegram' });
    await bridge.teardown();
  });
});

// ---------------------------------------------------------------------------
// Inbound through the real Chat dispatch
// ---------------------------------------------------------------------------

describe('inbound dispatch paths', () => {
  it('subscribed threads forward every message with the SDK mention flag and isGroup', async () => {
    const { adapter, chat } = makeAdapter();
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:C1:T1');

    await chat().processMessage(adapter, 'slack:C1:T1', makeMessage('plain follow-up'));
    await chat().processMessage(adapter, 'slack:C1:T1', makeMessage('@bot again', { isMention: true }));

    expect(calls.map((c) => [c.platformId, c.threadId, c.message.isMention, c.message.isGroup])).toEqual([
      ['slack:C1', 'slack:C1:T1', false, true],
      ['slack:C1', 'slack:C1:T1', true, true],
    ]);
    expect(calls[0].message).toMatchObject({ kind: 'chat-sdk', timestamp: '2026-01-01T00:00:00.000Z' });
    await bridge.teardown();
  });

  it('a mention in an unsubscribed thread is forwarded with isMention=true', async () => {
    const { adapter, chat } = makeAdapter();
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    await chat().processMessage(adapter, 'slack:C2:T9', makeMessage('@bot hello', { isMention: true }));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ platformId: 'slack:C2', threadId: 'slack:C2:T9' });
    expect(calls[0].message.isMention).toBe(true);
    expect(calls[0].message.isGroup).toBe(true);
    await bridge.teardown();
  });

  it('DMs are always mentions, non-group, root-threaded on the message ts, and carry cached app context', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { adapter, chat } = makeAdapter({ isDM: (t) => t.startsWith('slack:D') });
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, instance: 'slack-pixel', supportsThreads: true });
    await bridge.setup(hostConfig);

    cacheAppContext('slack-pixel', 'D1', 'U123', [{ type: 'channel', id: 'C0DESIGN' }]);
    await chat().processMessage(adapter, 'slack:D1:', makeMessage('hi there', { id: '1724.001' }));
    // Author with only a userId — the log falls back to it; no cached context left.
    await chat().processMessage(
      adapter,
      'slack:D1:1724.001',
      makeMessage('reply', { author: { userId: 'U9', isMe: false } }),
    );
    // No author at all — 'unknown' sender, no sender projection, no app-context lookup.
    await chat().processMessage(adapter, 'slack:D1:', makeMessage('anon', { author: undefined, id: '1724.002' }));

    expect(calls.map((c) => [c.platformId, c.threadId, c.message.isMention, c.message.isGroup])).toEqual([
      ['slack:D1', 'slack:D1:1724.001', true, false],
      ['slack:D1', 'slack:D1:1724.001', true, false],
      ['slack:D1', 'slack:D1:1724.002', true, false],
    ]);
    const first = calls[0].message.content as Record<string, unknown>;
    expect(first.app_context).toEqual({ entities: [{ type: 'channel', id: 'C0DESIGN' }] });
    expect(first).toMatchObject({ senderId: 'U123', sender: 'A Human', senderName: 'A Human' });
    const second = calls[1].message.content as Record<string, unknown>;
    expect(second.app_context).toBeUndefined();
    expect(second).toMatchObject({ senderId: 'U9', sender: undefined, senderName: undefined });
    const third = calls[2].message.content as Record<string, unknown>;
    expect(third.senderId).toBeUndefined();
    expect(third.app_context).toBeUndefined();

    expect(
      info.mock.calls.filter((c) => c[0] === 'Inbound DM received').map((c) => (c[1] as { sender: string }).sender),
    ).toEqual(['A Human', 'U9', 'unknown']);
    await bridge.teardown();
  });

  it('projects userName when fullName is missing', async () => {
    const { adapter, chat } = makeAdapter();
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);
    await chat().processMessage(
      adapter,
      'slack:C3:T1',
      makeMessage('hey', { author: { userId: 'U5', userName: 'nick', isMe: false } }),
    );
    expect(calls[0].message.content).toMatchObject({ senderId: 'U5', sender: 'nick', senderName: 'nick' });
    await bridge.teardown();
  });

  it('downloads attachment data (base64), tolerates a failing fetch and entries without fetchData', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { adapter, chat } = makeAdapter();
    const { hostConfig, calls } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(hostConfig);

    const fetchErr = new Error('403');
    await chat().processMessage(
      adapter,
      'slack:C4:T1',
      makeMessage('files', {
        attachments: [
          {
            type: 'image',
            name: 'pic.png',
            mimeType: 'image/png',
            size: 3,
            width: 10,
            height: 20,
            fetchData: async () => Buffer.from('img'),
          },
          {
            type: 'file',
            name: 'doc.pdf',
            mimeType: 'application/pdf',
            size: 99,
            fetchData: async () => {
              throw fetchErr;
            },
          },
          { type: 'sticker', name: 'wave' },
        ],
      }),
    );

    const content = calls[0].message.content as { attachments: Array<Record<string, unknown>>; raw?: unknown };
    expect(content.attachments).toEqual([
      {
        type: 'image',
        name: 'pic.png',
        mimeType: 'image/png',
        size: 3,
        width: 10,
        height: 20,
        data: Buffer.from('img').toString('base64'),
      },
      { type: 'file', name: 'doc.pdf', mimeType: 'application/pdf', size: 99, width: undefined, height: undefined },
      { type: 'sticker', name: 'wave', mimeType: undefined, size: undefined, width: undefined, height: undefined },
    ]);
    expect(content.raw).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('Failed to download attachment', { type: 'file', err: fetchErr });
    await bridge.teardown();
  });

  it('extracts reply context via the platform hook only when raw is present and the hook finds a reply', async () => {
    const { adapter, chat } = makeAdapter();
    const { hostConfig, calls } = makeHostConfig();
    const seenRaw: unknown[] = [];
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: true,
      extractReplyContext: (raw) => {
        seenRaw.push(raw);
        const reply = raw.reply as { text: string; sender: string } | undefined;
        return reply ? { text: reply.text, sender: reply.sender } : null;
      },
    });
    await bridge.setup(hostConfig);

    await chat().processMessage(
      adapter,
      'slack:C5:T1',
      makeMessage('a', { raw: { reply: { text: 'orig', sender: 'Bob' } } }),
    );
    await chat().processMessage(adapter, 'slack:C5:T1', makeMessage('b', { raw: { nothing: true } }));
    await chat().processMessage(adapter, 'slack:C5:T1', makeMessage('c'));

    expect(seenRaw).toHaveLength(2);
    expect((calls[0].message.content as Record<string, unknown>).replyTo).toEqual({ text: 'orig', sender: 'Bob' });
    expect((calls[1].message.content as Record<string, unknown>).replyTo).toBeUndefined();
    expect((calls[2].message.content as Record<string, unknown>).replyTo).toBeUndefined();
    // raw is always stripped before the row is written.
    for (const c of calls) expect((c.message.content as Record<string, unknown>).raw).toBeUndefined();
    await bridge.teardown();
  });
});

// ---------------------------------------------------------------------------
// onAction (button clicks) through chat.processAction
// ---------------------------------------------------------------------------

describe('onAction', () => {
  async function fire(opts: StubOptions, event: { actionId: string; value?: string; user: Record<string, unknown> }) {
    const { adapter, calls } = makeAdapter(opts);
    const { hostConfig, actions } = makeHostConfig();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await bridge.setup(hostConfig);
    await chatOf(bridge).processAction(
      {
        actionId: event.actionId,
        adapter,
        messageId: 'msg-1',
        raw: {},
        threadId: 'T-1',
        user: event.user as never,
        value: event.value,
      },
      undefined,
    );
    await bridge.teardown();
    return { calls, actions };
  }

  it('ignores action ids that are not question buttons or are too short', async () => {
    const foreign = await fire({}, { actionId: 'callback:xyz', value: 'x', user: { userId: 'U1' } });
    expect(foreign.calls.edits).toEqual([]);
    expect(foreign.actions).toEqual([]);

    const short = await fire({}, { actionId: 'ncq:q-1', value: '0', user: { userId: 'U1' } });
    expect(short.calls.edits).toEqual([]);
    expect(short.actions).toEqual([]);
  });

  it('falls back to a plain markdown edit and a generic title when no render row exists', async () => {
    const { calls, actions } = await fire(
      {},
      { actionId: 'ncq:q-none:approve', value: undefined, user: { userId: 'U2', userName: 'ann' } },
    );
    expect(calls.edits).toEqual([
      { threadId: 'T-1', messageId: 'msg-1', message: { markdown: '❓ Question\n\napprove by ann' } },
    ]);
    expect(actions).toEqual(['q-none:approve:U2']);
  });

  it('an out-of-range index is passed through verbatim and an anonymous actor yields no byline', async () => {
    const { calls, actions } = await fire({}, { actionId: 'ncq:q-1:7', value: '7', user: {} });
    const edited = calls.edits[0].message as { card: { children: Array<{ content?: string }> } };
    expect(edited.card.children.at(-1)?.content).toBe('7');
    expect(actions).toEqual(['q-1:7:']);
  });

  it('a failing card edit is logged and the host still receives the action', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const boom = new Error('edit refused');
    const { actions } = await fire(
      { editThrows: boom },
      { actionId: 'ncq:q-1:1', value: '1', user: { userId: 'U3', fullName: 'Cy' } },
    );
    expect(warn).toHaveBeenCalledWith('Failed to update card after action', { err: boom });
    expect(actions).toEqual(['q-1:reject:U3']);
  });
});

// ---------------------------------------------------------------------------
// Gateway adapters (Discord-style): local webhook server + listener restarts
// ---------------------------------------------------------------------------

describe('gateway adapter', () => {
  it('starts the listener with the local webhook url and a 24h duration', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { adapter, gatewayStarts } = makeAdapter({ name: 'discord', gateway: true });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true, botToken: 'tok' });
    await bridge.setup(makeHostConfig().hostConfig);
    await tick();

    expect(gatewayStarts).toHaveLength(1);
    expect(gatewayStarts[0].webhookUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webhook$/);
    expect(gatewayStarts[0].durationMs).toBe(24 * 60 * 60 * 1000);
    expect(gatewayStarts[0].signal?.aborted).toBe(false);
    expect(info).toHaveBeenCalledWith('Gateway listener started', { adapter: 'discord' });
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    expect(vi.mocked(registerWebhookAdapter)).not.toHaveBeenCalledWith(expect.anything(), 'discord', expect.anything());

    await bridge.teardown();
    expect(gatewayStarts[0].signal?.aborted).toBe(true);
  });

  it('reschedules with exponential backoff, resets after a long healthy run, and stops once aborted', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const scheduled: Array<{ fn: () => void; delay: number }> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (typeof delay === 'number' && delay >= 1000) {
        scheduled.push({ fn, delay });
        return 0 as unknown as NodeJS.Timeout;
      }
      return (realSetTimeout as unknown as (...a: unknown[]) => NodeJS.Timeout)(fn, delay, ...rest);
    }) as typeof setTimeout);
    let offset = 0;
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);

    const { adapter, gatewayStarts } = makeAdapter({ name: 'discord', gateway: true });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: true });
    await bridge.setup(makeHostConfig().hostConfig);
    await tick();
    expect(gatewayStarts).toHaveLength(1);

    // 1) Listener expires normally (short run) → failure #1, 2s delay.
    gatewayStarts[0].resolveListener();
    await tick();
    expect(info).toHaveBeenCalledWith('Gateway listener expired, restarting', {
      adapter: 'discord',
      consecutiveFailures: 1,
      delayMs: 2000,
    });
    expect(scheduled.map((s) => s.delay)).toEqual([2000]);

    // 2) Restart fires; listener rejects → failure #2, 4s delay.
    scheduled[0].fn();
    await tick();
    expect(gatewayStarts).toHaveLength(2);
    const boom = new Error('TokenInvalid');
    gatewayStarts[1].rejectListener(boom);
    await tick();
    expect(error).toHaveBeenCalledWith('Gateway listener error, retrying', {
      adapter: 'discord',
      err: boom,
      consecutiveFailures: 2,
      delayMs: 4000,
    });
    expect(scheduled.map((s) => s.delay)).toEqual([2000, 4000]);

    // 3) Restart; this run lasts > 5 minutes → counter resets, 1s delay.
    scheduled[1].fn();
    await tick();
    expect(gatewayStarts).toHaveLength(3);
    offset = 6 * 60 * 1000;
    gatewayStarts[2].resolveListener();
    await tick();
    expect(info).toHaveBeenLastCalledWith('Gateway listener expired, restarting', {
      adapter: 'discord',
      consecutiveFailures: 0,
      delayMs: 1000,
    });
    expect(scheduled.map((s) => s.delay)).toEqual([2000, 4000, 1000]);

    // 4) Teardown aborts: a pending restart is a no-op.
    await bridge.teardown();
    scheduled[2].fn();
    await tick();
    expect(gatewayStarts).toHaveLength(3);
  });

  it('a listener settling after abort is not rescheduled; a start without waitUntil schedules nothing', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const scheduled: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay?: number, ...rest: unknown[]) => {
      if (typeof delay === 'number' && delay >= 1000) {
        scheduled.push(delay);
        return 0 as unknown as NodeJS.Timeout;
      }
      return (realSetTimeout as unknown as (...a: unknown[]) => NodeJS.Timeout)(fn, delay, ...rest);
    }) as typeof setTimeout);

    const late = makeAdapter({ name: 'discord', gateway: true });
    const lateBridge = createChatSdkBridge({ adapter: late.adapter, supportsThreads: true });
    await lateBridge.setup(makeHostConfig().hostConfig);
    await tick();
    await lateBridge.teardown();
    late.gatewayStarts[0].resolveListener();
    await tick();
    expect(scheduled).toEqual([]);
    expect(info).not.toHaveBeenCalledWith('Gateway listener expired, restarting', expect.anything());

    const silent = makeAdapter({ name: 'discord', gateway: true, gatewayNoWaitUntil: true });
    const silentBridge = createChatSdkBridge({ adapter: silent.adapter, supportsThreads: true });
    await silentBridge.setup(makeHostConfig().hostConfig);
    await tick();
    expect(silent.gatewayStarts).toHaveLength(1);
    expect(scheduled).toEqual([]);
    await silentBridge.teardown();
  });

  describe('forwarded events on the local webhook server', () => {
    async function gatewayBridge(opts: StubOptions & { botToken?: string } = {}) {
      const stub = makeAdapter({ name: 'discord', gateway: true, ...opts });
      const host = makeHostConfig();
      const bridge = createChatSdkBridge({ adapter: stub.adapter, supportsThreads: true, botToken: opts.botToken });
      await bridge.setup(host.hostConfig);
      await tick();
      const url = stub.gatewayStarts[0].webhookUrl!;
      // Explicit fields: both fakes expose a `calls` member with different shapes.
      return { adapter: stub.adapter, calls: stub.calls, actions: host.actions, bridge, url };
    }

    function interaction(data: Record<string, unknown>): string {
      return JSON.stringify({ type: 'GATEWAY_INTERACTION_CREATE', data });
    }

    it('answers 200 to unparseable bodies without touching the adapter', async () => {
      const g = await gatewayBridge();
      const res = await postJson(g.url, '{not json');
      expect(res).toEqual({ status: 200, body: '{"ok":true}' });
      expect(g.calls.webhooks).toEqual([]);
      await g.bridge.teardown();
    });

    it('resolves a button click through the render row, updates the message via the interaction callback, and dispatches onAction', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const g = await gatewayBridge({ botToken: 'tok' });

      const res = await postJson(
        g.url,
        interaction({
          type: 3,
          id: 'int-1',
          token: 'itok',
          data: { custom_id: 'ncq:q-1:0' },
          member: { user: { id: 'U1', username: 'glob', global_name: 'Glob Al' } },
          message: { embeds: [{ title: 'old title', description: 'original body' }] },
        }),
      );
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string; body: string }];
      expect(calledUrl).toBe('https://discord.com/api/v10/interactions/int-1/itok/callback');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({
        type: 7,
        data: {
          embeds: [
            { title: 'Approval needed', description: 'original body', footer: { text: '✅ Approved by Glob Al' } },
          ],
          components: [],
        },
      });
      expect(g.actions).toEqual(['q-1:approve:U1']);
      expect(g.calls.webhooks).toEqual([]);
      await g.bridge.teardown();
    });

    it('falls back to the embed title / question and DM-style user when no render row exists', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const g = await gatewayBridge();

      await postJson(
        g.url,
        interaction({
          type: 3,
          id: 'int-2',
          token: 'itok2',
          data: { custom_id: 'ncq:q-none:yes:please' },
          user: { username: 'uname' }, // no id — dispatched with an empty userId
          message: { embeds: [] },
        }),
      );
      const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
      expect(body.data.embeds).toEqual([
        { title: '❓ Question', description: '', footer: { text: 'yes:please by uname' } },
      ]);
      expect(g.actions).toEqual(['q-none:yes:please:']);
      await g.bridge.teardown();
    });

    it('a custom_id without a question separator, no user and a failing callback still answers 200 and dispatches nothing', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      const boom = new Error('discord down');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw boom;
        }),
      );
      const g = await gatewayBridge();

      const res = await postJson(
        g.url,
        interaction({ type: 3, id: 'int-3', token: 't3', data: { custom_id: 'ncq:nocolon' } }),
      );
      expect(res.status).toBe(200);
      expect(error).toHaveBeenCalledWith('Failed to update interaction', { err: boom });
      expect(g.actions).toEqual([]);

      // No `data` block at all — custom_id undefined.
      const res2 = await postJson(g.url, interaction({ type: 3, id: 'int-4', token: 't4' }));
      expect(res2.status).toBe(200);
      expect(g.actions).toEqual([]);
      await g.bridge.teardown();
    });

    it('forwards non-component interactions and other gateway events to adapter.handleWebhook with the bot token', async () => {
      const g = await gatewayBridge({ botToken: 'secret-token' });
      await postJson(g.url, interaction({ type: 2, id: 'slash' }));
      await postJson(g.url, JSON.stringify({ type: 'GATEWAY_MESSAGE_CREATE', data: { content: 'hi' } }));
      await postJson(g.url, JSON.stringify({ type: 'GATEWAY_INTERACTION_CREATE', data: null }));
      expect(g.calls.webhooks).toHaveLength(3);
      for (const w of g.calls.webhooks) {
        expect(w.headers['x-discord-gateway-token']).toBe('secret-token');
        expect(w.headers['content-type']).toBe('application/json');
      }
      expect(JSON.parse(g.calls.webhooks[1].body)).toEqual({ type: 'GATEWAY_MESSAGE_CREATE', data: { content: 'hi' } });
      expect(g.actions).toEqual([]);
      await g.bridge.teardown();
    });

    it('sends an empty token header when no botToken is configured and answers 500 when the adapter throws', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => {});
      const boom = new Error('bad signature');
      const g = await gatewayBridge({ webhookThrows: boom });
      const res = await postJson(g.url, JSON.stringify({ type: 'GATEWAY_GUILD_CREATE', data: {} }));
      expect(res).toEqual({ status: 500, body: '{"error":"internal"}' });
      expect(g.calls.webhooks[0].headers['x-discord-gateway-token']).toBe('');
      expect(error).toHaveBeenCalledWith('Webhook server error', { err: boom });
      await g.bridge.teardown();
    });
  });
});

// ---------------------------------------------------------------------------
// deliver()
// ---------------------------------------------------------------------------

describe('deliver', () => {
  it('edit without a complete terminalCard rewrites markdown from text, then markdown, then empty', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({
      adapter,
      supportsThreads: false,
      transformOutboundText: (t) => t.toUpperCase(),
    });
    await bridge.deliver('slack:C1', 'slack:C1:T1', {
      kind: 'chat-sdk',
      content: { operation: 'edit', messageId: 'm1', text: 'from text', terminalCard: { title: 'only title' } },
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { operation: 'edit', messageId: 'm2', markdown: 'from markdown' },
    });
    await bridge.deliver('slack:C1', null, { kind: 'chat-sdk', content: { operation: 'edit', messageId: 'm3' } });
    expect(calls.edits).toEqual([
      { threadId: 'slack:C1:T1', messageId: 'm1', message: { markdown: 'FROM TEXT' } },
      { threadId: 'slack:C1', messageId: 'm2', message: { markdown: 'FROM MARKDOWN' } },
      { threadId: 'slack:C1', messageId: 'm3', message: { markdown: '' } },
    ]);
    expect(calls.posts).toEqual([]);
  });

  it('edit with a complete terminalCard renders the muted-resolution card instead of markdown', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'm9',
        text: 'ignored',
        terminalCard: { title: 'Req', question: 'Do it?', resolution: '✅ Approved by ann' },
      },
    });
    expect(calls.edits).toHaveLength(1);
    const edited = calls.edits[0].message as {
      fallbackText: string;
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.fallbackText).toBe('Req\n\nDo it?\n\n✅ Approved by ann');
    expect(edited.card.title).toBe('Req');
    expect(edited.card.children).toEqual([
      { type: 'text', content: 'Do it?' },
      { type: 'text', content: '✅ Approved by ann', style: 'muted' },
    ]);
  });

  it('display cards: children-only card has empty fallback text; label-only actions add no row; empty card is skipped', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: { children: ['body only'], actions: [{ label: 'no url' }] } },
    });
    expect(id).toBe('post-1');
    const msg = calls.posts[0].message as {
      fallbackText: string;
      card: { title: string; children: Array<{ type: string }> };
    };
    expect(msg.fallbackText).toBe('');
    expect(msg.card.title).toBe('');
    expect(msg.card.children.map((c) => c.type)).toEqual(['text']);

    const skipped = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: { actions: [{ label: 'x' }], children: [{ nope: true }] } },
    });
    expect(skipped).toBeUndefined();
    expect(calls.posts).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith('send_card payload empty, skipping delivery');
  });

  it('openDM is exposed only when the adapter has one and maps the thread id to a platform id', async () => {
    const without = createChatSdkBridge({ adapter: makeAdapter().adapter, supportsThreads: false });
    expect(without.openDM).toBeUndefined();

    const stub = makeAdapter();
    (stub.adapter as unknown as { openDM: (u: string) => Promise<string> }).openDM = async (u) => `slack:D-${u}:`;
    const withDm = createChatSdkBridge({ adapter: stub.adapter, supportsThreads: false });
    await expect(withDm.openDM!('U42')).resolves.toBe('slack:D-U42');
  });

  it('reaction ops add a reaction; a reaction without emoji falls through and delivers nothing', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { operation: 'reaction', messageId: 'm1', emoji: '👍' },
    });
    expect(id).toBeUndefined();
    expect(calls.reactions).toEqual([{ threadId: 'slack:C1', messageId: 'm1', emoji: '👍' }]);

    const none = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { operation: 'reaction', messageId: 'm1' },
    });
    expect(none).toBeUndefined();
    expect(calls.reactions).toHaveLength(1);
    expect(calls.posts).toEqual([]);
  });

  it('ask_question without a title is refused with an error log', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'q-9', question: 'Why?', options: ['a'] },
    });
    expect(id).toBeUndefined();
    expect(calls.posts).toEqual([]);
    expect(error).toHaveBeenCalledWith('ask_question missing required title — skipping delivery', {
      questionId: 'q-9',
    });
  });

  it('ask_question encodes buttons by option index and returns the posted id', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-9',
        title: 'Pick',
        question: 'Which?',
        options: ['alpha', { label: 'Beta', value: 'b-value' }],
      },
    });
    expect(id).toBe('post-1');
    const msg = calls.posts[0].message as {
      fallbackText: string;
      card: {
        title: string;
        children: Array<{ type: string; children?: Array<{ id: string; value: string; label: string }> }>;
      };
    };
    expect(msg.fallbackText).toBe('Pick\n\nWhich?\nOptions: alpha, Beta');
    expect(msg.card.title).toBe('Pick');
    const buttons = msg.card.children.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons.map((b) => [b.id, b.value, b.label])).toEqual([
      ['ncq:q-9:0', '0', 'alpha'],
      ['ncq:q-9:1', '1', 'Beta'],
    ]);
  });

  it('display cards accept object children with text, validate link-button styles, and derive fallback text', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Links',
          description: 'desc',
          children: ['plain', { text: 'from object' }, { notText: 1 }, 42, '', null],
          actions: [
            { label: 'Primary', url: 'https://a', style: 'primary' },
            { label: 'Danger', url: 'https://b', style: 'danger' },
            { label: 'Default', url: 'https://c', style: 'default' },
            { label: 'Weird', url: 'https://d', style: 'rainbow' },
            { label: '', url: 'https://e' },
            { label: 'No url' },
          ],
        },
      },
    });
    expect(id).toBe('post-1');
    const msg = calls.posts[0].message as {
      fallbackText: string;
      card: {
        children: Array<{
          type: string;
          content?: string;
          children?: Array<{ label: string; url: string; style?: string }>;
        }>;
      };
    };
    expect(msg.fallbackText).toBe('desc');
    const texts = msg.card.children.filter((c) => c.type === 'text').map((c) => c.content);
    expect(texts).toEqual(['desc', 'plain', 'from object']);
    const buttons = msg.card.children.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons.map((b) => [b.label, b.url, b.style])).toEqual([
      ['Primary', 'https://a', 'primary'],
      ['Danger', 'https://b', 'danger'],
      ['Default', 'https://c', 'default'],
      ['Weird', 'https://d', undefined],
    ]);

    // Title-only card: fallback text degrades to the title.
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: { title: 'Just a title' } },
    });
    expect((calls.posts[1].message as { fallbackText: string }).fallbackText).toBe('Just a title');
  });

  it('text with files attaches the files to the first chunk only and returns the head id', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false, maxTextLength: 12 });
    const files = [{ data: Buffer.from('abc'), filename: 'a.txt' }];
    const id = await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: { text: 'first line\n\nsecond line\n\nthird' },
      files,
    });
    expect(id).toBe('post-1');
    expect(calls.posts.map((p) => p.message)).toEqual([
      { markdown: 'first line', files: [{ data: Buffer.from('abc'), filename: 'a.txt' }] },
      { markdown: 'second line' },
      { markdown: 'third' },
    ]);
  });

  it('text under the limit is a single post; without files no files key is sent; missing ids propagate', async () => {
    const { adapter, calls } = makeAdapter({ postReturnsUndefined: true });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false, maxTextLength: 100 });
    const id = await bridge.deliver('slack:C1', null, { kind: 'chat-sdk', content: { text: 'short' }, files: [] });
    expect(id).toBeUndefined();
    expect(calls.posts.map((p) => p.message)).toEqual([{ markdown: 'short' }]);
  });

  it('files without text post an empty markdown with the uploads; nothing at all delivers nothing', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const id = await bridge.deliver('slack:C1', 'slack:C1:T2', {
      kind: 'chat-sdk',
      content: {},
      files: [{ data: Buffer.from('x'), filename: 'x.bin' }],
    });
    expect(id).toBe('post-1');
    expect(calls.posts).toEqual([
      { threadId: 'slack:C1:T2', message: { markdown: '', files: [{ data: Buffer.from('x'), filename: 'x.bin' }] } },
    ]);

    const nothing = await bridge.deliver('slack:C1', null, { kind: 'chat-sdk', content: {} });
    expect(nothing).toBeUndefined();
    expect(calls.posts).toHaveLength(1);
  });

  it('setTyping targets the thread when given, else the channel; isConnected is always true', async () => {
    const { adapter, calls } = makeAdapter();
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await bridge.setTyping!('slack:C1', 'slack:C1:T1');
    await bridge.setTyping!('slack:C1', null);
    expect(calls.typing).toEqual(['slack:C1:T1', 'slack:C1']);
    expect(bridge.isConnected()).toBe(true);
  });
});

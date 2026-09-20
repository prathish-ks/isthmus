/**
 * Coverage tests for the unknown-channel registration request flow, driving
 * requestChannelApproval directly (no router) against an in-memory central
 * DB: the approver/DM/adapter failure modes, delivery throw, channel-name
 * resolution through a live adapter, the multi-agent "choose existing" card,
 * the engage-rule preview variants (mention / pattern / unresolvable), the
 * sender-name fallbacks, the interceptor overwrite warning, and
 * createNewAgentGroup's folder fallback/dedupe.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelDefaults, InboundEvent } from '../../channels/adapter.js';

const state = vi.hoisted(() => {
  const base = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  return {
    root: `${base}/nanoclaw-cov-channel-approval`,
    adapter: null as null | { deliver: ReturnType<typeof vi.fn> },
    dmOverride: null as null | ((userId: string) => Promise<unknown>),
    resolveChannelName: null as null | ((platformId: string) => Promise<string | null>),
  };
});

vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => state.adapter,
}));
vi.mock('./user-dm.js', () => ({
  ensureUserDm: async (userId: string) => {
    if (state.dmOverride) return state.dmOverride(userId);
    const { getDb } = await import('../../db/connection.js');
    return getDb().get(
      `SELECT mg.* FROM messaging_groups mg JOIN user_dms ud ON ud.messaging_group_id = mg.id WHERE ud.user_id = ?`,
      userId,
    );
  },
}));
vi.mock('../../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: state.root, GROUPS_DIR: `${state.root}/groups` };
});

import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import {
  buildAgentSelectionOptions,
  createNewAgentGroup,
  registerChannelCardInterceptor,
  requestChannelApproval,
} from './channel-approval.js';
import { getPendingChannelApproval } from './db/pending-channel-approvals.js';
import { grantRole } from './db/user-roles.js';
import { upsertUser } from './db/users.js';

const stickyDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('covtg', { factory: () => null, defaults: stickyDefaults });
registerChannelAdapter('covmention', {
  factory: () => null,
  defaults: {
    dm: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
    group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
    mentions: 'platform',
  },
});
registerChannelAdapter('covpat', {
  factory: () => null,
  defaults: {
    dm: { engageMode: 'pattern', engagePattern: 'hey {name}', threads: false, unknownSenderPolicy: 'request_approval' },
    group: {
      engageMode: 'pattern',
      engagePattern: 'hey {name}',
      threads: false,
      unknownSenderPolicy: 'request_approval',
    },
    mentions: 'platform',
  },
});
registerChannelAdapter('badpat', {
  factory: () => null,
  defaults: {
    dm: { engageMode: 'pattern', threads: false, unknownSenderPolicy: 'request_approval' },
    group: { engageMode: 'pattern', threads: false, unknownSenderPolicy: 'request_approval' },
    mentions: 'platform',
  } as ChannelDefaults,
});
// A live adapter whose resolveChannelName is controlled per test.
const liveAdapter: ChannelAdapter = {
  name: 'covlive',
  channelType: 'covlive',
  supportsThreads: false,
  async setup() {},
  async teardown() {},
  isConnected: () => true,
  async deliver() {
    return undefined;
  },
  async setTyping() {},
  resolveChannelName: (platformId: string) =>
    state.resolveChannelName ? state.resolveChannelName(platformId) : Promise.resolve(null),
};
registerChannelAdapter('covlive', { factory: () => liveAdapter, defaults: stickyDefaults });

function now(): string {
  return new Date().toISOString();
}

function mention(
  channelType: string,
  platformId: string,
  content: string | Record<string, unknown>,
  isGroup?: boolean,
): InboundEvent {
  return {
    channelType,
    platformId,
    threadId: null,
    message: {
      id: `msg-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: now(),
      isMention: true,
      ...(isGroup === undefined ? {} : { isGroup }),
      content: typeof content === 'string' ? content : JSON.stringify(content),
    },
  };
}

async function unwired(id: string, channelType: string, isGroup = 1, name: string | null = null): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: `chan-${id}`,
    name,
    is_group: isGroup,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
}

function lastCard(): { title: string; question: string; options: Array<{ value: string; label: string }> } {
  const calls = state.adapter!.deliver.mock.calls;
  return JSON.parse(calls[calls.length - 1][4] as string);
}

beforeEach(async () => {
  fs.rmSync(state.root, { recursive: true, force: true });
  fs.mkdirSync(state.root, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  state.adapter = { deliver: vi.fn().mockResolvedValue('plat-id') };
  state.dmOverride = null;
  state.resolveChannelName = null;
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));

  await createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  await upsertUser({ id: 'covtg:owner', kind: 'covtg', display_name: 'Owner', created_at: now() });
  await grantRole({ user_id: 'covtg:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'covtg',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run(
    'INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)',
    'covtg:owner',
    'covtg',
    'mg-dm-owner',
    now(),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('requestChannelApproval — failure modes', () => {
  it('skips when no approver has a reachable DM', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await unwired('mg-a', 'covtg');
    state.dmOverride = async () => null;
    await requestChannelApproval({
      messagingGroupId: 'mg-a',
      event: mention('covtg', 'chan-mg-a', { senderId: 'c' }, true),
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Channel registration skipped — no DM channel for any approver',
      expect.objectContaining({ messagingGroupId: 'mg-a', targetAgentGroupId: 'ag-1' }),
    );
    expect(await getPendingChannelApproval('mg-a')).toBeUndefined();
    expect(state.adapter!.deliver).not.toHaveBeenCalled();
  });

  it('records the row but logs when no delivery adapter is wired', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await unwired('mg-b', 'covtg');
    state.adapter = null;
    await requestChannelApproval({
      messagingGroupId: 'mg-b',
      event: mention('covtg', 'chan-mg-b', { senderId: 'c' }, true),
    });
    expect(errSpy).toHaveBeenCalledWith('Channel registration row created but no delivery adapter is wired', {
      messagingGroupId: 'mg-b',
    });
    expect(await getPendingChannelApproval('mg-b')).toBeDefined();
  });

  it('logs a card delivery failure and keeps the row', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await unwired('mg-c', 'covtg');
    state.adapter = { deliver: vi.fn().mockRejectedValue(new Error('offline')) };
    await requestChannelApproval({
      messagingGroupId: 'mg-c',
      event: mention('covtg', 'chan-mg-c', { senderId: 'c' }, true),
    });
    expect(errSpy).toHaveBeenCalledWith(
      'Channel registration card delivery failed',
      expect.objectContaining({ messagingGroupId: 'mg-c' }),
    );
    expect(await getPendingChannelApproval('mg-c')).toBeDefined();
  });

  it('an unknown messaging group id skips the interceptor and name lookup, then fails on the pending-row FK', async () => {
    // Registered for the whole file: returns 'card', so later covtg tests still card.
    const interceptor = vi.fn().mockResolvedValue('card');
    registerChannelCardInterceptor('covtg', interceptor);
    await expect(
      requestChannelApproval({
        messagingGroupId: 'mg-ghost',
        event: mention('covtg', 'nowhere', { senderId: 'c' }, true),
      }),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(interceptor).not.toHaveBeenCalled();
    expect(state.adapter!.deliver).not.toHaveBeenCalled();
  });

  it('warns when a channel-card interceptor is overwritten', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    registerChannelCardInterceptor('covoverwrite', vi.fn());
    registerChannelCardInterceptor('covoverwrite', vi.fn());
    expect(warnSpy).toHaveBeenCalledWith('Channel-card interceptor overwritten', { channelType: 'covoverwrite' });
  });
});

describe('requestChannelApproval — card content', () => {
  it('offers "Choose existing agent" when the approver can see several agent groups', async () => {
    await createAgentGroup({ id: 'ag-2', name: 'Betty', folder: 'betty', agent_provider: null, created_at: now() });
    await unwired('mg-multi', 'covtg');
    await requestChannelApproval({
      messagingGroupId: 'mg-multi',
      event: mention('covtg', 'chan-mg-multi', { senderId: 'c' }, true),
    });
    const card = lastCard();
    expect(card.options.map((o) => o.value)).toEqual(['choose_existing', 'new_agent', 'reject']);
    expect(card.title).toBe('📣 Bot mentioned in new channel');
  });

  it('buildAgentSelectionOptions without an approver lists every agent group', async () => {
    await createAgentGroup({ id: 'ag-2', name: 'Betty', folder: 'betty', agent_provider: null, created_at: now() });
    const groups = await getDb().all<{
      id: string;
      name: string;
      folder: string;
      agent_provider: null;
      created_at: string;
    }>('SELECT * FROM agent_groups ORDER BY created_at');
    const options = await buildAgentSelectionOptions(groups, null);
    expect(options.map((o) => o.value)).toEqual(['connect:ag-1', 'connect:ag-2', 'reject']);
    expect(options[0].label).toBe('Andy');
  });

  it('resolves and persists the channel name through the live adapter; failures and nulls are non-fatal', async () => {
    await upsertUser({ id: 'covlive:owner2', kind: 'covlive', display_name: 'O2', created_at: now() });
    await grantRole({
      user_id: 'covlive:owner2',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-dm-owner2',
      channel_type: 'covlive',
      platform_id: 'dm-owner2',
      name: 'O2 DM',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await getDb().run(
      'INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)',
      'covlive:owner2',
      'covlive',
      'mg-dm-owner2',
      now(),
    );

    // (a) name resolved → persisted and used in the question
    await unwired('mg-live-a', 'covlive');
    state.resolveChannelName = async (platformId) => `#${platformId}`;
    await requestChannelApproval({
      messagingGroupId: 'mg-live-a',
      event: mention('covlive', 'chan-mg-live-a', { senderName: 'Sam' }, true),
    });
    expect((await getMessagingGroup('mg-live-a'))?.name).toBe('#chan-mg-live-a');
    expect(lastCard().question).toContain('Sam mentioned your bot in #chan-mg-live-a on covlive.');
    // Same-channel owner preferred for delivery.
    expect(state.adapter!.deliver.mock.calls.at(-1)![1]).toBe('dm-owner2');

    // (b) resolver returns null → name stays null, generic copy
    await unwired('mg-live-b', 'covlive');
    state.resolveChannelName = async () => null;
    await requestChannelApproval({
      messagingGroupId: 'mg-live-b',
      event: mention('covlive', 'chan-mg-live-b', { sender: 'Legacy' }, true),
    });
    expect((await getMessagingGroup('mg-live-b'))?.name).toBeNull();
    expect(lastCard().question).toContain('Legacy mentioned your bot in a covlive channel.');

    // (c) resolver throws → ignored
    await unwired('mg-live-c', 'covlive');
    state.resolveChannelName = async () => {
      throw new Error('api down');
    };
    await requestChannelApproval({
      messagingGroupId: 'mg-live-c',
      event: mention('covlive', 'chan-mg-live-c', 'not json', true),
    });
    expect((await getMessagingGroup('mg-live-c'))?.name).toBeNull();
    expect(lastCard().question).toContain('Someone mentioned your bot in a covlive channel.');

    // (d) a persisted name is never re-resolved
    const resolver = vi.fn().mockResolvedValue('ignored');
    state.resolveChannelName = resolver;
    await unwired('mg-live-d', 'covlive', 1, 'Known Room');
    await requestChannelApproval({
      messagingGroupId: 'mg-live-d',
      event: mention('covlive', 'chan-mg-live-d', { senderId: 'c' }, true),
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(lastCard().question).toContain('Known Room on covlive');
  });

  it('previews the engage rule: mention DMs, custom patterns with {name}, and no note when unresolvable', async () => {
    await unwired('mg-mention', 'covmention', 0);
    await requestChannelApproval({
      messagingGroupId: 'mg-mention',
      event: mention('covmention', 'chan-mg-mention', { senderId: 'c' }, false),
    });
    expect(lastCard().title).toBe('💬 New direct message');
    expect(lastCard().question).toContain('If connected, the agent will respond to @-mentions.');

    await unwired('mg-pat', 'covpat', 1);
    await requestChannelApproval({
      messagingGroupId: 'mg-pat',
      event: mention('covpat', 'chan-mg-pat', { senderId: 'c' }, true),
    });
    expect(lastCard().question).toContain('will respond to messages matching hey Andy.');

    await unwired('mg-bad', 'badpat', 1);
    await requestChannelApproval({
      messagingGroupId: 'mg-bad',
      event: mention('badpat', 'chan-mg-bad', { senderId: 'c' }, true),
    });
    expect(lastCard().question).not.toContain('If connected');
    expect(await getPendingChannelApproval('mg-bad')).toBeDefined();
  });

  it('derives group-ness from the persisted row when the event carries no isGroup flag', async () => {
    await unwired('mg-flagless', 'covtg', 0);
    await requestChannelApproval({
      messagingGroupId: 'mg-flagless',
      event: mention('covtg', 'chan-mg-flagless', { senderId: 'c' }),
    });
    expect(lastCard().title).toBe('💬 New direct message');
    expect(lastCard().question).toContain(
      'sent your bot a DM on covtg. If connected, the agent will respond to all messages.',
    );
  });
});

describe('createNewAgentGroup', () => {
  it('falls back to the "unnamed" folder and dedupes against existing DB rows', async () => {
    const first = await createNewAgentGroup('!!!');
    expect(first.folder).toBe('unnamed');
    expect(first.name).toBe('!!!');
    const second = await createNewAgentGroup('???');
    expect(second.folder).toBe('unnamed-2');
    expect(fs.existsSync(`${state.root}/groups/unnamed-2`)).toBe(true);
  });
});

/**
 * Coverage-uplift tests for router.ts targeting branches the pre-existing
 * router-session-created.test.ts / router-unknown-engage-mode.test.ts suites
 * don't reach: hook-overwrite warnings, auto-created messaging groups,
 * denied-channel / no-agent-wired drops, dangling wiring agent groups,
 * mention-sticky subscribe, evaluateEngage's pattern/mention-sticky
 * branches, and the command-gate filter/deny paths.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { setMessagingGroupDeniedAt } from './db/messaging-groups.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import {
  routeInbound,
  setAccessGate,
  setChannelRequestGate,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateFn,
  type ChannelRequestGateFn,
  type SenderResolverFn,
  type SenderScopeGateFn,
} from './router.js';
import { log } from './log.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import type { MessagingGroupAgent } from './types.js';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-cov' };
});

const TEST_DIR = '/tmp/nanoclaw-test-router-cov';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

let subscribeSpy = vi.fn().mockResolvedValue(undefined);

function makeAdapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
    subscribe: subscribeSpy,
  };
}

async function activate(): Promise<void> {
  registerChannelAdapter('testchat', { factory: () => makeAdapter(), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedAgentGroup(id = 'ag-1'): Promise<void> {
  await createAgentGroup({ id, name: 'Test Agent', folder: `folder-${id}`, agent_provider: null, created_at: now() });
}

async function seedMessagingGroup(overrides: Partial<Parameters<typeof createMessagingGroup>[0]> = {}): Promise<void> {
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
    ...overrides,
  } as Parameters<typeof createMessagingGroup>[0]);
}

async function seedWiring(options: {
  id?: string;
  agentGroupId?: string;
  isGroup?: 0 | 1;
  engageMode?: MessagingGroupAgent['engage_mode'];
  engagePattern?: string | null;
  sessionMode?: 'shared' | 'per-thread';
  ignoredMessagePolicy?: 'drop' | 'accumulate';
  threads?: 0 | 1;
}): Promise<void> {
  await createMessagingGroupAgent({
    id: options.id ?? 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: options.agentGroupId ?? 'ag-1',
    engage_mode: options.engageMode ?? 'pattern',
    engage_pattern: options.engagePattern === undefined ? '.' : options.engagePattern,
    sender_scope: 'all',
    ignored_message_policy: options.ignoredMessagePolicy ?? 'drop',
    session_mode: options.sessionMode ?? 'per-thread',
    priority: 0,
    threads: options.threads ?? 1,
    created_at: now(),
  });
}

async function inbound(
  id: string,
  threadId: string | null,
  text: string,
  isMention = true,
  isGroup = false,
): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text }),
      timestamp: now(),
      isMention,
      isGroup,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  subscribeSpy = vi.fn().mockResolvedValue(undefined);
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  vi.restoreAllMocks();
  // Router hooks are process-global singletons with an overwrite guard; there
  // is no public reset, so each test that registers one uses a distinct
  // agent/messaging group to avoid semantic bleed across tests. We only
  // exercise the *overwrite* warning explicitly where needed.
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// NOTE: router.ts's module-level hooks (senderResolver, accessGate,
// senderScopeGate, channelRequestGate) have no reset function and persist
// across tests within this file. The "no gate registered" case below MUST
// run before anything registers a channelRequestGate, so it's declared
// first; the overwrite-warning test (which registers every hook) is last.
describe('messaging group auto-create and drop paths — no gate registered', () => {
  it('warns loudly when no agent is wired and no channel-request gate is registered', async () => {
    await activate();
    await seedMessagingGroup({ id: 'mg-3', platform_id: 'testchat:C3' } as never);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:C3',
      threadId: null,
      message: {
        id: 'm-nowired-nogate2',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'hi' }),
        timestamp: now(),
        isMention: true,
        isGroup: false,
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'MESSAGE DROPPED — no agent groups wired and no channel-request gate registered',
      expect.objectContaining({ messagingGroupId: 'mg-3' }),
    );
  });
});

describe('messaging group auto-create and drop paths', () => {
  it('auto-creates a messaging group on a mention when none exists, and no-ops on plain chatter', async () => {
    await activate();
    // No messaging group pre-seeded — first mention auto-creates one.
    await inbound('m-auto', null, 'hello', true);
    const { getMessagingGroupWithAgentCount } = await import('./db/messaging-groups.js');
    const found = await getMessagingGroupWithAgentCount('testchat', 'testchat:C1', 'testchat');
    expect(found?.mg.channel_type).toBe('testchat');

    // Plain chatter (not a mention) on a still-unwired channel: silently returns.
    await inbound('m-plain', null, 'just chatting', false);
  });

  it('throws if the messaging group row disappears immediately after the auto-create insert', async () => {
    await activate();
    const mgModule = await import('./db/messaging-groups.js');
    const realFn = mgModule.getMessagingGroupWithAgentCount;
    let call = 0;
    const spy = vi.spyOn(mgModule, 'getMessagingGroupWithAgentCount').mockImplementation(async (...args) => {
      call++;
      if (call === 2) return null;
      return realFn(...args);
    });
    await expect(inbound('m-vanish', null, 'hello', true)).rejects.toThrow(
      'Messaging group disappeared after first-message insert',
    );
    spy.mockRestore();
  });

  it('drops silently when the channel was previously denied by the owner', async () => {
    await activate();
    await seedMessagingGroup();
    await setMessagingGroupDeniedAt('mg-1', now());
    const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
    await inbound('m-denied', null, 'hello', true);
    expect(debugSpy).toHaveBeenCalledWith(
      'Message dropped — channel was denied by owner',
      expect.objectContaining({ messagingGroupId: 'mg-1' }),
    );
  });

  it('records a dropped_messages row and fires the channel-request gate when no agent is wired', async () => {
    await activate();
    await seedMessagingGroup();
    const gate = vi.fn().mockResolvedValue(undefined);
    setChannelRequestGate(gate);
    await inbound('m-nowired', null, 'hello', true);
    expect(gate).toHaveBeenCalled();
  });

  it('logs and swallows when the channel-request gate rejects', async () => {
    await activate();
    await seedMessagingGroup({ id: 'mg-2', platform_id: 'testchat:C2' } as never);
    const err = new Error('gate exploded');
    setChannelRequestGate(vi.fn().mockRejectedValue(err));
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:C2',
      threadId: null,
      message: {
        id: 'm-gate-throws',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'hi' }),
        timestamp: now(),
        isMention: true,
        isGroup: false,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errSpy).toHaveBeenCalledWith(
      'Channel-request gate threw',
      expect.objectContaining({ messagingGroupId: 'mg-2', err }),
    );
  });
});

describe('per-wiring dispatch edge cases', () => {
  it('skips a wiring whose agent group no longer exists', async () => {
    await activate();
    await seedAgentGroup();
    await seedMessagingGroup();
    await seedWiring({});
    // Simulate the agent group having been deleted between the wiring read
    // and the per-wiring dispatch loop (getAgentGroup returns undefined).
    const agentGroupsModule = await import('./db/agent-groups.js');
    const spy = vi.spyOn(agentGroupsModule, 'getAgentGroup').mockResolvedValueOnce(undefined);
    await expect(inbound('m-dangling', null, 'hello', true)).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('subscribes the thread once for a mention-sticky group wiring with threads enabled', async () => {
    await activate();
    await seedAgentGroup();
    await seedMessagingGroup({ is_group: 1 } as never);
    await seedWiring({ engageMode: 'mention-sticky', sessionMode: 'shared', threads: 1 });
    await inbound('m-sticky', 'testchat:C1:thread1', 'hey there', true, true);
    expect(subscribeSpy).toHaveBeenCalledWith('testchat:C1', 'testchat:C1:thread1');
  });

  it('accumulates a non-engaging message when ignored_message_policy is accumulate', async () => {
    await activate();
    await seedAgentGroup();
    await seedMessagingGroup();
    await seedWiring({ engageMode: 'mention', ignoredMessagePolicy: 'accumulate' });
    // Not a mention → doesn't engage → accumulate branch (not the drop-log branch).
    await expect(inbound('m-accum', null, 'quiet', false)).resolves.toBeUndefined();
  });

  it('logs a debug drop when a wiring neither engages nor accumulates', async () => {
    await activate();
    await seedAgentGroup();
    await seedMessagingGroup();
    await seedWiring({ engageMode: 'mention', ignoredMessagePolicy: 'drop' });
    const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
    await inbound('m-drop', null, 'quiet', false);
    expect(debugSpy).toHaveBeenCalledWith(
      'Message not engaged for agent (drop policy)',
      expect.objectContaining({ engages: false }),
    );
  });

  it('evaluateEngage pattern mode: matches, fails to match, and fails open on a bad regex', async () => {
    await activate();
    await seedAgentGroup('ag-pat');
    await seedMessagingGroup({ id: 'mg-pat', platform_id: 'testchat:PAT' } as never);
    await createMessagingGroupAgent({
      id: 'mga-pat',
      messaging_group_id: 'mg-pat',
      agent_group_id: 'ag-pat',
      engage_mode: 'pattern',
      engage_pattern: 'hello',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    // No match — accumulate/drop path, no throw.
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:PAT',
      threadId: null,
      message: {
        id: 'm-pat-1',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'nope' }),
        timestamp: now(),
        isMention: false,
        isGroup: false,
      },
    });
    // Match.
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:PAT',
      threadId: null,
      message: {
        id: 'm-pat-2',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'hello world' }),
        timestamp: now(),
        isMention: false,
        isGroup: false,
      },
    });
  });

  it('evaluateEngage pattern mode fails open on an invalid regex', async () => {
    await activate();
    await seedAgentGroup('ag-badregex');
    await seedMessagingGroup({ id: 'mg-badregex', platform_id: 'testchat:BADRE' } as never);
    await createMessagingGroupAgent({
      id: 'mga-badregex',
      messaging_group_id: 'mg-badregex',
      agent_group_id: 'ag-badregex',
      engage_mode: 'pattern',
      engage_pattern: '(unterminated[',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    // Fails open (treated as engaged) — should route without throwing.
    await expect(
      routeInbound({
        channelType: 'testchat',
        platformId: 'testchat:BADRE',
        threadId: null,
        message: {
          id: 'm-badre-1',
          kind: 'chat-sdk',
          content: JSON.stringify({ text: 'anything' }),
          timestamp: now(),
          isMention: false,
          isGroup: false,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('evaluateEngage mention-sticky: DM never engages via sticky, group engages once a session exists', async () => {
    await activate();
    await seedAgentGroup('ag-sticky');
    // DM (is_group=0): mention-sticky should never fire without an explicit mention.
    await seedMessagingGroup({ id: 'mg-dm-sticky', platform_id: 'testchat:DMSTICKY', is_group: 0 } as never);
    await createMessagingGroupAgent({
      id: 'mga-dm-sticky',
      messaging_group_id: 'mg-dm-sticky',
      agent_group_id: 'ag-sticky',
      engage_mode: 'mention-sticky',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:DMSTICKY',
      threadId: null,
      message: {
        id: 'm-dmsticky-1',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'hi' }),
        timestamp: now(),
        isMention: false,
        isGroup: false,
      },
    });

    // Group: first mention creates the session; a later non-mention message
    // in the same thread should still engage via the existing-session check.
    await seedMessagingGroup({ id: 'mg-grp-sticky', platform_id: 'testchat:GRPSTICKY', is_group: 1 } as never);
    await createMessagingGroupAgent({
      id: 'mga-grp-sticky',
      messaging_group_id: 'mg-grp-sticky',
      agent_group_id: 'ag-sticky',
      engage_mode: 'mention-sticky',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:GRPSTICKY',
      threadId: 'testchat:GRPSTICKY:t1',
      message: {
        id: 'm-grpsticky-1',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'hey @bot' }),
        timestamp: now(),
        isMention: true,
        isGroup: true,
      },
    });
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:GRPSTICKY',
      threadId: 'testchat:GRPSTICKY:t1',
      message: {
        id: 'm-grpsticky-2',
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'follow up, no mention' }),
        timestamp: now(),
        isMention: false,
        isGroup: true,
      },
    });
  });
});

describe('command gate integration', () => {
  it('drops a filtered slash command silently', async () => {
    await activate();
    await seedAgentGroup('ag-cmd');
    await seedMessagingGroup({ id: 'mg-cmd', platform_id: 'testchat:CMD' } as never);
    await createMessagingGroupAgent({
      id: 'mga-cmd',
      messaging_group_id: 'mg-cmd',
      agent_group_id: 'ag-cmd',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:CMD',
      threadId: null,
      message: {
        id: 'm-filtered',
        kind: 'chat',
        content: JSON.stringify({ text: '/help' }),
        timestamp: now(),
        isMention: false,
        isGroup: false,
      },
    });
    expect(debugSpy).toHaveBeenCalledWith(
      'Filtered command dropped by gate',
      expect.objectContaining({ agentGroupId: 'ag-cmd' }),
    );
  });

  it('denies an admin-only slash command from a non-admin sender and writes a denial reply', async () => {
    await activate();
    await seedAgentGroup('ag-cmd2');
    await seedMessagingGroup({ id: 'mg-cmd2', platform_id: 'testchat:CMD2' } as never);
    await createMessagingGroupAgent({
      id: 'mga-cmd2',
      messaging_group_id: 'mg-cmd2',
      agent_group_id: 'ag-cmd2',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    await routeInbound({
      channelType: 'testchat',
      platformId: 'testchat:CMD2',
      threadId: null,
      message: {
        id: 'm-denied-cmd',
        kind: 'chat',
        content: JSON.stringify({ text: '/clear' }),
        timestamp: now(),
        isMention: false,
        isGroup: false,
      },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      'Admin command denied by gate',
      expect.objectContaining({ command: '/clear', agentGroupId: 'ag-cmd2' }),
    );
  });
});

describe('messageIdForAgent', () => {
  it('generates a synthetic id when the inbound event carries none', async () => {
    await activate();
    await seedAgentGroup('ag-noid');
    await seedMessagingGroup({ id: 'mg-noid', platform_id: 'testchat:NOID' } as never);
    await createMessagingGroupAgent({
      id: 'mga-noid',
      messaging_group_id: 'mg-noid',
      agent_group_id: 'ag-noid',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      threads: 1,
      created_at: now(),
    });
    await expect(
      routeInbound({
        channelType: 'testchat',
        platformId: 'testchat:NOID',
        threadId: null,
        message: {
          id: '',
          kind: 'chat',
          content: JSON.stringify({ text: 'no id here' }),
          timestamp: now(),
          isMention: false,
          isGroup: false,
        },
      }),
    ).resolves.toBeUndefined();
  });
});

// Runs last: registers every hook, which permanently disarms the
// "no gate registered" branch tested above for the rest of this file.
describe('hook overwrite warnings', () => {
  it('warns when setSenderResolver, setAccessGate, setSenderScopeGate, setChannelRequestGate are set twice', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const resolverA: SenderResolverFn = () => null;
    const resolverB: SenderResolverFn = () => null;
    setSenderResolver(resolverA);
    setSenderResolver(resolverB);
    expect(warnSpy).toHaveBeenCalledWith('Sender resolver overwritten');

    const gateA: AccessGateFn = () => ({ allowed: true });
    const gateB: AccessGateFn = () => ({ allowed: true });
    setAccessGate(gateA);
    setAccessGate(gateB);
    expect(warnSpy).toHaveBeenCalledWith('Access gate overwritten');

    const scopeA: SenderScopeGateFn = () => ({ allowed: true });
    const scopeB: SenderScopeGateFn = () => ({ allowed: true });
    setSenderScopeGate(scopeA);
    setSenderScopeGate(scopeB);
    expect(warnSpy).toHaveBeenCalledWith('Sender-scope gate overwritten');

    const crgA: ChannelRequestGateFn = async () => {};
    const crgB: ChannelRequestGateFn = async () => {};
    setChannelRequestGate(crgA);
    setChannelRequestGate(crgB);
    expect(warnSpy).toHaveBeenCalledWith('Channel-request gate overwritten');
  });
});

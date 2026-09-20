/**
 * `engage_pattern` is operator/admin-set (approval-gated), but nothing
 * validates it's backtracking-safe. A catastrophic regex run directly via
 * `new RegExp(pat).test(text)` would hang this single-threaded host
 * indefinitely, freezing every agent group's message processing — not just
 * the offending wiring. `safeEngagePatternTest` (src/router.ts) runs the
 * test inside a vm context with a hard timeout so a runaway pattern is
 * interrupted instead of blocking the process.
 *
 * Exercised through the REAL routeInbound path, same harness shape as
 * router-unknown-engage-mode.test.ts.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-engage-pattern-redos' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { getUnregisteredSenders } from './db/dropped-messages.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-engage-pattern-redos';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

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

async function seedPatternWiring(engagePattern: string): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: engagePattern,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(id: string, text: string): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: null,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'U1', text }),
      timestamp: now(),
      isMention: true,
      isGroup: false,
    },
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  vi.clearAllMocks();
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('evaluateEngage with a catastrophic-backtracking engage_pattern', () => {
  it('a runaway pattern times out, fails closed, and logs a warning instead of hanging', async () => {
    await activate();
    // Classic catastrophic-backtracking shape: nested quantifier with no
    // matching suffix forces exponential backtracking.
    await seedPatternWiring('(a+)+$');

    const text = 'a'.repeat(40) + '!';
    const start = Date.now();
    await inbound('m1', text);
    const elapsed = Date.now() - start;

    // Must be bounded by the vm timeout (200ms), not by the exponential
    // blowup an unguarded `new RegExp(pat).test(text)` would hit.
    expect(elapsed).toBeLessThan(5000);

    const dropped = await getUnregisteredSenders();
    expect(dropped).toHaveLength(1);
    expect(dropped[0].reason).toBe('no_agent_engaged');

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('exceeded time budget'),
      expect.objectContaining({ agent_group_id: 'ag-1', engage_pattern: '(a+)+$' }),
    );
  }, 10000);

  it('a well-behaved pattern still matches normally', async () => {
    await activate();
    await seedPatternWiring('hello');

    await inbound('m1', 'hello there');

    const dropped = await getUnregisteredSenders();
    expect(dropped).toHaveLength(0);
  });
});

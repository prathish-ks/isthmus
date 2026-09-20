/**
 * PERF-GATE: bounds routeInbound's happy-path latency (messaging group
 * resolution, agent-wiring lookup, session resolve/create, message write,
 * container wake) — the per-message cost every inbound message on every
 * channel pays, not just the ReDoS edge case already covered by
 * router-engage-pattern-redos.test.ts. Picked up by the CI
 * `performance-gate` job (.github/workflows/ci.yml), which greps for this
 * tag rather than hardcoding file paths.
 *
 * Same harness shape as router-engage-pattern-redos.test.ts and
 * router-unknown-engage-mode.test.ts, but exercises the ordinary
 * mention-sticky engage path (not a pattern regex) so every call actually
 * reaches wakeContainer instead of being dropped.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-happy-path-perf' };
});

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import { routeInbound } from './router.js';
import { wakeContainer } from './container-runner.js';
import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';

const TEST_DIR = '/tmp/nanoclaw-test-router-happy-path-perf';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'public' },
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

async function seedWiring(): Promise<void> {
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
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
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

describe('routeInbound happy-path performance budget', () => {
  it('stays within budget across repeated ordinary messages on a shared session', async () => {
    await activate();
    await seedWiring();

    const iterations = 50;
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      await inbound(`m${i}`, `hello number ${i}`);
    }
    const elapsed = Date.now() - start;

    expect(wakeContainer).toHaveBeenCalledTimes(iterations);

    // PERF-RESULT is a fixed-format marker (see .github/workflows/ci.yml's
    // performance-gate job) that the CI report step greps out of raw test
    // output to build a human-readable results-vs-budget table on the run
    // summary page — keep the "name=" / "elapsed_ms=" / "budget_ms="
    // fields exactly as shown if this line is ever edited.
    const budgetMs = 3000;
    console.log(`PERF-RESULT: name="TS host: routeInbound happy path" elapsed_ms=${elapsed} budget_ms=${budgetMs}`);

    // Root cause of this test's real variance (148ms-3350ms across
    // several actual CI runs, at one point exceeding an earlier 1500ms
    // budget) turned out to be file-level parallelism, not the code
    // under test: performance-gate's Host step runs this file alongside
    // router-engage-pattern-redos.test.ts, and vitest's default pool
    // forks each test file into its own process running concurrently —
    // real CPU contention between the two on top of whatever this test
    // is trying to measure. Fixed at the CI invocation with
    // --no-file-parallelism (.github/workflows/ci.yml), confirmed
    // locally: parallel gave a 383-546ms range (43% spread) for this
    // exact test, sequential gave 306-330ms (8% spread). 3000ms gives
    // real margin over that stabilized baseline for whatever residual
    // difference GitHub's runners have from this dev machine, without
    // just re-inflating the number to paper over contention that's now
    // actually addressed at the source.
    expect(elapsed).toBeLessThan(budgetMs);
  }, 20000);
});

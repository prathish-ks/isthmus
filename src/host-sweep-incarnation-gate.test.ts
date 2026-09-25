/**
 * Regression test for the incarnation gate in the host sweep's SLA check.
 *
 * v2.4.0 promotion, Workstream C13. `enforceRunningContainerSla` used to
 * treat a `processing_ack` claim's `status_changed` timestamp as evidence
 * about the *current* container incarnation, even when that timestamp
 * predates the incarnation's own `session_claims.claimed_at`. A fresh
 * incarnation (new host instance takes over a session, e.g. after failover)
 * inherits whatever stale `processing_ack` rows the previous incarnation
 * left behind in `outbound.db` — those rows say nothing about whether *this*
 * container is stuck, since this container hasn't had a chance to touch
 * them yet. Without the gate, the sweep kills a perfectly healthy freshly-
 * claimed container on its very first SLA check.
 *
 * Drives the real sweep loop (startHostSweep) against a real central DB and
 * real on-disk session DBs, mocking only the container runner — same
 * approach as host-sweep-grace.test.ts. Goes red if the incarnation gate
 * (the `getSessionClaim` / `incarnationStartMs` logic in
 * `enforceRunningContainerSla`) is removed.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-incarnation-gate' };
});

vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn().mockReturnValue(true),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { tryClaimSession } from './db/coordination.js';
import { createSession } from './db/sessions.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { initSessionFolder } from './session-manager.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-incarnation-gate';
const AG = 'ag-test';
const SESS = 'sess-test';
const SWEEP_INTERVAL_MS = 60_000;

function now(): string {
  return new Date().toISOString();
}

function seedStaleClaim(messageId: string, ageMs: number): void {
  const db = new Database(outboundDbPath(AG, SESS));
  db.prepare("INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)").run(
    messageId,
    new Date(Date.now() - ageMs).toISOString(),
  );
  db.close();
}

const sweepCallbacks: Array<() => void> = [];
const realSetTimeout = global.setTimeout;
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

async function runSweepTick(): Promise<void> {
  const before = sweepCallbacks.length;
  if (before === 0) {
    startHostSweep();
  } else {
    sweepCallbacks[before - 1]();
  }
  await vi.waitFor(() => {
    expect(sweepCallbacks.length).toBe(before + 1);
  });
}

beforeEach(async () => {
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(true);
  vi.mocked(killContainer).mockReset();
  vi.mocked(wakeContainer).mockReset().mockResolvedValue(true);

  sweepCallbacks.length = 0;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Test Agent', folder: 'test-agent', agent_provider: null, created_at: now() });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('host sweep incarnation gate', () => {
  it('does not kill on a stale claim inherited from before this incarnation started', async () => {
    // The previous incarnation left a processing_ack claim stale for 2h —
    // ordinary evidence of a stuck container.
    seedStaleClaim('m-1', 2 * 60 * 60 * 1000);
    // But a new host instance claimed this session just now — this
    // container is a fresh incarnation that hasn't had a chance to touch
    // that leftover claim yet.
    await tryClaimSession({ sessionId: SESS, instanceId: 'host-b', expectedIncarnation: 0, now: now() });

    await runSweepTick();

    expect(killContainer).not.toHaveBeenCalled();
  });

  it('still kills on a claim that postdates the current incarnation and is stale', async () => {
    // The current incarnation claimed the session 2h ago — old enough that
    // a claim made under it can legitimately be stuck.
    await tryClaimSession({
      sessionId: SESS,
      instanceId: 'host-a',
      expectedIncarnation: 0,
      now: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    seedStaleClaim('m-1', 2 * 60 * 60 * 1000);

    await runSweepTick();

    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith(SESS, 'claim-stuck');
  });
});

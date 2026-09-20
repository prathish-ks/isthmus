/**
 * Coverage-uplift tests for host-sweep.ts targeting branches the
 * pre-existing host-sweep.test.ts / host-sweep-grace.test.ts / host-core.test.ts
 * suites don't reach: the sweep loop's error-catch branches, sweepSession's
 * early returns, maintainSessionMailbox's not-running / task-close / echo-prune
 * branches, enforceRunningContainerSla's kill-ceiling path, and
 * resetStuckProcessingRows' max-tries + orphan-cleanup-failure branches.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-host-sweep-cov' };
});

vi.mock('./container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn().mockReturnValue(false),
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

vi.mock('./egress-lockdown.js', () => ({
  ensureEgressNetwork: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import * as sessionsDb from './db/sessions.js';
import * as agentGroupsDb from './db/agent-groups.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { ensureEgressNetwork } from './egress-lockdown.js';
import { _resetStuckProcessingRowsForTesting, startHostSweep, stopHostSweep } from './host-sweep.js';
import { log } from './log.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './mailbox/sqlite/index.js';
import { heartbeatPath, initSessionFolder, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-host-sweep-cov';
const AG = 'ag-cov';
const SESS = 'sess-cov';
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
  vi.mocked(isContainerRunning).mockReset().mockReturnValue(false);
  vi.mocked(killContainer).mockReset();
  vi.mocked(wakeContainer)
    .mockReset()
    .mockImplementation(async () => {
      vi.mocked(isContainerRunning).mockReturnValue(true);
      return true;
    });
  vi.mocked(ensureEgressNetwork).mockReset();

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
  await createAgentGroup({ id: AG, name: 'Cov Agent', folder: 'cov-agent', agent_provider: null, created_at: now() });
});

afterEach(async () => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('sweep loop', () => {
  it('startHostSweep is idempotent (a second call is a no-op)', async () => {
    startHostSweep();
    startHostSweep();
    await vi.waitFor(() => {
      expect(sweepCallbacks.length).toBe(1);
    });
  });

  it('logs and continues when ensureEgressNetwork throws', async () => {
    vi.mocked(ensureEgressNetwork).mockImplementation(() => {
      throw new Error('network heal failed');
    });
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await runSweepTick();
    expect(errSpy).toHaveBeenCalledWith('Egress lockdown re-heal failed', { err: expect.any(Error) });
  });

  it('logs "Host sweep error" and continues when getActiveSessions rejects', async () => {
    const err = new Error('db unavailable');
    const spy = vi.spyOn(sessionsDb, 'getActiveSessions').mockRejectedValueOnce(err);
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await runSweepTick();
    expect(errSpy).toHaveBeenCalledWith('Host sweep error', { err });
    spy.mockRestore();
  });

  it('logs and continues when the reject-with-reason sweep throws', async () => {
    const approvalsModule = await import('./modules/approvals/index.js');
    const err = new Error('reason sweep exploded');
    const spy = vi.spyOn(approvalsModule, 'sweepAwaitingReasonRejects').mockRejectedValueOnce(err);
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await runSweepTick();
    expect(errSpy).toHaveBeenCalledWith('Reject-with-reason sweep failed', { err });
    spy.mockRestore();
  });
});

describe('sweepSession early returns', () => {
  it('returns without error when the session agent group no longer exists', async () => {
    await createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESS);
    const spy = vi.spyOn(agentGroupsDb, 'getAgentGroup').mockResolvedValueOnce(undefined);
    await expect(runSweepTick()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it('returns without error when the mailbox was never provisioned', async () => {
    await createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    // Deliberately skip initSessionFolder — no mailbox exists on disk.
    await expect(runSweepTick()).resolves.toBeUndefined();
  });
});

describe('maintainSessionMailbox', () => {
  it('resets stale processing rows when the container is not running', async () => {
    await createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESS);
    // trigger: false keeps this out of countDueMessages, so the sweep takes
    // the no-wake branch and maintainSessionMailbox runs with justWoke=false
    // and the container genuinely not running (isContainerRunning stays false).
    await writeSessionMessage(AG, SESS, {
      id: 'm-stale',
      kind: 'chat',
      timestamp: now(),
      content: '{}',
      trigger: false,
    });
    seedStaleClaim('m-stale', 2 * 60 * 60 * 1000);
    vi.mocked(isContainerRunning).mockReturnValue(false);
    await runSweepTick();
    const outDb = new Database(outboundDbPath(AG, SESS));
    const remaining = outDb.prepare('SELECT * FROM processing_ack').all();
    expect(remaining).toHaveLength(0);
    outDb.close();
  });

  it('closes a spent task session with no live tasks and no running container', async () => {
    const { taskThreadId } = await import('./db/sessions.js');
    const threadId = taskThreadId('cov-series');
    await createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESS);
    vi.mocked(isContainerRunning).mockReturnValue(false);
    await runSweepTick();
    const { getSession } = await import('./db/sessions.js');
    const session = await getSession(SESS);
    expect(session?.status).toBe('closed');
  });

  it('logs and swallows when the echo-backlog prune throws', async () => {
    await createSession({
      id: SESS,
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    initSessionFolder(AG, SESS);
    const crossSessionModule = await import('./modules/cross-session-context/index.js');
    const err = new Error('prune exploded');
    const spy = vi.spyOn(crossSessionModule, 'pruneEchoBacklog').mockImplementation(() => {
      throw err;
    });
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await runSweepTick();
    expect(errSpy).toHaveBeenCalledWith('Echo backlog prune failed', { sessionId: SESS, err });
    spy.mockRestore();
  });
});

describe('enforceRunningContainerSla — kill-ceiling path', () => {
  it('kills a running container whose heartbeat exceeds the absolute ceiling', async () => {
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
    // Write a heartbeat file with an ancient mtime (past the 30-minute ceiling).
    const hb = heartbeatPath(AG, SESS);
    fs.writeFileSync(hb, '');
    const old = new Date(Date.now() - 40 * 60 * 1000);
    fs.utimesSync(hb, old, old);

    // First tick: alive but not justWoke (container was already "running").
    vi.mocked(isContainerRunning).mockReturnValue(true);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await runSweepTick();
    expect(killContainer).toHaveBeenCalledWith(SESS, 'absolute-ceiling');
    expect(warnSpy).toHaveBeenCalledWith(
      'Killing container past absolute ceiling',
      expect.objectContaining({ sessionId: SESS }),
    );
  });
});

describe('resetStuckProcessingRows — max-tries and orphan-cleanup failure', () => {
  function makeSessionDbs() {
    const rawIn = new Database(':memory:');
    rawIn.exec(`
      CREATE TABLE messages_in (
        id            TEXT PRIMARY KEY,
        seq           INTEGER UNIQUE,
        kind          TEXT NOT NULL,
        timestamp     TEXT NOT NULL,
        status        TEXT DEFAULT 'pending',
        process_after TEXT,
        recurrence    TEXT,
        series_id     TEXT,
        tries         INTEGER DEFAULT 0,
        trigger       INTEGER NOT NULL DEFAULT 1,
        platform_id   TEXT,
        channel_type  TEXT,
        thread_id     TEXT,
        content       TEXT NOT NULL
      );
    `);
    const rawOut = new Database(':memory:');
    rawOut.exec(`
      CREATE TABLE processing_ack (
        message_id     TEXT PRIMARY KEY,
        status         TEXT NOT NULL,
        status_changed TEXT NOT NULL
      );
    `);
    return {
      rawOut,
      inDb: Object.assign(wrapSqliteInbound(rawIn), { prepare: rawIn.prepare.bind(rawIn) }),
      outDb: Object.assign(wrapSqliteOutbound(rawOut), { prepare: rawOut.prepare.bind(rawOut) }),
    };
  }

  function fakeSession(): Session {
    return {
      id: 'sess-test',
      agent_group_id: 'ag-test',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    };
  }

  it('marks a message failed after MAX_TRIES (5) is reached', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, tries, content) VALUES ('m-maxed', 1, 'chat', ?, 'pending', 5, '{}')",
      )
      .run(claimedAt);
    (outDb as unknown as { prepare: Database.Database['prepare'] })
      .prepare("INSERT INTO processing_ack VALUES ('m-maxed', 'processing', ?)")
      .run(claimedAt);

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    const row = inDb.prepare("SELECT status FROM messages_in WHERE id = 'm-maxed'").get() as { status: string };
    expect(row.status).toBe('failed');
    expect(warnSpy).toHaveBeenCalledWith(
      'Message marked as failed after max retries',
      expect.objectContaining({ messageId: 'm-maxed', reason: 'absolute-ceiling' }),
    );
  });

  it('logs and swallows when deleteOrphanProcessingClaims throws', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-orphan-throws', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    (outDb as unknown as { prepare: Database.Database['prepare'] })
      .prepare("INSERT INTO processing_ack VALUES ('m-orphan-throws', 'processing', ?)")
      .run(claimedAt);

    const brokenOutDb = {
      ...outDb,
      deleteOrphanProcessingClaims: () => {
        throw new Error('disk error');
      },
    };
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(() => _resetStuckProcessingRowsForTesting(inDb, brokenOutDb, fakeSession(), 'claim-stuck')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to clear orphan processing claims',
      expect.objectContaining({ sessionId: 'sess-test', err: expect.any(Error) }),
    );
  });
});

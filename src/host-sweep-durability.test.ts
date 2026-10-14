/**
 * TC-19 — message durability across a crash mid-processing.
 *
 * The sweep's pieces are each unit-tested already: decideStuckAction's whole
 * decision table, deleteOrphanProcessingClaims, resetStuckProcessingRows's
 * two arms, maintainSessionMailbox (host-sweep.test.ts,
 * host-sweep.coverage.test.ts). The outbound half of TC-19 is covered too —
 * delivery.test.ts pins exactly-once across overlapping active/sweep polls,
 * no re-delivery after a successful send, and visible failure after
 * MAX_DELIVERY_ATTEMPTS.
 *
 * What nothing asserts is the COMPOSITION, which is what TC-19 actually asks
 * for: send several uniquely numbered messages, lose the worker mid-flight,
 * recover, and account for every one of them. A per-function test can be green
 * while the ledger still fails to add up — a message reset but double-counted,
 * a neighbour swept along with the casualty, a failure that leaves no trace.
 * So this file is deliberately written as a ledger: at each step it asserts
 * the state of EVERY message, not just the one that crashed.
 *
 * The four claims, mapped:
 *   no acknowledged work disappears     every id still present at every step
 *   no completed side effect duplicated no row count change, no new ids, seq
 *                                       values stable (outbound dup covered by
 *                                       delivery.test.ts)
 *   pending work recovers or fails      the casualty retries with backoff, and
 *       VISIBLY                         after MAX_TRIES lands status='failed'
 *                                       rather than vanishing
 *   new work still flows afterwards     an arrival after the failure is
 *                                       pending and untouched by the sweep
 */
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { _resetStuckProcessingRowsForTesting } from './host-sweep.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './mailbox/sqlite/index.js';
import type { Session } from './types.js';

/** Mirrors host-sweep.ts's own constants; asserted against below. */
const MAX_TRIES = 5;

type Dbs = ReturnType<typeof makeSessionDbs>;

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
    inDb: Object.assign(wrapSqliteInbound(rawIn), { prepare: rawIn.prepare.bind(rawIn) }),
    outDb: Object.assign(wrapSqliteOutbound(rawOut), { prepare: rawOut.prepare.bind(rawOut) }),
  };
}

function fakeSession(): Session {
  return {
    id: 'sess-durability',
    agent_group_id: 'ag-durability',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  } as Session;
}

/** Queue `count` uniquely numbered messages, host-side even seqs. */
function queue(dbs: Dbs, count: number): string[] {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `msg-${i}`;
    ids.push(id);
    dbs.inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES (?, ?, 'chat', ?, 'pending', ?)`,
      )
      .run(id, i * 2, new Date().toISOString(), JSON.stringify({ text: `unique body ${i}` }));
  }
  return ids;
}

/** A container claims a message, then dies without acking. */
function claimThenCrash(dbs: Dbs, id: string): void {
  dbs.outDb
    .prepare(`INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', ?)`)
    .run(id, new Date(Date.now() - 10 * 60_000).toISOString());
}

interface Row {
  id: string;
  status: string;
  tries: number;
  process_after: string | null;
  seq: number;
  content: string;
}

function ledger(dbs: Dbs): Row[] {
  return dbs.inDb
    .prepare('SELECT id, status, tries, process_after, seq, content FROM messages_in ORDER BY seq')
    .all() as Row[];
}

function byId(dbs: Dbs, id: string): Row {
  const row = ledger(dbs).find((r) => r.id === id);
  if (!row) throw new Error(`message ${id} vanished from the ledger`);
  return row;
}

/** Clear the backoff so the next sweep tick is eligible — simulates waiting. */
function elapseBackoff(dbs: Dbs, id: string): void {
  dbs.inDb.prepare('UPDATE messages_in SET process_after = NULL WHERE id = ?').run(id);
}

function sweep(dbs: Dbs): void {
  _resetStuckProcessingRowsForTesting(dbs.inDb, dbs.outDb, fakeSession(), 'crash mid-processing');
}

describe('a crash mid-processing', () => {
  it('loses nothing, duplicates nothing, and touches only the casualty', () => {
    const dbs = makeSessionDbs();
    const ids = queue(dbs, 5);
    const before = ledger(dbs);
    claimThenCrash(dbs, 'msg-3');

    sweep(dbs);

    const after = ledger(dbs);
    // Nothing disappeared and nothing was invented.
    expect(after.map((r) => r.id)).toEqual(ids);
    expect(after).toHaveLength(before.length);
    // Identity is stable: seq and payload are untouched for every row.
    expect(after.map((r) => r.seq)).toEqual(before.map((r) => r.seq));
    expect(after.map((r) => r.content)).toEqual(before.map((r) => r.content));

    // The casualty is queued for another attempt, counted once.
    const casualty = byId(dbs, 'msg-3');
    expect(casualty.status).toBe('pending');
    expect(casualty.tries).toBe(1);
    expect(casualty.process_after).not.toBeNull();

    // Its neighbours were not swept along with it.
    for (const id of ['msg-1', 'msg-2', 'msg-4', 'msg-5']) {
      const row = byId(dbs, id);
      expect(row.status).toBe('pending');
      expect(row.tries).toBe(0);
      expect(row.process_after).toBeNull();
    }
  });

  it('clears the orphan claim, so the next container is not killed for it', () => {
    // The 2026-04-30 production loop: the message was reset but its
    // processing_ack row survived, so the same-tick SLA check saw an
    // hours-old claim and SIGKILLed the freshly spawned replacement.
    const dbs = makeSessionDbs();
    queue(dbs, 3);
    claimThenCrash(dbs, 'msg-2');

    sweep(dbs);

    const claims = dbs.outDb.prepare("SELECT message_id FROM processing_ack WHERE status = 'processing'").all();
    expect(claims).toEqual([]);
  });

  it('does not double-count a message already waiting on its backoff', () => {
    // Two sweep ticks inside one backoff window must cost one try, not two —
    // the active (1s) and sweep (60s) chains both reach this code.
    const dbs = makeSessionDbs();
    queue(dbs, 2);
    claimThenCrash(dbs, 'msg-1');

    sweep(dbs);
    expect(byId(dbs, 'msg-1').tries).toBe(1);

    claimThenCrash(dbs, 'msg-1');
    sweep(dbs);
    expect(byId(dbs, 'msg-1').tries).toBe(1);
  });
});

describe('repeated crashes end visibly, not silently', () => {
  it(`escalates to status='failed' after ${MAX_TRIES} tries and stays in the ledger`, () => {
    const dbs = makeSessionDbs();
    queue(dbs, 3);

    // Crash on the same message over and over, waiting out each backoff.
    for (let cycle = 0; cycle < MAX_TRIES + 1; cycle++) {
      claimThenCrash(dbs, 'msg-2');
      sweep(dbs);
      elapseBackoff(dbs, 'msg-2');
    }

    const failed = byId(dbs, 'msg-2');
    expect(failed.status).toBe('failed');
    // Visibly failed, not deleted — an operator can still find it.
    expect(ledger(dbs).map((r) => r.id)).toEqual(['msg-1', 'msg-2', 'msg-3']);
  });

  it('a failed message is terminal — a later crash cycle cannot resurrect it', () => {
    const dbs = makeSessionDbs();
    queue(dbs, 1);
    for (let cycle = 0; cycle < MAX_TRIES + 1; cycle++) {
      claimThenCrash(dbs, 'msg-1');
      sweep(dbs);
      elapseBackoff(dbs, 'msg-1');
    }
    expect(byId(dbs, 'msg-1').status).toBe('failed');

    const triesAtFailure = byId(dbs, 'msg-1').tries;
    claimThenCrash(dbs, 'msg-1');
    sweep(dbs);

    const row = byId(dbs, 'msg-1');
    expect(row.status).toBe('failed');
    expect(row.tries).toBe(triesAtFailure);
  });

  it('takes the full budget to fail — it does not give up early', () => {
    const dbs = makeSessionDbs();
    queue(dbs, 1);

    for (let cycle = 0; cycle < MAX_TRIES; cycle++) {
      claimThenCrash(dbs, 'msg-1');
      sweep(dbs);
      elapseBackoff(dbs, 'msg-1');
      // Still recoverable at every step before the budget is spent.
      expect(byId(dbs, 'msg-1').status).toBe('pending');
    }
    expect(byId(dbs, 'msg-1').tries).toBe(MAX_TRIES);

    claimThenCrash(dbs, 'msg-1');
    sweep(dbs);
    expect(byId(dbs, 'msg-1').status).toBe('failed');
  });
});

describe('the session keeps working after the failure', () => {
  it('a message arriving after a permanent failure is pending and untouched', () => {
    const dbs = makeSessionDbs();
    queue(dbs, 1);
    for (let cycle = 0; cycle < MAX_TRIES + 1; cycle++) {
      claimThenCrash(dbs, 'msg-1');
      sweep(dbs);
      elapseBackoff(dbs, 'msg-1');
    }
    expect(byId(dbs, 'msg-1').status).toBe('failed');

    // New arrival, after the casualty was written off.
    dbs.inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES ('msg-new', 99, 'chat', ?, 'pending', ?)`,
      )
      .run(new Date().toISOString(), JSON.stringify({ text: 'after recovery' }));

    sweep(dbs);

    const fresh = byId(dbs, 'msg-new');
    expect(fresh.status).toBe('pending');
    expect(fresh.tries).toBe(0);
    expect(fresh.process_after).toBeNull();
    // And the written-off one did not come back to life alongside it.
    expect(byId(dbs, 'msg-1').status).toBe('failed');
  });
});

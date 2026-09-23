/**
 * Regression tests for the host-side even-seq allocation across
 * inbound.db/messages_in and outbound.db/messages_out (code review finding:
 * wrapSqliteInbound's and wrapSqliteOutbound's default sequence generators
 * each only cross-checked their own table, so the two files — separate
 * SQLite files with no cross-file uniqueness constraint — could
 * independently allocate the same even seq).
 *
 * `wrapSqliteInbound`/`wrapSqliteOutbound`'s own DEFAULT `nextSequence`
 * (`nextEvenAcross`, scoped to that wrapper's own table) is unchanged and
 * still has this gap when either is constructed standalone, as most tests
 * below do — that default exists for isolated/unit usage and intentionally
 * does not reach across files. The actual production fix lives one level up:
 * `SqliteAgentMailbox.session()` (index.ts) is the sole place both wrappers
 * are constructed together, and it now wires BOTH through one shared,
 * persisted counter (`makeHostSeqAllocator`) instead of their independent
 * per-table defaults. The last test in this file exercises that shared
 * allocator directly and shows the same scenario that used to collide no
 * longer does.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { makeHostSeqAllocator, wrapSqliteInbound, wrapSqliteOutbound } from './index.js';

describe('writeDirect seq allocation cross-checks messages_in', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('does not collide with an existing messages_in row when messages_in is far ahead of messages_out', async () => {
    // Quiet outbound history (no replies sent yet) but a chatty inbound
    // history — the exact shape that, pre-fix, made writeDirect compute its
    // seq from messages_out alone (max=0 -> next even 2) and collide with
    // an messages_in row that already occupies seq=2.
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);

    const inbound = wrapSqliteInbound(inboundDb);
    for (let i = 0; i < 5; i++) {
      await inbound.insertMessage({
        id: `in-${i}`,
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{}',
        processAfter: null,
        recurrence: null,
        trigger: true,
        sourceSessionId: null,
        onWake: false,
      });
    }
    const maxInboundSeq = (inboundDb.prepare('SELECT MAX(seq) AS m FROM messages_in').get() as { m: number }).m;
    expect(maxInboundSeq).toBeGreaterThan(2);

    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      { inbound: inboundDb },
    );
    await outbound.writeDirect({
      id: 'out-direct-1',
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
    });

    const allocatedSeq = (
      outboundDb.prepare('SELECT seq FROM messages_out WHERE id = ?').get('out-direct-1') as { seq: number }
    ).seq;

    expect(allocatedSeq).toBeGreaterThan(maxInboundSeq);
    // No messages_in row already occupies the allocated seq.
    expect(inboundDb.prepare('SELECT 1 FROM messages_in WHERE seq = ?').get(allocatedSeq)).toBeUndefined();
  });

  it('falls back to outbound-only allocation when no inbound handle is supplied (unchanged default behavior)', async () => {
    const outboundDb = new Database(':memory:');
    databases.push(outboundDb);
    outboundDb.exec(OUTBOUND_SCHEMA);

    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
    );
    await outbound.writeDirect({
      id: 'out-1',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
    });

    expect((outboundDb.prepare('SELECT seq FROM messages_out WHERE id = ?').get('out-1') as { seq: number }).seq).toBe(
      2,
    );
  });

  // Same scenario as the standalone-wrapper gap above, but going through the
  // shared allocator that session() actually wires in production: an inbound
  // message, then a simulated container reply, then a writeDirect deny, then
  // another inbound message. Pre-fix (see the two tests above, which still
  // use each wrapper's own independent default) this landed both `in-2` and
  // `out-deny` on the same seq. With the shared counter, every claim comes
  // from one persisted source, so it never repeats regardless of which side
  // — messages_in or messages_out — claimed most recently.
  it('shared host-seq allocator: no collision even when messages_out is ahead of messages_in', async () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);

    const nextHostSeq = makeHostSeqAllocator(inboundDb, () => outboundDb);
    const inbound = wrapSqliteInbound(inboundDb, nextHostSeq);
    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      { inbound: inboundDb, nextSequence: nextHostSeq },
    );

    // msg1 arrives (messages_in.seq=2), container replies (messages_out.seq=3,
    // simulated directly since the container's own allocator lives in the
    // agent-runner tree, not here).
    await inbound.insertMessage({
      id: 'in-1',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    });
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('out-reply', 3, '2026-01-01T00:00:01.000Z', 'chat', '{}')`,
      )
      .run();

    // A command-gate deny fires via writeDirect.
    await outbound.writeDirect({
      id: 'out-deny',
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
    });
    const denySeq = (outboundDb.prepare('SELECT seq FROM messages_out WHERE id = ?').get('out-deny') as { seq: number })
      .seq;

    // The next inbound message now goes through the same shared counter.
    await inbound.insertMessage({
      id: 'in-2',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:02.000Z',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
      processAfter: null,
      recurrence: null,
      trigger: true,
      sourceSessionId: null,
      onWake: false,
    });
    const in2Seq = (inboundDb.prepare('SELECT seq FROM messages_in WHERE id = ?').get('in-2') as { seq: number }).seq;

    expect(in2Seq).not.toBe(denySeq);
    expect(in2Seq % 2).toBe(0);
    expect(denySeq % 2).toBe(0);
  });

  it('shared host-seq allocator: seeds from existing history on first use, then persists across allocator instances', () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);

    // Pre-existing data from before this counter existed (e.g. an
    // already-running session upgraded to this code): messages_in has rows
    // up to seq=6, messages_out up to seq=9.
    inboundDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content) VALUES ('in-1', 2, 'chat', '2026-01-01T00:00:00.000Z', '{}'), ('in-2', 4, 'chat', '2026-01-01T00:00:01.000Z', '{}'), ('in-3', 6, 'chat', '2026-01-01T00:00:02.000Z', '{}')`,
      )
      .run();
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES ('out-1', 9, '2026-01-01T00:00:03.000Z', 'chat', '{}')`,
      )
      .run();

    const first = makeHostSeqAllocator(inboundDb, () => outboundDb)();
    expect(first).toBe(10); // seeded from max(6, 9) = 9 -> next even 10

    // A fresh allocator instance for the same inbound.db (simulating a later
    // session() call on the same session) picks up the persisted counter
    // instead of reseeding from history.
    const second = makeHostSeqAllocator(inboundDb, () => outboundDb)();
    expect(second).toBe(12);
  });
});

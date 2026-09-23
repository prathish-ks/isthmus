/**
 * Regression tests for sqliteWriteMessageOut / sqliteGetMessageIdBySeq /
 * sqliteGetRoutingBySeq — previously untested anywhere in this tree.
 *
 * Code review finding: all three read messages_in (and sqliteGetMessageIdBySeq
 * also reads `delivered`) via the long-lived cached getInboundDb() singleton
 * instead of the fresh openInboundDb() that connection.ts's own doc comment
 * mandates for tables the host writes continuously. In-process, the
 * in-memory test double behind initTestSessionDb() makes both accessors
 * return the same singleton, so this suite can't reproduce the real
 * cross-mount staleness bug directly — what it DOES cover is the behavioral
 * contract these functions must keep now that they open (and must close) a
 * fresh connection per call: repeated calls still work, mid-sequence
 * inserts are still seen, and both the inbound-row and outbound-row branches
 * of the seq lookup still resolve correctly.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './connection.js';
import { sqliteGetMessageIdBySeq, sqliteGetRoutingBySeq, sqliteWriteMessageOut } from './operations.js';

afterEach(() => closeSessionDb());

function insertMessageIn(
  inbound: ReturnType<typeof initTestSessionDb>['inbound'],
  overrides: Partial<{
    id: string;
    seq: number;
    channel_type: string | null;
    platform_id: string | null;
    thread_id: string | null;
  }>,
): void {
  const row = {
    id: 'in-1',
    seq: 2,
    channel_type: 'test',
    platform_id: 'room',
    thread_id: 'thread',
    ...overrides,
  };
  inbound
    .prepare(
      `INSERT INTO messages_in
         (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
          platform_id, channel_type, thread_id, content, on_wake)
       VALUES (?, ?, 'chat', ?, 'pending', NULL, NULL, NULL, 0, 1, ?, ?, ?, '{}', 0)`,
    )
    .run(row.id, row.seq, new Date().toISOString(), row.platform_id, row.channel_type, row.thread_id);
}

describe('sqliteWriteMessageOut', () => {
  test('allocates seq strictly above the current messages_in high-water mark, not just messages_out', () => {
    const { inbound } = initTestSessionDb();
    insertMessageIn(inbound, { id: 'in-1', seq: 6 });

    const seq = sqliteWriteMessageOut({
      id: 'out-1',
      inReplyTo: 'in-1',
      deliverAfter: null,
      recurrence: null,
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
    });

    // messages_out is empty (max=0), but messages_in's max is 6 (even) —
    // the correct next odd seq is 7, proving the inbound cross-check runs.
    expect(seq).toBe(7);
  });

  test('sees a messages_in row inserted between two calls (no stale snapshot across repeated calls)', () => {
    const { inbound } = initTestSessionDb();
    insertMessageIn(inbound, { id: 'in-1', seq: 2 });

    const first = sqliteWriteMessageOut({
      id: 'out-1',
      inReplyTo: null,
      deliverAfter: null,
      recurrence: null,
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
    });
    expect(first).toBe(3);

    // A fresh host message lands after the first write.
    insertMessageIn(inbound, { id: 'in-2', seq: 10 });

    const second = sqliteWriteMessageOut({
      id: 'out-2',
      inReplyTo: null,
      deliverAfter: null,
      recurrence: null,
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
    });
    expect(second).toBe(11);
  });
});

describe('sqliteGetMessageIdBySeq / sqliteGetRoutingBySeq', () => {
  test('resolves an inbound (even) seq to its messages_in id and routing', () => {
    const { inbound } = initTestSessionDb();
    insertMessageIn(inbound, { id: 'in-42', seq: 42, channel_type: 'discord', platform_id: 'chan-1' });

    expect(sqliteGetMessageIdBySeq(42)).toBe('in-42');
    expect(sqliteGetRoutingBySeq(42)).toEqual({
      channel_type: 'discord',
      platform_id: 'chan-1',
      thread_id: 'thread',
    });
  });

  test('resolves an outbound (odd) seq to its platform_message_id once delivered', () => {
    const { inbound, outbound } = initTestSessionDb();
    const seq = sqliteWriteMessageOut({
      id: 'out-9',
      inReplyTo: null,
      deliverAfter: null,
      recurrence: null,
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{}',
    });
    const outRow = outbound.prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as { id: string };

    // Not yet delivered — falls back to the internal outbound row id.
    expect(sqliteGetMessageIdBySeq(seq)).toBe(outRow.id);

    inbound
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
         VALUES (?, ?, 'delivered', ?)`,
      )
      .run(outRow.id, 'platform-msg-123', new Date().toISOString());

    // Delivered — resolves to the real platform message id, not the UUID.
    expect(sqliteGetMessageIdBySeq(seq)).toBe('platform-msg-123');
  });

  test('returns null for a seq that exists in neither table', () => {
    initTestSessionDb();
    expect(sqliteGetMessageIdBySeq(999)).toBeNull();
    expect(sqliteGetRoutingBySeq(999)).toBeNull();
  });
});

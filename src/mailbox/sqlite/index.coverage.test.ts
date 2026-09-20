/**
 * Coverage-uplift tests for mailbox/sqlite/index.ts targeting the wrapper
 * methods the pre-existing sqlite.test.ts round-trip doesn't exercise:
 * applyProcessingAcks (non-empty), listLiveTasks / getTask / getTaskStats /
 * getCompletedRecurring / trailingFailedRuns / clearRecurrence / cancel-all /
 * pause / resume / delete / update task, replaceDestinations,
 * getInboundSourceSessionId, getMostRecentPeerSourceSessionId,
 * getInboundHistory, findTaskBySeriesSlug, getOutboundHistory, the
 * malformed-outbound-row fallback in getDueMessages, and
 * SqliteAgentMailbox's runnerContext/runnerEnvironment/unprepared-session
 * guard.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { SqliteAgentMailbox, wrapSqliteInbound, wrapSqliteOutbound } from './index.js';
import type { MailboxSessionKey } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

describe('applyProcessingAcks (non-empty)', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('marks completed acks as completed and script-skip:error acks as failed', async () => {
    const inboundDb = new Database(':memory:');
    databases.push(inboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(inboundDb);

    await inbound.insertMessage({
      id: 'm-1',
      kind: 'chat',
      timestamp: now(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
    });
    await inbound.insertMessage({
      id: 'm-2',
      kind: 'chat',
      timestamp: now(),
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
    });

    inbound.applyProcessingAcks([
      { messageId: 'm-1', status: 'completed', statusChanged: now() as never },
      { messageId: 'm-2', status: 'script-skip:error', statusChanged: now() as never },
    ]);

    const rows = inboundDb.prepare('SELECT id, status FROM messages_in ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'm-1', status: 'completed' },
      { id: 'm-2', status: 'failed' },
    ]);
  });

  it('is a no-op for an empty acks array', () => {
    const inboundDb = new Database(':memory:');
    databases.push(inboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(inboundDb);
    expect(() => inbound.applyProcessingAcks([])).not.toThrow();
  });
});

describe('task management wrapper methods', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function makeInbound() {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    return { db, inbound: wrapSqliteInbound(db) };
  }

  it('listLiveTasks with and without a status filter', async () => {
    const { inbound } = makeInbound();
    await inbound.insertTask({ id: 't-1', seriesId: 's-1', processAfter: null, recurrence: null, content: '{}' });
    await inbound.insertTask({
      id: 't-2',
      seriesId: 's-2',
      processAfter: null,
      recurrence: null,
      content: '{}',
      status: 'paused',
    });
    const all = inbound.listLiveTasks();
    expect(all.map((t) => t.id).sort()).toEqual(['t-1', 't-2']);
    const paused = inbound.listLiveTasks('paused');
    expect(paused.map((t) => t.id)).toEqual(['t-2']);
  });

  it('getTask returns the matching row by id or series id, and undefined when absent', async () => {
    const { inbound } = makeInbound();
    await inbound.insertTask({ id: 't-3', seriesId: 's-3', processAfter: null, recurrence: null, content: '{}' });
    expect(inbound.getTask('t-3')?.id).toBe('t-3');
    expect(inbound.getTask('s-3')?.id).toBe('t-3');
    expect(inbound.getTask('no-such-task')).toBeUndefined();
  });

  it('getTaskStats counts completed and failed runs', async () => {
    const { db, inbound } = makeInbound();
    await inbound.insertTask({ id: 't-4', seriesId: 's-4', processAfter: null, recurrence: null, content: '{}' });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 't-4'").run();
    const stats = inbound.getTaskStats('s-4');
    expect(stats.runs).toBe(1);
    expect(stats.failedRuns).toBe(0);
  });

  it('cancelTask (specific) vs cancelTask() undefined → cancelAllTasks', async () => {
    const { inbound } = makeInbound();
    await inbound.insertTask({ id: 't-5', seriesId: 's-5', processAfter: null, recurrence: null, content: '{}' });
    await inbound.insertTask({ id: 't-6', seriesId: 's-6', processAfter: null, recurrence: null, content: '{}' });
    const changed = inbound.cancelTask('t-5');
    expect(changed).toBe(1);
    expect(inbound.getTask('t-5')?.status).toBe('cancelled');
    expect(inbound.getTask('t-6')?.status).not.toBe('cancelled');

    const allChanged = inbound.cancelTask(undefined);
    expect(allChanged).toBeGreaterThanOrEqual(1);
    expect(inbound.getTask('t-6')?.status).toBe('cancelled');
  });

  it('pauseTask / resumeTask / deleteTask / updateTask mutate the row', async () => {
    const { inbound } = makeInbound();
    await inbound.insertTask({
      id: 't-7',
      seriesId: 's-7',
      processAfter: null,
      recurrence: null,
      content: '{"prompt":"a"}',
    });
    expect(inbound.pauseTask('t-7')).toBe(1);
    expect(inbound.getTask('t-7')?.status).toBe('paused');
    // updateTask only touches paused rows, or pending rows with a future
    // process_after — a resumed-with-no-processAfter row would not match.
    expect(inbound.updateTask('t-7', { prompt: 'b' })).toBe(1);
    expect(inbound.resumeTask('t-7')).toBe(1);
    expect(inbound.getTask('t-7')?.status).toBe('pending');
    expect(inbound.deleteTask('t-7')).toBe(1);
    expect(inbound.getTask('t-7')).toBeUndefined();
  });

  it('getCompletedRecurring, trailingFailedRuns, and clearRecurrence', async () => {
    const { db, inbound } = makeInbound();
    await inbound.insertTask({
      id: 't-8',
      seriesId: 's-8',
      processAfter: null,
      recurrence: '0 * * * *',
      content: '{}',
    });
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 't-8'").run();
    const recurring = inbound.getCompletedRecurring();
    expect(recurring.some((r) => r.id === 't-8')).toBe(true);

    const failed = inbound.trailingFailedRuns('s-8');
    expect(typeof failed).toBe('number');

    expect(() => inbound.clearRecurrence('t-8')).not.toThrow();
    const row = db.prepare("SELECT recurrence FROM messages_in WHERE id = 't-8'").get() as {
      recurrence: string | null;
    };
    expect(row.recurrence).toBeNull();
  });

  it('countLiveTasks counts pending/paused task rows', async () => {
    const { inbound } = makeInbound();
    expect(inbound.countLiveTasks()).toBe(0);
    await inbound.insertTask({ id: 't-9', seriesId: 's-9', processAfter: null, recurrence: null, content: '{}' });
    expect(inbound.countLiveTasks()).toBe(1);
  });

  it('findTaskBySeriesSlug finds the live occurrence and returns undefined when absent', async () => {
    const { inbound } = makeInbound();
    await inbound.insertTask({
      id: 'cov-a1b2',
      seriesId: 'cov-a1b2',
      processAfter: null,
      recurrence: null,
      content: '{}',
    });
    expect(inbound.findTaskBySeriesSlug('cov')?.id).toBe('cov-a1b2');
    expect(inbound.findTaskBySeriesSlug('no-such-slug')).toBeUndefined();
  });
});

describe('replaceDestinations and source-session lookups', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('replaceDestinations writes channel and agent destination rows', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(db);
    inbound.replaceDestinations([
      {
        name: 'chan',
        displayName: 'Chan',
        type: 'channel',
        channelType: 'telegram',
        platformId: 'telegram:1',
        agentGroupId: null,
      },
      { name: 'buddy', displayName: null, type: 'agent', channelType: null, platformId: null, agentGroupId: 'ag-2' },
    ]);
    const rows = db.prepare('SELECT name, type FROM destinations ORDER BY name').all();
    expect(rows).toEqual([
      { name: 'buddy', type: 'agent' },
      { name: 'chan', type: 'channel' },
    ]);
  });

  it('getInboundSourceSessionId and getMostRecentPeerSourceSessionId', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(db);
    await inbound.insertMessage({
      id: 'm-src',
      kind: 'chat',
      timestamp: now(),
      platformId: 'ag-2',
      channelType: 'agent',
      threadId: null,
      content: '{}',
      processAfter: null,
      recurrence: null,
      sourceSessionId: 'peer:ag-2:sess-2',
    });
    expect(inbound.getInboundSourceSessionId('m-src')).toBe('peer:ag-2:sess-2');
    expect(inbound.getInboundSourceSessionId('no-such-message')).toBeNull();
    expect(inbound.getMostRecentPeerSourceSessionId('ag-2')).toBe('peer:ag-2:sess-2');
    expect(inbound.getMostRecentPeerSourceSessionId('ag-nonexistent')).toBeNull();
  });
});

describe('history and conversation-root queries', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('getInboundHistory and getConversationRoot', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    const inbound = wrapSqliteInbound(db);
    await inbound.insertMessage({
      id: 'm-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'p',
      channelType: 'telegram',
      threadId: null,
      content: '{"text":"first"}',
      processAfter: null,
      recurrence: null,
    });
    const history = inbound.getInboundHistory(10);
    expect(history).toHaveLength(1);
    const root = inbound.getConversationRoot();
    expect(root?.content).toBe('{"text":"first"}');
  });

  it('getOutboundHistory reads from messages_out', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(OUTBOUND_SCHEMA);
    const outbound = wrapSqliteOutbound(
      () => db,
      () => db,
    );
    await outbound.writeDirect({
      id: 'o-hist',
      kind: 'chat',
      platformId: null,
      channelType: null,
      threadId: null,
      content: '{}',
    });
    const history = outbound.getOutboundHistory(10);
    expect(history).toHaveLength(1);

    const topLevel = outbound.getTopLevelOutbound(10);
    expect(topLevel).toHaveLength(1);
  });
});

describe('wrapSqliteOutbound edge cases', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('getContainerState returns null when no row exists', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(OUTBOUND_SCHEMA);
    const outbound = wrapSqliteOutbound(() => db);
    expect(outbound.getContainerState()).toBeNull();
  });

  it('accepts a plain database as `source` (not a factory function)', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(OUTBOUND_SCHEMA);
    // Pass the raw db, not a thunk — exercises the `typeof source === 'function' ? ... : source` false branch.
    const outbound = wrapSqliteOutbound(db);
    expect(outbound.getContainerState()).toBeNull();
  });

  it('getDueMessages with no excludeIds set includes every due row', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(OUTBOUND_SCHEMA);
    const outbound = wrapSqliteOutbound(() => db);
    await outbound.writeDirect({
      id: 'o-due',
      kind: 'chat',
      platformId: 'p',
      channelType: 'telegram',
      threadId: null,
      content: '{}',
    });
    const due = outbound.getDueMessages(undefined);
    expect(due.map((m) => m.id)).toEqual(['o-due']);
  });

  it('getDueMessages falls back to best-effort delivery for a malformed row', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(OUTBOUND_SCHEMA);
    const outbound = wrapSqliteOutbound(() => db);
    // Insert a row whose timestamp is neither a recognized SQLite timestamp
    // nor a parseable date — sqliteTimestamp() returns it unchanged, and
    // parseOutboundRecord's ISO-8601 validation then throws, forcing the
    // best-effort fallback branch.
    db.prepare(
      `INSERT INTO messages_out (id, seq, kind, timestamp, content) VALUES ('o-bad', 2, 'chat', 'not-a-real-timestamp', '{}')`,
    ).run();
    const warnSpy = vi.spyOn((await import('../../log.js')).log, 'warn').mockImplementation(() => {});
    const due = outbound.getDueMessages(undefined);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe('o-bad');
    expect(due[0].kind).toBe('chat');
    expect(warnSpy).toHaveBeenCalledWith(
      'Malformed outbound row — delivering best-effort',
      expect.objectContaining({ id: 'o-bad' }),
    );
    warnSpy.mockRestore();
  });
});

describe('SqliteAgentMailbox lifecycle methods', () => {
  const TEST_DIR = '/tmp/nanoclaw-test-sqlite-mailbox-cov';
  const key: MailboxSessionKey = { agentGroupId: 'ag-cov', sessionId: 'sess-cov' };

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('runnerContext and runnerEnvironment are no-ops for the SQLite implementation', async () => {
    const mailbox = new SqliteAgentMailbox();
    await expect(mailbox.runnerContext(key)).resolves.toBeNull();
    await expect(mailbox.runnerEnvironment(key)).resolves.toEqual({});
  });

  it('session() throws when the mailbox was never prepared', async () => {
    // No mailbox.prepare(key) call — exists() returns false, so session()
    // must reject before ever opening a DB handle (no writes, no side effects).
    const mailbox = new SqliteAgentMailbox();
    await expect(mailbox.session(key, () => 'unreachable')).rejects.toThrow('Mailbox is not prepared');
  });
});

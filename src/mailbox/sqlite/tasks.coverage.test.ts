/**
 * Coverage-uplift tests for mailbox/sqlite/tasks.ts targeting branches the
 * pre-existing tasks.test.ts suite doesn't reach: updateTask's `script`
 * merge branch, and trailingFailedRuns' break-on-completed streak boundary.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA } from './schema.js';
import { insertTaskRow, trailingFailedRuns, updateTask } from './tasks.js';

describe('updateTask script merge branch', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('merges a script field into the stored content JSON', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    insertTaskRow(db, {
      id: 't-script',
      seriesId: 's-script',
      processAfter: null,
      recurrence: null,
      content: JSON.stringify({ prompt: 'original' }),
      status: 'paused',
    });
    const changed = updateTask(db, 't-script', { script: 'echo hi' });
    expect(changed).toBe(1);
    const row = db.prepare("SELECT content FROM messages_in WHERE id = 't-script'").get() as { content: string };
    expect(JSON.parse(row.content)).toEqual({ prompt: 'original', script: 'echo hi' });
  });

  it('sets processAfter and recurrence independently of content merge', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    insertTaskRow(db, {
      id: 't-fields',
      seriesId: 's-fields',
      processAfter: null,
      recurrence: null,
      content: JSON.stringify({ prompt: 'p' }),
      status: 'paused',
    });
    const future = new Date(Date.now() + 60_000).toISOString();
    const changed = updateTask(db, 't-fields', { processAfter: future, recurrence: '0 * * * *' });
    expect(changed).toBe(1);
    const row = db.prepare("SELECT process_after, recurrence FROM messages_in WHERE id = 't-fields'").get() as {
      process_after: string;
      recurrence: string;
    };
    expect(row.process_after).toBe(future);
    expect(row.recurrence).toBe('0 * * * *');
  });

  it('returns 0 when no live row matches (already completed/failed, or non-existent)', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    expect(updateTask(db, 'no-such-task', { prompt: 'x' })).toBe(0);
  });
});

describe('trailingFailedRuns', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('stops counting at the first completed occurrence walking backwards', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    // Oldest -> newest: completed, failed, failed (2 trailing failures).
    insertTaskRow(db, { id: 't-1', seriesId: 's-streak', processAfter: null, recurrence: null, content: '{}' }, 2);
    db.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 't-1'").run();
    insertTaskRow(db, { id: 't-2', seriesId: 's-streak', processAfter: null, recurrence: null, content: '{}' }, 4);
    db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = 't-2'").run();
    insertTaskRow(db, { id: 't-3', seriesId: 's-streak', processAfter: null, recurrence: null, content: '{}' }, 6);
    db.prepare("UPDATE messages_in SET status = 'failed' WHERE id = 't-3'").run();

    expect(trailingFailedRuns(db, 's-streak')).toBe(2);
  });

  it('returns 0 when the series has no completed/failed occurrences', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    insertTaskRow(db, { id: 't-pending', seriesId: 's-pending', processAfter: null, recurrence: null, content: '{}' });
    expect(trailingFailedRuns(db, 's-pending')).toBe(0);
  });
});

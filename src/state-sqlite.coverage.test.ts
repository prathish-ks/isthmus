/**
 * Coverage-uplift tests for state-sqlite.ts targeting branches the
 * pre-existing state-sqlite.test.ts suite doesn't reach: expired-key lazy
 * deletion in get()/setIfNotExists(), extendLock's false-return path,
 * forceReleaseLock, appendToList's unique-violation retry, and the
 * maxLength-cutoff deletion branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { initTestDb, closeDb, getDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { SqliteStateAdapter } from './state-sqlite.js';
import * as dbErrors from './db/errors.js';

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
});

async function makeAdapter(namespace?: string): Promise<SqliteStateAdapter> {
  const state = new SqliteStateAdapter(namespace);
  await state.connect();
  return state;
}

describe('expired-key lazy deletion', () => {
  it('get() deletes and returns null for a KV row past its TTL', async () => {
    const state = await makeAdapter();
    await state.set('expiring', { v: 1 }, -1000); // already expired
    expect(await state.get('expiring')).toBeNull();
    const row = await getDb().get('SELECT 1 FROM chat_sdk_kv WHERE key = ?', 'expiring');
    expect(row).toBeUndefined();
  });

  it('setIfNotExists() lazily deletes an expired existing row before writing the new one', async () => {
    const state = await makeAdapter();
    await state.set('willexpire', { v: 'old' }, -1000);
    const set = await state.setIfNotExists('willexpire', { v: 'new' });
    expect(set).toBe(true);
    expect(await state.get('willexpire')).toEqual({ v: 'new' });
  });
});

describe('lock lifecycle branches', () => {
  it('extendLock returns false when the lock no longer matches (already released/expired)', async () => {
    const state = await makeAdapter();
    const lock = await state.acquireLock('thread-1', 60_000);
    expect(lock).not.toBeNull();
    await state.releaseLock(lock!);
    const extended = await state.extendLock(lock!, 60_000);
    expect(extended).toBe(false);
  });

  it('forceReleaseLock removes a lock regardless of token', async () => {
    const state = await makeAdapter();
    const lock = await state.acquireLock('thread-2', 60_000);
    expect(lock).not.toBeNull();
    await state.forceReleaseLock('thread-2');
    // A fresh acquire should now succeed (the old lock is gone).
    const reacquired = await state.acquireLock('thread-2', 60_000);
    expect(reacquired).not.toBeNull();
  });
});

describe('appendToList branches', () => {
  it('deletes overflow entries past maxLength', async () => {
    const state = await makeAdapter();
    for (let i = 0; i < 5; i++) {
      await state.appendToList('capped', `item-${i}`, { maxLength: 3 });
    }
    const list = await state.getList<string>('capped');
    expect(list).toEqual(['item-2', 'item-3', 'item-4']);
  });

  it('retries past a unique-constraint race and eventually succeeds', async () => {
    const state = await makeAdapter();
    const spy = vi.spyOn(dbErrors, 'isUniqueViolation').mockReturnValueOnce(true).mockReturnValue(false);
    const db = getDb();
    const originalTransaction = db.transaction.bind(db);
    let call = 0;
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation(async (fn: () => Promise<unknown>) => {
      call++;
      if (call === 1) {
        throw Object.assign(new Error('simulated race'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
      return originalTransaction(fn);
    });
    await state.appendToList('raced', 'value-1');
    expect(call).toBe(2);
    const list = await state.getList<string>('raced');
    expect(list).toEqual(['value-1']);
    txSpy.mockRestore();
    spy.mockRestore();
  });

  it('rethrows a non-unique-violation transaction error', async () => {
    const state = await makeAdapter();
    const db = getDb();
    const err = new Error('disk full');
    const txSpy = vi.spyOn(db, 'transaction').mockRejectedValueOnce(err);
    await expect(state.appendToList('boom', 'value')).rejects.toBe(err);
    txSpy.mockRestore();
  });
});

describe('queue depth', () => {
  it('queueDepth returns 0 for a thread with no queued entries', async () => {
    const state = await makeAdapter();
    expect(await state.queueDepth('empty-thread')).toBe(0);
  });

  it('enqueue/dequeue round trip updates queueDepth', async () => {
    const state = await makeAdapter();
    const depth = await state.enqueue('thread-q', { id: 'e1' } as never, 10);
    expect(depth).toBe(1);
    const item = await state.dequeue('thread-q');
    expect(item).toEqual({ id: 'e1' });
    expect(await state.queueDepth('thread-q')).toBe(0);
  });
});

/** Coverage tests for the users DB helpers not driven elsewhere: getAllUsers, updateDisplayName, deleteUser. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../../db/index.js';
import { createUser, deleteUser, getAllUsers, getUser, updateDisplayName, upsertUser } from './users.js';

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('users helpers', () => {
  it('getAllUsers lists users ordered by created_at', async () => {
    await createUser({ id: 'tg:b', kind: 'tg', display_name: 'B', created_at: '2026-01-02T00:00:00.000Z' });
    await createUser({ id: 'tg:a', kind: 'tg', display_name: 'A', created_at: '2026-01-01T00:00:00.000Z' });
    expect((await getAllUsers()).map((u) => u.id)).toEqual(['tg:a', 'tg:b']);
  });

  it('updateDisplayName rewrites the name in place', async () => {
    await createUser({ id: 'tg:a', kind: 'tg', display_name: null, created_at: '2026-01-01T00:00:00.000Z' });
    await updateDisplayName('tg:a', 'Alice');
    expect((await getUser('tg:a'))?.display_name).toBe('Alice');
  });

  it('upsertUser keeps an existing display_name when the new one is null', async () => {
    await createUser({ id: 'tg:a', kind: 'tg', display_name: 'Alice', created_at: '2026-01-01T00:00:00.000Z' });
    await upsertUser({ id: 'tg:a', kind: 'tg', display_name: null, created_at: '2026-02-01T00:00:00.000Z' });
    expect((await getUser('tg:a'))?.display_name).toBe('Alice');
  });

  it('deleteUser removes the row', async () => {
    await createUser({ id: 'tg:a', kind: 'tg', display_name: null, created_at: '2026-01-01T00:00:00.000Z' });
    await deleteUser('tg:a');
    expect(await getUser('tg:a')).toBeUndefined();
    expect(await getAllUsers()).toEqual([]);
  });
});

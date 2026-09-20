/** Coverage tests for the user_dms cache helpers not driven elsewhere: getUserDmsForUser + deleteUserDm. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createMessagingGroup, initTestDb, runMigrations } from '../../../db/index.js';
import { deleteUserDm, getUserDm, getUserDmsForUser, upsertUserDm } from './user-dms.js';
import { createUser } from './users.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createUser({ id: 'tg:a', kind: 'tg', display_name: null, created_at: now() });
  for (const [id, channel] of [
    ['mg-tg', 'tg'],
    ['mg-sl', 'sl'],
    ['mg-tg2', 'tg'],
  ]) {
    await createMessagingGroup({
      id,
      channel_type: channel,
      platform_id: `p-${id}`,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
  }
});

afterEach(async () => {
  await closeDb();
});

describe('user_dms helpers', () => {
  it('getUserDmsForUser returns one row per channel; upsert replaces the mapping', async () => {
    await upsertUserDm({ user_id: 'tg:a', channel_type: 'tg', messaging_group_id: 'mg-tg', resolved_at: now() });
    await upsertUserDm({ user_id: 'tg:a', channel_type: 'sl', messaging_group_id: 'mg-sl', resolved_at: now() });
    expect((await getUserDmsForUser('tg:a')).map((r) => r.channel_type).sort()).toEqual(['sl', 'tg']);

    await upsertUserDm({ user_id: 'tg:a', channel_type: 'tg', messaging_group_id: 'mg-tg2', resolved_at: now() });
    expect(await getUserDmsForUser('tg:a')).toHaveLength(2);
    expect((await getUserDm('tg:a', 'tg'))?.messaging_group_id).toBe('mg-tg2');
    expect(await getUserDmsForUser('tg:nobody')).toEqual([]);
  });

  it('deleteUserDm removes only that channel mapping', async () => {
    await upsertUserDm({ user_id: 'tg:a', channel_type: 'tg', messaging_group_id: 'mg-tg', resolved_at: now() });
    await upsertUserDm({ user_id: 'tg:a', channel_type: 'sl', messaging_group_id: 'mg-sl', resolved_at: now() });
    await deleteUserDm('tg:a', 'tg');
    expect(await getUserDm('tg:a', 'tg')).toBeUndefined();
    expect((await getUserDmsForUser('tg:a')).map((r) => r.channel_type)).toEqual(['sl']);
  });
});

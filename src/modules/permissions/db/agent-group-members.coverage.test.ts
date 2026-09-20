/** Coverage tests for the agent_group_members DB helpers not driven by permissions.test.ts. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../../db/index.js';
import { addMember, getMembers, hasMembershipRow, isMember, removeMember } from './agent-group-members.js';
import { grantRole } from './user-roles.js';
import { createUser } from './users.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'AG1', folder: 'ag-1', agent_provider: null, created_at: now() });
  await createUser({ id: 'tg:a', kind: 'tg', display_name: null, created_at: now() });
  await createUser({ id: 'tg:b', kind: 'tg', display_name: null, created_at: now() });
});

afterEach(async () => {
  await closeDb();
});

describe('agent_group_members helpers', () => {
  it('getMembers lists rows ordered by added_at; addMember is idempotent', async () => {
    await addMember({
      user_id: 'tg:b',
      agent_group_id: 'ag-1',
      added_by: 'tg:a',
      added_at: '2026-01-02T00:00:00.000Z',
    });
    await addMember({ user_id: 'tg:a', agent_group_id: 'ag-1', added_by: null, added_at: '2026-01-01T00:00:00.000Z' });
    await addMember({ user_id: 'tg:a', agent_group_id: 'ag-1', added_by: null, added_at: '2026-01-03T00:00:00.000Z' }); // conflict → no-op

    const members = await getMembers('ag-1');
    expect(members.map((m) => m.user_id)).toEqual(['tg:a', 'tg:b']);
    expect(members[0].added_at).toBe('2026-01-01T00:00:00.000Z');
    expect(members[1].added_by).toBe('tg:a');
    expect(await getMembers('ag-none')).toEqual([]);
  });

  it('removeMember deletes exactly the (user, group) row', async () => {
    await addMember({ user_id: 'tg:a', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    await addMember({ user_id: 'tg:b', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    await removeMember('tg:a', 'ag-1');
    expect((await getMembers('ag-1')).map((m) => m.user_id)).toEqual(['tg:b']);
    expect(await hasMembershipRow('tg:a', 'ag-1')).toBe(false);
  });

  it('hasMembershipRow ignores the implicit owner/admin membership that isMember honors', async () => {
    await grantRole({ user_id: 'tg:a', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(await isMember('tg:a', 'ag-1')).toBe(true);
    expect(await hasMembershipRow('tg:a', 'ag-1')).toBe(false);

    await addMember({ user_id: 'tg:b', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(await hasMembershipRow('tg:b', 'ag-1')).toBe(true);
    expect(await isMember('tg:b', 'ag-1')).toBe(true);
  });
});

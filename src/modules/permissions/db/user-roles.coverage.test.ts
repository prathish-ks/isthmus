/** Coverage tests for the user_roles helpers not driven by permissions.test.ts: revokeRole + getUserRoles. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../../db/index.js';
import {
  getAdminsOfAgentGroup,
  getGlobalAdmins,
  getUserRoles,
  grantRole,
  isAdminOfAgentGroup,
  isGlobalAdmin,
  isOwner,
  revokeRole,
} from './user-roles.js';
import { createUser } from './users.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'AG1', folder: 'ag-1', agent_provider: null, created_at: now() });
  await createUser({ id: 'tg:u', kind: 'tg', display_name: null, created_at: now() });
  await grantRole({ user_id: 'tg:u', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await grantRole({ user_id: 'tg:u', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
  await grantRole({ user_id: 'tg:u', role: 'admin', agent_group_id: 'ag-1', granted_by: 'tg:u', granted_at: now() });
});

afterEach(async () => {
  await closeDb();
});

describe('revokeRole / getUserRoles', () => {
  it('getUserRoles returns every grant for the user', async () => {
    const roles = await getUserRoles('tg:u');
    expect(roles).toHaveLength(3);
    expect(roles.map((r) => `${r.role}@${r.agent_group_id ?? 'global'}`).sort()).toEqual([
      'admin@ag-1',
      'admin@global',
      'owner@global',
    ]);
    expect(await getUserRoles('tg:nobody')).toEqual([]);
  });

  it('revokes a global role (agent_group_id null) without touching scoped grants', async () => {
    await revokeRole('tg:u', 'admin', null);
    expect(await isGlobalAdmin('tg:u')).toBe(false);
    expect(await isAdminOfAgentGroup('tg:u', 'ag-1')).toBe(true);
    expect(await isOwner('tg:u')).toBe(true);
    expect(await getGlobalAdmins()).toEqual([]);
  });

  it('revokes a scoped role without touching global grants', async () => {
    await revokeRole('tg:u', 'admin', 'ag-1');
    expect(await isAdminOfAgentGroup('tg:u', 'ag-1')).toBe(false);
    expect(await getAdminsOfAgentGroup('ag-1')).toEqual([]);
    expect(await isGlobalAdmin('tg:u')).toBe(true);
    expect(await getUserRoles('tg:u')).toHaveLength(2);
  });

  it('revoking a role that was never granted is a no-op', async () => {
    await revokeRole('tg:u', 'owner', 'ag-1');
    await revokeRole('tg:ghost', 'admin', null);
    expect(await getUserRoles('tg:u')).toHaveLength(3);
  });
});

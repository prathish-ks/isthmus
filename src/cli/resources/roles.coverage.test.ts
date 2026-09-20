import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { ResponseFrame } from '../frame.js';
// Side-effect import: registers roles-list / roles-grant / roles-revoke.
import './roles.js';

const host = { caller: 'host' as const };
const now = () => new Date().toISOString();

function run(command: string, args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: 'r', command, args }, host);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}

beforeEach(async () => {
  await runMigrations(await initTestDb({ fresh: true }));
  await createAgentGroup({ id: 'ag-1', name: 'one', folder: 'one', agent_provider: null, created_at: now() });
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at) VALUES ('tg:1', 'telegram', 'u', ?), ('tg:0', 'telegram', 'granter', ?)`,
    now(),
    now(),
  );
});
afterEach(() => closeDb());

describe('roles grant', () => {
  it('validates --user, --role, and the owner-is-global rule', async () => {
    expect(errorOf(await run('roles-grant', { role: 'admin' }))).toBe('--user is required');
    expect(errorOf(await run('roles-grant', { user: 'tg:1' }))).toBe('--role must be owner or admin');
    expect(errorOf(await run('roles-grant', { user: 'tg:1', role: 'king' }))).toBe('--role must be owner or admin');
    expect(errorOf(await run('roles-grant', { user: 'tg:1', role: 'owner', group: 'ag-1' }))).toBe(
      'owner role is always global (do not pass --group)',
    );
    expect(await getDb().all('SELECT * FROM user_roles')).toEqual([]);
  });

  it('inserts a scoped admin grant with granted_by, idempotently', async () => {
    const resp = await run('roles-grant', { user: 'tg:1', role: 'admin', group: 'ag-1', granted_by: 'tg:0' });
    expect(resp).toEqual({ id: 'r', ok: true, data: { user_id: 'tg:1', role: 'admin', agent_group_id: 'ag-1' } });
    await run('roles-grant', { user: 'tg:1', role: 'admin', group: 'ag-1' }); // ON CONFLICT DO NOTHING
    const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM user_roles');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'tg:1', role: 'admin', agent_group_id: 'ag-1', granted_by: 'tg:0' });
    expect(rows[0].granted_at).toMatch(/Z$/);
  });

  it('inserts a global owner grant with null scope and null granted_by', async () => {
    const resp = await run('roles-grant', { user: 'tg:1', role: 'owner' });
    expect(resp).toMatchObject({ ok: true, data: { user_id: 'tg:1', role: 'owner', agent_group_id: null } });
    const listed = await run('roles-list', {});
    expect(listed.ok && (listed.data as unknown[]).length).toBe(1);
    expect((await getDb().get<Record<string, unknown>>('SELECT * FROM user_roles'))!).toMatchObject({
      agent_group_id: null,
      granted_by: null,
    });
  });
});

describe('roles revoke', () => {
  it('validates flags and reports a missing grant', async () => {
    expect(errorOf(await run('roles-revoke', { role: 'admin' }))).toBe('--user is required');
    expect(errorOf(await run('roles-revoke', { user: 'tg:1' }))).toBe('--role is required');
    expect(errorOf(await run('roles-revoke', { user: 'tg:1', role: 'admin' }))).toBe('role not found');
  });

  it('revokes exactly the matching (user, role, scope) row', async () => {
    await run('roles-grant', { user: 'tg:1', role: 'admin' });
    await run('roles-grant', { user: 'tg:1', role: 'admin', group: 'ag-1' });
    // Scoped revoke leaves the global grant alone.
    const resp = await run('roles-revoke', { user: 'tg:1', role: 'admin', group: 'ag-1' });
    expect(resp).toEqual({
      id: 'r',
      ok: true,
      data: { revoked: { user_id: 'tg:1', role: 'admin', agent_group_id: 'ag-1' } },
    });
    const left = await getDb().all<{ agent_group_id: string | null }>('SELECT agent_group_id FROM user_roles');
    expect(left).toEqual([{ agent_group_id: null }]);
    // Global revoke (no --group) matches the NULL-scoped row.
    expect((await run('roles-revoke', { user: 'tg:1', role: 'admin' })).ok).toBe(true);
    expect(await getDb().all('SELECT * FROM user_roles')).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { ResponseFrame } from '../frame.js';
// Side-effect import: registers members-list / members-add / members-remove.
import './members.js';

const host = { caller: 'host' as const };
const now = () => new Date().toISOString();

function run(command: string, args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: 'm', command, args }, host);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}

beforeEach(async () => {
  await runMigrations(await initTestDb({ fresh: true }));
  await createAgentGroup({ id: 'ag-1', name: 'one', folder: 'one', agent_provider: null, created_at: now() });
  await getDb().run(
    `INSERT INTO users (id, kind, display_name, created_at) VALUES ('tg:1', 'telegram', 'u', ?), ('tg:0', 'telegram', 'adder', ?)`,
    now(),
    now(),
  );
});
afterEach(() => closeDb());

describe('members add', () => {
  it('requires --user and --group', async () => {
    expect(errorOf(await run('members-add', { group: 'ag-1' }))).toBe('--user is required');
    expect(errorOf(await run('members-add', { user: 'tg:1' }))).toBe('--group is required');
    expect(await getDb().all('SELECT * FROM agent_group_members')).toEqual([]);
  });

  it('inserts the membership (with optional --added-by) and is idempotent on the pair', async () => {
    const resp = await run('members-add', { user: 'tg:1', group: 'ag-1', 'added-by': 'tg:0' });
    expect(resp).toEqual({ id: 'm', ok: true, data: { user_id: 'tg:1', agent_group_id: 'ag-1' } });
    expect((await run('members-add', { user: 'tg:1', group: 'ag-1' })).ok).toBe(true);
    const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM agent_group_members');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'tg:1', agent_group_id: 'ag-1', added_by: 'tg:0' });
    expect(rows[0].added_at).toMatch(/Z$/);
    const listed = await run('members-list', { agent_group_id: 'ag-1' });
    expect(listed.ok && (listed.data as Array<{ user_id: string }>).map((r) => r.user_id)).toEqual(['tg:1']);
  });

  it('stores null added_by when omitted', async () => {
    await run('members-add', { user: 'tg:1', group: 'ag-1' });
    expect((await getDb().get<{ added_by: unknown }>('SELECT added_by FROM agent_group_members'))!.added_by).toBeNull();
  });
});

describe('members remove', () => {
  it('requires --user and --group and reports a missing membership', async () => {
    expect(errorOf(await run('members-remove', { group: 'ag-1' }))).toBe('--user is required');
    expect(errorOf(await run('members-remove', { user: 'tg:1' }))).toBe('--group is required');
    expect(errorOf(await run('members-remove', { user: 'tg:1', group: 'ag-1' }))).toBe('member not found');
  });

  it('deletes the membership row', async () => {
    await run('members-add', { user: 'tg:1', group: 'ag-1' });
    const resp = await run('members-remove', { user: 'tg:1', group: 'ag-1' });
    expect(resp).toEqual({ id: 'm', ok: true, data: { removed: { user_id: 'tg:1', agent_group_id: 'ag-1' } } });
    expect(await getDb().all('SELECT * FROM agent_group_members')).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { getMessagePolicy } from '../../modules/agent-to-agent/db/agent-message-policies.js';
import { dispatch } from '../dispatch.js';
import type { ResponseFrame } from '../frame.js';
// Side-effect import: registers policies-list / policies-set / policies-remove.
import './policies.js';

const host = { caller: 'host' as const };
const now = () => new Date().toISOString();

function run(command: string, args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: 'p', command, args }, host);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}

beforeEach(async () => {
  await runMigrations(await initTestDb({ fresh: true }));
  await createAgentGroup({ id: 'ag-a', name: 'a', folder: 'a', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-b', name: 'b', folder: 'b', agent_provider: null, created_at: now() });
});
afterEach(() => closeDb());

describe('policies set', () => {
  it('validates every flag, the self-pair, and that both groups exist', async () => {
    expect(errorOf(await run('policies-set', { to: 'ag-b', approver: 'u' }))).toBe('--from is required');
    expect(errorOf(await run('policies-set', { from: 'ag-a', approver: 'u' }))).toBe('--to is required');
    expect(errorOf(await run('policies-set', { from: 'ag-a', to: 'ag-b' }))).toBe('--approver is required');
    expect(errorOf(await run('policies-set', { from: 'ag-a', to: 'ag-a', approver: 'u' }))).toBe(
      '--from and --to must differ (self-messages are never gated)',
    );
    expect(errorOf(await run('policies-set', { from: 'ag-x', to: 'ag-b', approver: 'u' }))).toBe(
      'source agent group not found: ag-x',
    );
    expect(errorOf(await run('policies-set', { from: 'ag-a', to: 'ag-y', approver: 'u' }))).toBe(
      'target agent group not found: ag-y',
    );
    expect(await getDb().all('SELECT * FROM agent_message_policies')).toEqual([]);
  });

  it('writes the directed policy row and lists it', async () => {
    const resp = await run('policies-set', { from: 'ag-a', to: 'ag-b', approver: 'tg:admin' });
    expect(resp).toEqual({
      id: 'p',
      ok: true,
      data: { from_agent_group_id: 'ag-a', to_agent_group_id: 'ag-b', approver: 'tg:admin' },
    });
    expect(await getMessagePolicy('ag-a', 'ag-b')).toMatchObject({ approver: 'tg:admin' });
    // Directed: the reverse pair stays ungated.
    expect(await getMessagePolicy('ag-b', 'ag-a')).toBeUndefined();
    const listed = await run('policies-list', {});
    expect(listed.ok && (listed.data as unknown[]).length).toBe(1);
  });
});

describe('policies remove', () => {
  it('validates flags and reports a missing policy', async () => {
    expect(errorOf(await run('policies-remove', { to: 'ag-b' }))).toBe('--from is required');
    expect(errorOf(await run('policies-remove', { from: 'ag-a' }))).toBe('--to is required');
    expect(errorOf(await run('policies-remove', { from: 'ag-a', to: 'ag-b' }))).toBe('policy not found');
  });

  it('removes the row and returns the pair', async () => {
    await run('policies-set', { from: 'ag-a', to: 'ag-b', approver: 'tg:admin' });
    const resp = await run('policies-remove', { from: 'ag-a', to: 'ag-b' });
    expect(resp).toEqual({
      id: 'p',
      ok: true,
      data: { removed: { from_agent_group_id: 'ag-a', to_agent_group_id: 'ag-b' } },
    });
    expect(await getMessagePolicy('ag-a', 'ag-b')).toBeUndefined();
  });
});

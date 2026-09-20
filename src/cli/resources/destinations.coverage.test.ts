import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  writeDestinations: vi.fn(),
  hasTableOverride: null as null | boolean,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../log.js', () => ({ log: state.log }));
vi.mock('../../modules/agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (...args: unknown[]) => state.writeDestinations(...args),
}));
vi.mock('../../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/connection.js')>('../../db/connection.js');
  return {
    ...actual,
    hasTable: async (db: unknown, table: string) =>
      state.hasTableOverride !== null && table === 'agent_destinations'
        ? state.hasTableOverride
        : actual.hasTable(db as never, table),
  };
});

import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, ResponseFrame } from '../frame.js';
import { projectDestinationsToSessions } from './destinations.js';

const host: CallerContext = { caller: 'host' };
const now = () => new Date().toISOString();

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = host): Promise<ResponseFrame> {
  return dispatch({ id: 'd', command, args }, ctx);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.hasTableOverride = null;
  state.writeDestinations.mockResolvedValue(undefined);
  await runMigrations(await initTestDb({ fresh: true }));
  await createAgentGroup({ id: 'ag-a', name: 'Agent A', folder: 'a', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-b', name: 'Agent B', folder: 'b', agent_provider: null, created_at: now() });
  await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
     VALUES ('mg-1', 'telegram', 'chat-1', 'telegram', 'Team Chat', 1, 'strict', ?)`,
    now(),
  );
  await createSession({
    id: 'sess-a1',
    agent_group_id: 'ag-a',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
});
afterEach(() => closeDb());

describe('projectDestinationsToSessions', () => {
  it('returns early without projecting when the agent_destinations table is absent', async () => {
    state.hasTableOverride = false;
    await projectDestinationsToSessions('ag-a');
    expect(state.writeDestinations).not.toHaveBeenCalled();
  });

  it('projects into every session of the group and logs (not throws) per-session failures', async () => {
    await createSession({
      id: 'sess-a2',
      agent_group_id: 'ag-a',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    state.writeDestinations.mockRejectedValueOnce(new Error('mailbox missing'));
    await expect(projectDestinationsToSessions('ag-a')).resolves.toBeUndefined();
    expect(state.writeDestinations).toHaveBeenCalledTimes(2);
    expect(state.writeDestinations).toHaveBeenCalledWith('ag-a', 'sess-a1');
    expect(state.writeDestinations).toHaveBeenCalledWith('ag-a', 'sess-a2');
    expect(state.log.warn).toHaveBeenCalledTimes(1);
    expect(state.log.warn).toHaveBeenCalledWith(
      'Failed to project destinations to session mailbox',
      expect.objectContaining({ agentGroupId: 'ag-a', err: expect.any(Error) }),
    );
  });
});

describe('destinations add', () => {
  it('validates every flag', async () => {
    const base = { agent_group_id: 'ag-a', local_name: 'chat', target_type: 'channel', target_id: 'mg-1' };
    expect(errorOf(await run('destinations-add', { ...base, agent_group_id: undefined }))).toBe(
      '--agent-group-id is required',
    );
    expect(errorOf(await run('destinations-add', { ...base, local_name: undefined }))).toBe('--local-name is required');
    expect(errorOf(await run('destinations-add', { ...base, target_type: undefined }))).toBe(
      '--target-type must be channel or agent',
    );
    expect(errorOf(await run('destinations-add', { ...base, target_type: 'email' }))).toBe(
      '--target-type must be channel or agent',
    );
    expect(errorOf(await run('destinations-add', { ...base, target_id: undefined }))).toBe('--target-id is required');
    expect(await getDb().all('SELECT * FROM agent_destinations')).toEqual([]);
    expect(state.writeDestinations).not.toHaveBeenCalled();
  });

  it('inserts the row and projects it into live sessions', async () => {
    const resp = await run('destinations-add', {
      'agent-group-id': 'ag-a',
      'local-name': 'team',
      'target-type': 'channel',
      'target-id': 'mg-1',
    });
    expect(resp).toEqual({
      id: 'd',
      ok: true,
      data: { agent_group_id: 'ag-a', local_name: 'team', target_type: 'channel', target_id: 'mg-1' },
    });
    expect(state.writeDestinations).toHaveBeenCalledWith('ag-a', 'sess-a1');
  });
});

describe('destinations list', () => {
  beforeEach(async () => {
    await run('destinations-add', {
      agent_group_id: 'ag-a',
      local_name: 'team',
      target_type: 'channel',
      target_id: 'mg-1',
    });
    await run('destinations-add', {
      agent_group_id: 'ag-a',
      local_name: 'buddy',
      target_type: 'agent',
      target_id: 'ag-b',
    });
    await run('destinations-add', {
      agent_group_id: 'ag-b',
      local_name: 'peer',
      target_type: 'agent',
      target_id: 'ag-a',
    });
  });

  it('lists everything with resolved labels when unfiltered, ordered by agent then name', async () => {
    const resp = await run('destinations-list', {});
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    expect(resp.data).toEqual([
      expect.objectContaining({
        agent_group_id: 'ag-a',
        local_name: 'buddy',
        channel_type: null,
        display_name: 'Agent B',
      }),
      expect.objectContaining({
        agent_group_id: 'ag-a',
        local_name: 'team',
        channel_type: 'telegram',
        display_name: 'Team Chat',
      }),
      expect.objectContaining({ agent_group_id: 'ag-b', local_name: 'peer', display_name: 'Agent A' }),
    ]);
  });

  it('filters by --agent-group-id, or by the auto-filled --id for a group-scoped agent', async () => {
    const byFlag = await run('destinations-list', { agent_group_id: 'ag-b' });
    expect(byFlag.ok && (byFlag.data as Array<{ local_name: string }>).map((r) => r.local_name)).toEqual(['peer']);

    const agent: CallerContext = { caller: 'agent', agentGroupId: 'ag-a', sessionId: 'sess-a1', messagingGroupId: '' };
    const scoped = await run('destinations-list', {}, agent);
    expect(scoped.ok && (scoped.data as Array<{ local_name: string }>).map((r) => r.local_name)).toEqual([
      'buddy',
      'team',
    ]);
  });
});

describe('destinations remove', () => {
  it('validates flags and reports a missing row without projecting', async () => {
    expect(errorOf(await run('destinations-remove', { local_name: 'x' }))).toBe('--agent-group-id is required');
    expect(errorOf(await run('destinations-remove', { agent_group_id: 'ag-a' }))).toBe('--local-name is required');
    expect(errorOf(await run('destinations-remove', { agent_group_id: 'ag-a', local_name: 'x' }))).toBe(
      'destination not found',
    );
    expect(state.writeDestinations).not.toHaveBeenCalled();
  });

  it('deletes the row and re-projects', async () => {
    await run('destinations-add', {
      agent_group_id: 'ag-a',
      local_name: 'team',
      target_type: 'channel',
      target_id: 'mg-1',
    });
    state.writeDestinations.mockClear();
    const resp = await run('destinations-remove', { agent_group_id: 'ag-a', local_name: 'team' });
    expect(resp).toEqual({ id: 'd', ok: true, data: { removed: { agent_group_id: 'ag-a', local_name: 'team' } } });
    expect(await getDb().all('SELECT * FROM agent_destinations')).toEqual([]);
    expect(state.writeDestinations).toHaveBeenCalledWith('ag-a', 'sess-a1');
  });
});

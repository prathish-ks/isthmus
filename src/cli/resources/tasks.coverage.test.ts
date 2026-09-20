/**
 * `ncl tasks *` paths the sibling tasks.test.ts leaves open: host-side
 * group/session selection, get with run-log tail, pause/resume/cancel/run
 * mutations and their no-match errors, update of process_after/script,
 * delete of a running task and of a legacy shared-session task, and the
 * handler-level normalizers that strict arg validation normally shields.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TEST_DIR = vi.hoisted(
  () => `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/ncl-cov-C-tasks-${process.pid}`,
);

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups`, TIMEZONE: 'UTC' };
});
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { isContainerRunning } from '../../container-runner.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession, getSession, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { initSessionFolder, withMailboxSession } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, ResponseFrame } from '../frame.js';
import { lookup } from '../registry.js';
import './tasks.js';

const host: CallerContext = { caller: 'host' };
const now = () => new Date().toISOString();
const agentCtx = (group = 'ag-1', session = 'chat-1'): CallerContext => ({
  caller: 'agent',
  agentGroupId: group,
  sessionId: session,
  messagingGroupId: 'mg-1',
});

function run(command: string, args: Record<string, unknown>, ctx: CallerContext = host): Promise<ResponseFrame> {
  return dispatch({ id: 't', command, args }, ctx);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}
function dataOf<T>(resp: ResponseFrame): T {
  if (!resp.ok) throw new Error(`unexpected error: ${resp.error.message}`);
  return resp.data as T;
}
const handler = (verb: string) => lookup(`tasks-${verb}`)!.handler;

async function createGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

async function createChatSession(group: string, id: string, threadId: string | null = null): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

type Created = { series_id: string; session_id: string; status: string };

async function createTask(group: string, name: string, extra: Record<string, unknown> = {}): Promise<Created> {
  return dataOf<Created>(
    await run('tasks-create', { group, name, prompt: `do ${name}`, process_after: '2999-01-01T00:00:00Z', ...extra }),
  );
}

beforeEach(async () => {
  vi.mocked(isContainerRunning).mockReturnValue(false);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb({ fresh: true }));
  await createGroup('ag-1');
  await createGroup('ag-2');
  await createChatSession('ag-1', 'chat-1');
  await createChatSession('ag-2', 'chat-2');
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('create', () => {
  it('host callers must name the group', async () => {
    expect(errorOf(await run('tasks-create', { prompt: 'x', process_after: '2999-01-01T00:00:00Z' }))).toBe(
      '--group is required',
    );
  });

  it('accepts --agent-group-id as the group spelling for host callers', async () => {
    const created = dataOf<Created & { agent_group_id: string; origin_session_id: string | null }>(
      await run('tasks-create', { agent_group_id: 'ag-2', prompt: 'x', process_after: '2999-01-01T00:00:00Z' }),
    );
    expect(created.agent_group_id).toBe('ag-2');
    expect(created.origin_session_id).toBeNull(); // CLI-created
  });

  it('handler-level guards: prompt is required even when validation is bypassed', async () => {
    await expect(handler('create')({ group: 'ag-1' }, host)).rejects.toThrow('--prompt is required');
  });
});

describe('list selection', () => {
  it('host: --group limits to that group; no flags spans every active session', async () => {
    await createTask('ag-1', 'one');
    await createTask('ag-2', 'two');
    const one = dataOf<Array<{ series_id: string }>>(await run('tasks-list', { group: 'ag-1' }));
    expect(one.map((r) => r.series_id.split('-')[0])).toEqual(['one']);
    const all = dataOf<Array<{ series_id: string }>>(await run('tasks-list', { all: true }));
    expect(all.map((r) => r.series_id.split('-')[0]).sort()).toEqual(['one', 'two']);
  });

  it('--session scopes to one session, rejects unknown ids, and hides foreign sessions from agents', async () => {
    const t = await createTask('ag-1', 'one');
    const rows = dataOf<Array<{ series_id: string }>>(await run('tasks-list', { session: t.session_id }));
    expect(rows.map((r) => r.series_id)).toEqual([t.series_id]);
    expect(errorOf(await run('tasks-list', { session: 'sess-ghost' }))).toBe('session not found: sess-ghost');
    expect(errorOf(await run('tasks-list', { session: t.session_id }, agentCtx('ag-2', 'chat-2')))).toBe(
      `session not found: ${t.session_id}`,
    );
  });

  it('--status filters live state; an unknown status is rejected at the handler too', async () => {
    const t = await createTask('ag-1', 'one');
    await createTask('ag-1', 'two');
    await run('tasks-pause', { id: t.series_id, group: 'ag-1' });
    const paused = dataOf<Array<{ series_id: string; status: string }>>(
      await run('tasks-list', { group: 'ag-1', status: 'paused' }),
    );
    expect(paused).toEqual([expect.objectContaining({ series_id: t.series_id, status: 'paused' })]);
    await expect(handler('list')({ group: 'ag-1', status: 'done' }, host)).rejects.toThrow(
      '--status must be pending or paused',
    );
  });
});

describe('get', () => {
  it('returns the full task with run stats and the tail of its run log', async () => {
    const t = await createTask('ag-1', 'brief', { script: 'echo {}' });
    await run('tasks-append-log', { id: t.series_id, group: 'ag-1', msg: 'first note' });
    await run('tasks-append-log', { id: t.series_id, group: 'ag-1', msg: 'second note' });
    const got = dataOf<Record<string, unknown>>(await run('tasks-get', { id: t.series_id, group: 'ag-1' }));
    expect(got).toMatchObject({
      series_id: t.series_id,
      session_id: t.session_id,
      prompt: 'do brief',
      script: 'echo {}',
      has_script: 1,
      completed_runs: 0,
      failed_runs: 0,
      origin_session_id: null,
    });
    expect(got).not.toHaveProperty('series_key');
    const log = got.recent_log as string[];
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/ — first note$/);
    expect(log[1]).toMatch(/ — second note$/);
  });

  it('returns an empty recent_log when no run log exists yet', async () => {
    const t = await createTask('ag-1', 'quiet');
    expect(
      dataOf<{ recent_log: string[] }>(await run('tasks-get', { id: t.series_id, group: 'ag-1' })).recent_log,
    ).toEqual([]);
  });

  it('handler-level guard: an empty id is rejected', async () => {
    await expect(handler('get')({ id: '', group: 'ag-1' }, host)).rejects.toThrow('task series id is required');
  });
});

describe('append-log', () => {
  it('requires --msg at the handler and a resolvable group for host callers', async () => {
    await expect(handler('append-log')({ id: 'x' }, host)).rejects.toThrow('--msg is required');
    expect(errorOf(await run('tasks-append-log', { id: 'some-id', msg: 'note' }))).toBe(
      'could not resolve the agent group',
    );
  });
});

describe('pause / resume', () => {
  it('pauses then resumes a series, counting touched rows, and errors when nothing matches', async () => {
    const t = await createTask('ag-1', 'p');
    expect(dataOf(await run('tasks-pause', { id: t.series_id, group: 'ag-1' }))).toEqual({
      series_id: t.series_id,
      touched: 1,
    });
    expect(errorOf(await run('tasks-pause', { id: t.series_id, group: 'ag-1' }))).toBe(
      `no live task matched: ${t.series_id}`,
    );
    expect(dataOf(await run('tasks-resume', { id: t.series_id, group: 'ag-1' }))).toEqual({
      series_id: t.series_id,
      touched: 1,
    });
    expect(errorOf(await run('tasks-resume', { id: 'ghost', group: 'ag-1' }))).toBe('no live task matched: ghost');
  });
});

describe('cancel', () => {
  it('cancels one series by id, or every live task in scope with --all', async () => {
    const a = await createTask('ag-1', 'a');
    const b = await createTask('ag-1', 'b');
    await createTask('ag-2', 'c');
    expect(dataOf(await run('tasks-cancel', { id: a.series_id, group: 'ag-1' }))).toEqual({
      series_id: a.series_id,
      touched: 1,
    });
    expect(dataOf(await run('tasks-cancel', { all: true, group: 'ag-1' }))).toEqual({ cancelled: 1 });
    const left = dataOf<Array<{ agent_group_id: string }>>(await run('tasks-list', {}));
    expect(left.map((r) => r.agent_group_id)).toEqual(['ag-2']);
    expect(errorOf(await run('tasks-cancel', { id: b.series_id, group: 'ag-1' }))).toBe(
      `no live task matched: ${b.series_id}`,
    );
  });

  it('without --all, an id is required', async () => {
    expect(errorOf(await run('tasks-cancel', { group: 'ag-1' }))).toBe('task series id is required');
  });
});

describe('run', () => {
  it('reports unknown series', async () => {
    expect(errorOf(await run('tasks-run', { id: 'ghost', group: 'ag-1' }))).toBe('task not found: ghost');
  });
});

describe('update', () => {
  it('rejects an empty update set and unknown series', async () => {
    const t = await createTask('ag-1', 'u');
    expect(errorOf(await run('tasks-update', { id: t.series_id, group: 'ag-1' }))).toBe('nothing to update');
    expect(errorOf(await run('tasks-update', { id: 'ghost', group: 'ag-1', prompt: 'p' }))).toBe(
      'no live task matched: ghost',
    );
  });

  it('updates process_after (in the group timezone), script, and clears script with "none"', async () => {
    const t = await createTask('ag-1', 'u');
    const resp = dataOf<{ fields: string[]; touched: number }>(
      await run('tasks-update', {
        id: t.series_id,
        group: 'ag-1',
        'process-after': '2999-06-01 10:30',
        script: 'echo {"wakeAgent":false}',
      }),
    );
    expect(resp).toEqual({ series_id: t.series_id, touched: 1, fields: ['processAfter', 'script'] });
    let got = dataOf<{ process_after: string; script: string | null }>(
      await run('tasks-get', { id: t.series_id, group: 'ag-1' }),
    );
    expect(got.process_after).toBe('2999-06-01T10:30:00.000Z');
    expect(got.script).toBe('echo {"wakeAgent":false}');

    await run('tasks-update', { id: t.series_id, group: 'ag-1', script: 'none' });
    got = dataOf(await run('tasks-get', { id: t.series_id, group: 'ag-1' }));
    expect(got.script).toBeNull();
  });

  it('handler-level normalizer: null and non-string values are coerced before the update', async () => {
    const t = await createTask('ag-1', 'n');
    // null → explicit clear; a number → its string form.
    const out = (await handler('update')({ id: t.series_id, group: 'ag-1', script: null, prompt: 'p' }, host)) as {
      fields: string[];
    };
    expect(out.fields).toEqual(['prompt', 'script']);
    await expect(handler('update')({ id: t.series_id, group: 'ag-1', recurrence: 5 }, host)).rejects.toThrow();
  });
});

describe('delete', () => {
  it('reports unknown series', async () => {
    expect(errorOf(await run('tasks-delete', { id: 'ghost', group: 'ag-1' }))).toBe('no task matched: ghost');
  });

  it('refuses while the task container is running', async () => {
    const t = await createTask('ag-1', 'busy');
    vi.mocked(isContainerRunning).mockReturnValue(true);
    expect(errorOf(await run('tasks-delete', { id: t.series_id, group: 'ag-1' }))).toBe(
      `task is running; wait for it to finish before deleting: ${t.series_id}`,
    );
    expect(await getSession(t.session_id)).toBeTruthy();
  });

  it('deletes a task living in a legacy shared task session without destroying the session', async () => {
    await createChatSession('ag-1', 'legacy-tasks', TASKS_SYSTEM_THREAD_ID);
    await withMailboxSession('ag-1', 'legacy-tasks', (mailbox) =>
      mailbox.insertTask({
        id: 'legacy-row',
        seriesId: 'legacy-series',
        processAfter: '2999-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'old' }),
      }),
    );
    fs.mkdirSync(`${TEST_DIR}/groups/ag-1/tasks`, { recursive: true });
    fs.writeFileSync(`${TEST_DIR}/groups/ag-1/tasks/legacy-series.md`, 'x\n');

    const listed = dataOf<Array<{ series_id: string }>>(await run('tasks-list', { group: 'ag-1' }));
    expect(listed.map((r) => r.series_id)).toEqual(['legacy-series']);

    expect(dataOf(await run('tasks-delete', { id: 'legacy-series', group: 'ag-1' }))).toEqual({
      series_id: 'legacy-series',
      touched: 1,
    });
    expect(await getSession('legacy-tasks')).toBeTruthy(); // shared session survives
    expect(fs.existsSync(`${TEST_DIR}/groups/ag-1/tasks/legacy-series.md`)).toBe(false);
    expect(dataOf<unknown[]>(await run('tasks-list', { group: 'ag-1' }))).toEqual([]);
  });
});

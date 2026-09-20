/**
 * setup/migrate-v2/tasks.ts is a top-level CLI script (main().catch(...)
 * runs at import time) that ports v1 scheduled_tasks into v2 session
 * inbound mailboxes. Same real-DB technique as db.coverage.test.ts and
 * sessions.coverage.test.ts: CENTRAL_DB_PATH and DATA_DIR point at scratch
 * directories and the real DB + mailbox layers run for real. Only the
 * Discord resolver (network) is mocked, at the module boundary.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

class ProcessExitError extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const mocks = vi.hoisted(() => ({
  buildDiscordResolver: vi.fn(),
}));
vi.mock('./discord-resolver.js', () => ({
  buildDiscordResolver: mocks.buildDiscordResolver,
}));

let dbPath = '';
let dataDir = '';
vi.mock('../../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config.js')>()),
  get CENTRAL_DB_PATH() {
    return dbPath;
  },
  get DATA_DIR() {
    return dataDir;
  },
}));

const originalArgv = process.argv;
const originalCwd = process.cwd();
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeV1Db(v1Path: string, rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.join(v1Path, 'store'), { recursive: true });
  const db = new Database(path.join(v1Path, 'store', 'messages.db'));
  db.exec(`CREATE TABLE scheduled_tasks (
    id TEXT, group_folder TEXT, chat_jid TEXT, prompt TEXT,
    schedule_type TEXT, schedule_value TEXT, next_run TEXT, status TEXT,
    context_mode TEXT, script TEXT
  )`);
  const stmt = db.prepare(`INSERT INTO scheduled_tasks
    (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, context_mode, script)
    VALUES (@id, @group_folder, @chat_jid, @prompt, @schedule_type, @schedule_value, @next_run, @status, @context_mode, @script)`);
  for (const r of rows) {
    stmt.run({
      prompt: 'do the thing',
      next_run: null,
      status: 'active',
      context_mode: null,
      script: null,
      ...r,
    });
  }
  db.close();
}

/** Seed the (mocked-path) central DB with one agent group + wired messaging group, using the real DB layer. */
async function seed(opts: {
  folder: string;
  agentGroupId: string;
  channelType: string;
  platformId: string;
}): Promise<void> {
  vi.resetModules();
  const { initDb, closeDb } = await import('../../src/db/connection.js');
  const { runMigrations } = await import('../../src/db/migrations/index.js');
  const { createAgentGroup } = await import('../../src/db/agent-groups.js');
  const { createMessagingGroup } = await import('../../src/db/messaging-groups.js');
  const seedDb = await initDb(dbPath);
  await runMigrations(seedDb);
  await createAgentGroup({
    id: opts.agentGroupId,
    name: opts.folder,
    folder: opts.folder,
    agent_provider: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await createMessagingGroup({
    id: `mg-${opts.agentGroupId}`,
    channel_type: opts.channelType,
    platform_id: opts.platformId,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  await closeDb();
}

afterEach(async () => {
  process.argv = originalArgv;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  mocks.buildDiscordResolver.mockReset();
  try {
    const { closeDb } = await import('../../src/db/connection.js');
    await closeDb();
  } catch {
    // no db module loaded yet
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ logs: string[]; errors: string[]; exit?: number }> {
  vi.resetModules();
  process.argv = ['node', 'tasks.ts', ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
    logs.push(m);
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => {
    errors.push(m);
  });
  // See db.coverage.test.ts: tasks.ts wraps main() in .catch(err => {...;
  // process.exit(1)}); record every exit call and trust only the first one.
  const exitCalls: (number | undefined)[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code);
    throw new ProcessExitError(code);
  }) as never);
  process.on('unhandledRejection', () => {});
  try {
    await import('./tasks.js');
    await new Promise((r) => setTimeout(r, 0));
  } catch (err) {
    if (!(err instanceof ProcessExitError)) throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errors, exit: exitCalls[0] };
}

describe('migrate-v2/tasks.ts', () => {
  it('usage-exits 1 with no v1 path', async () => {
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);

    const { exit, errors } = await run([]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/tasks.ts');
  });

  it('skips (exit 0) when the v1 DB does not exist', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);

    const { logs, exit } = await run([v1]);
    expect(exit).toBe(0);
    expect(logs).toEqual(['SKIPPED:no v1 DB']);
  });

  it('skips (exit 0) when there are zero active tasks', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'tg:1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00Z',
        status: 'paused',
      },
    ]);

    const { logs, exit } = await run([v1]);
    expect(exit).toBe(0);
    expect(logs).toEqual(['SKIPPED:no active tasks']);
  });

  it('exits 1 when v2.db does not exist yet', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'tg:1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00Z',
      },
    ]);

    const { exit, errors } = await run([v1]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('v2.db not found');
  });

  it('skips a task whose group_folder has no matching agent group', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'unregistered',
        chat_jid: 'tg:1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=0,skipped=1,failed=0');
  });

  it('skips a task whose chat_jid cannot be parsed', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'not-a-valid-jid',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=0,skipped=1,failed=0');
  });

  it('skips a task whose messaging group is not registered in v2', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'tg:999',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=0,skipped=1,failed=0');
  });

  it('skips a task with an unrecognized schedule_type (toCron returns null)', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      { id: 't1', group_folder: 'sales', chat_jid: 'tg:1', schedule_type: 'weird-type', schedule_value: 'x' },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=0,skipped=1,failed=0');
  });

  it('migrates a "once" task and is idempotent on rerun', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'tg:1',
        schedule_type: 'once',
        schedule_value: '2026-03-01T00:00:00.000Z',
        prompt: 'send the report',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const first = await run([v1]);
    expect(first.logs.at(-1)).toBe('OK:active=1,migrated=1,skipped=0,failed=0');

    const second = await run([v1]);
    expect(second.logs.at(-1)).toBe('OK:active=1,migrated=0,skipped=1,failed=0');
  });

  it('migrates an "at" task, preferring next_run over schedule_value for processAfter', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't-at',
        group_folder: 'sales',
        chat_jid: 'tg:1',
        schedule_type: 'at',
        schedule_value: '2026-02-01T00:00:00.000Z',
        next_run: '2026-05-01T00:00:00.000Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=1,skipped=0,failed=0');

    const db = new Database(dbPath, { readonly: true });
    const session = db.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').get('ag-sales') as { id: string };
    db.close();
    const inPath = path.join(dataDir, 'v2-sessions', 'ag-sales', session.id, 'inbound.db');
    const inb = new Database(inPath, { readonly: true });
    const row = inb.prepare('SELECT process_after, recurrence FROM messages_in WHERE id = ?').get('t-at') as {
      process_after: string;
      recurrence: string | null;
    };
    inb.close();
    expect(row.process_after).toBe('2026-05-01T00:00:00.000Z');
    expect(row.recurrence).toBeNull();
  });

  it.each([
    ['cron', '*/5 * * * *', true],
    ['cron', '*/5 * * *', false], // 4 fields — invalid
    ['cron', '1 2 3 4 5 6 7', false], // 7 fields — invalid
    ['interval', '15m', true],
    ['interval', '90m', false], // >= 60 minutes — invalid for the "m" branch
    ['interval', '4h', true],
    ['interval', '48h', false], // >= 24 hours — invalid
    ['interval', '3d', true],
    ['interval', '30d', false], // >= 28 days — invalid
    ['interval', '0m', false], // n < 1 — invalid
    ['interval', 'nope', false], // regex mismatch — invalid
  ])('toCron via schedule_type=%s value=%s → migrated=%s', async (scheduleType, scheduleValue, shouldMigrate) => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      { id: 't1', group_folder: 'sales', chat_jid: 'tg:1', schedule_type: scheduleType, schedule_value: scheduleValue },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe(
      shouldMigrate ? 'OK:active=1,migrated=1,skipped=0,failed=0' : 'OK:active=1,migrated=0,skipped=1,failed=0',
    );
  });

  it('discord: resolves a task channel through the guild map', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'dc:chan1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'discord', platformId: 'discord:g1:chan1' });
    mocks.buildDiscordResolver.mockResolvedValue({
      resolve: (id: string) => (id === 'chan1' ? 'discord:g1:chan1' : null),
      stats: () => ({ guilds: 1, channels: 1, dms: 0 }),
    });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=1,skipped=0,failed=0');
    expect(mocks.buildDiscordResolver.mock.calls[0][0]).toBe('');
  });

  it('discord: skips a task channel the resolver could not find', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    makeV1Db(v1, [
      {
        id: 't1',
        group_folder: 'sales',
        chat_jid: 'dc:chan1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'discord', platformId: 'discord:g1:chan1' });
    mocks.buildDiscordResolver.mockResolvedValue({
      resolve: () => null,
      stats: () => ({ guilds: 1, channels: 0, dms: 0 }),
    });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=1,migrated=0,skipped=1,failed=0');
  });

  it('counts a per-task failure separately and keeps processing other tasks', async () => {
    const v1 = tempDir('nanoclaw-tasks-v1-');
    const v2 = tempDir('nanoclaw-tasks-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    // Two tasks so the per-task try/catch demonstrably keeps going after
    // the first one throws (buildDiscordResolver itself is called once,
    // outside the per-task loop — a throw inside .resolve() is what lands
    // in the per-task catch, once per task that reaches it).
    makeV1Db(v1, [
      {
        id: 't-bad',
        group_folder: 'sales',
        chat_jid: 'dc:chan1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 't-good',
        group_folder: 'sales',
        chat_jid: 'tg:1',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00.000Z',
      },
    ]);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', channelType: 'telegram', platformId: 'telegram:1' });
    mocks.buildDiscordResolver.mockResolvedValue({
      resolve: () => {
        throw new Error('resolve exploded');
      },
      stats: () => ({ guilds: 0, channels: 0, dms: 0 }),
    });

    const { logs, errors } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:active=2,migrated=1,skipped=0,failed=1');
    expect(errors.some((e) => e === 'TASK_ERROR:t-bad:resolve exploded')).toBe(true);
  });
});

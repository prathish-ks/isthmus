/**
 * setup/migrate-v2/sessions.ts is a top-level CLI script (main().catch(...)
 * runs at import time) that seeds v2 sessions from v1 session folders. Same
 * real-DB technique as db.coverage.test.ts: CENTRAL_DB_PATH and DATA_DIR are
 * pointed at scratch directories and the real DB + mailbox layers run for
 * real, rather than deep-mocking session-manager.ts's internals.
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

/** Seed the (mocked-path) central DB with one agent group + optional wiring, using the real DB layer. */
async function seed(opts: { folder: string; agentGroupId: string; wireMessagingGroup?: boolean }): Promise<void> {
  vi.resetModules();
  const { initDb, closeDb } = await import('../../src/db/connection.js');
  const { runMigrations } = await import('../../src/db/migrations/index.js');
  const { createAgentGroup } = await import('../../src/db/agent-groups.js');
  const { createMessagingGroup, createMessagingGroupAgent } = await import('../../src/db/messaging-groups.js');
  const seedDb = await initDb(dbPath);
  await runMigrations(seedDb);
  await createAgentGroup({
    id: opts.agentGroupId,
    name: opts.folder,
    folder: opts.folder,
    agent_provider: null,
    created_at: '2026-01-01T00:00:00.000Z',
  });
  if (opts.wireMessagingGroup) {
    await createMessagingGroup({
      id: `mg-${opts.agentGroupId}`,
      channel_type: 'telegram',
      platform_id: `telegram:${opts.agentGroupId}`,
      name: null,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await createMessagingGroupAgent({
      id: `mga-${opts.agentGroupId}`,
      messaging_group_id: `mg-${opts.agentGroupId}`,
      agent_group_id: opts.agentGroupId,
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
  }
  await closeDb();
}

afterEach(async () => {
  process.argv = originalArgv;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
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
  process.argv = ['node', 'sessions.ts', ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
    logs.push(m);
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => {
    errors.push(m);
  });
  // See db.coverage.test.ts: sessions.ts wraps main() in .catch(err => {...;
  // process.exit(1)}), so a deliberate early exit gets re-thrown by that
  // wrapper when our mock doesn't actually terminate the process. Record
  // every exit call and trust only the first one.
  const exitCalls: (number | undefined)[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code);
    throw new ProcessExitError(code);
  }) as never);
  process.on('unhandledRejection', () => {});
  try {
    await import('./sessions.js');
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

describe('migrate-v2/sessions.ts', () => {
  it('usage-exits 1 with no v1 path', async () => {
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);

    const { exit, errors } = await run([]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/sessions.ts');
  });

  it('skips (exit 0) when v1 has no data/sessions/ directory', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);

    const { logs, exit } = await run([v1]);
    expect(exit).toBe(0);
    expect(logs).toEqual(['SKIPPED:no v1 data/sessions/ directory']);
  });

  it('exits 1 when v2.db does not exist yet', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    fs.mkdirSync(path.join(v1, 'data', 'sessions', 'sales'), { recursive: true });

    const { exit, errors } = await run([v1]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('v2.db not found');
  });

  it('skips a stray file directly under v1 data/sessions/ (only directories are session folders)', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    fs.mkdirSync(path.join(v1, 'data', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(v1, 'data', 'sessions', 'stray.txt'), 'not a session');
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:created=0,reused=0,skipped=0,files=0');
  });

  it('skips a v1 session folder with no matching agent group folder', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    fs.mkdirSync(path.join(v1, 'data', 'sessions', 'unregistered'), { recursive: true });
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:created=0,reused=0,skipped=1,files=0');
  });

  it('skips a matching agent group with zero wired messaging groups', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    fs.mkdirSync(path.join(v1, 'data', 'sessions', 'lonely'), { recursive: true });
    await seed({ folder: 'lonely', agentGroupId: 'ag-lonely', wireMessagingGroup: false });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:created=0,reused=0,skipped=1,files=0');
  });

  it('creates a session per wired messaging group and is idempotent on rerun', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    fs.mkdirSync(path.join(v1, 'data', 'sessions', 'sales'), { recursive: true });
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    const first = await run([v1]);
    expect(first.logs.at(-1)).toBe('OK:created=1,reused=0,skipped=0,files=0');

    const second = await run([v1]);
    expect(second.logs.at(-1)).toBe('OK:created=0,reused=1,skipped=0,files=0');

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('copies v1 .claude/ state, skips dangling symlinks, and never overwrites an existing v2 file', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    const claudeDir = path.join(v1, 'data', 'sessions', 'sales', '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"x":1}');
    fs.mkdirSync(path.join(claudeDir, 'sub'));
    fs.writeFileSync(path.join(claudeDir, 'sub', 'inner.txt'), 'nested');
    fs.symlinkSync('/nowhere', path.join(claudeDir, 'dangling'));
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:created=1,reused=0,skipped=0,files=2');

    const v2ClaudeDir = path.join(dataDir, 'v2-sessions', 'ag-sales', '.claude-shared');
    expect(fs.readFileSync(path.join(v2ClaudeDir, 'settings.json'), 'utf-8')).toBe('{"x":1}');
    expect(fs.readFileSync(path.join(v2ClaudeDir, 'sub', 'inner.txt'), 'utf-8')).toBe('nested');
    expect(fs.existsSync(path.join(v2ClaudeDir, 'dangling'))).toBe(false);

    // Rerun must not overwrite or re-count the already-copied files.
    const rerun = await run([v1]);
    expect(rerun.logs.at(-1)).toBe('OK:created=0,reused=1,skipped=0,files=0');
  });

  it('copies a v1 project dir with no .jsonl files without writing a continuation', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    const claudeDir = path.join(v1, 'data', 'sessions', 'sales', '.claude');
    const v1ProjectDir = path.join(claudeDir, 'projects', '-workspace-group');
    fs.mkdirSync(v1ProjectDir, { recursive: true });
    fs.writeFileSync(path.join(v1ProjectDir, 'not-a-session.txt'), 'irrelevant');
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    const { logs } = await run([v1]);
    // files=2: the general .claude/ tree copy picks up the file once under
    // projects/-workspace-group/, and the dedicated project-dir migration
    // copies it again under projects/-workspace-agent/.
    expect(logs.at(-1)).toBe('OK:created=1,reused=0,skipped=0,files=2');

    const db = new Database(dbPath, { readonly: true });
    const session = db.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').get('ag-sales') as { id: string };
    const obPath = path.join(dataDir, 'v2-sessions', 'ag-sales', session.id, 'outbound.db');
    const ob = new Database(obPath, { readonly: true });
    const row = ob.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get();
    expect(row).toBeUndefined();
    ob.close();
    db.close();
  });

  it('migrates the v1 Claude Code project dir and writes the resumed session id into outbound.db', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    const claudeDir = path.join(v1, 'data', 'sessions', 'sales', '.claude');
    const v1ProjectDir = path.join(claudeDir, 'projects', '-workspace-group');
    fs.mkdirSync(v1ProjectDir, { recursive: true });
    fs.writeFileSync(path.join(v1ProjectDir, 'session-a.jsonl'), '{}');
    fs.writeFileSync(path.join(v1ProjectDir, 'session-b.jsonl'), '{}');
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    await run([v1]);

    const v2ProjectDir = path.join(
      dataDir,
      'v2-sessions',
      'ag-sales',
      '.claude-shared',
      'projects',
      '-workspace-agent',
    );
    expect(fs.existsSync(path.join(v2ProjectDir, 'session-a.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(v2ProjectDir, 'session-b.jsonl'))).toBe(true);

    const db = new Database(dbPath, { readonly: true });
    const session = db.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').get('ag-sales') as { id: string };
    const obPath = path.join(dataDir, 'v2-sessions', 'ag-sales', session.id, 'outbound.db');
    const ob = new Database(obPath, { readonly: true });
    const row = ob.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get() as {
      value: string;
    };
    expect(['session-a', 'session-b']).toContain(row.value);
    ob.close();
    db.close();
  });

  // Regression test for a fixed bug: the "most recent" v1 session used to be
  // picked by re-statting mtime from the just-copied v2 destination files
  // (sourceDir preferred v2ProjectDir once it existed) instead of the
  // original v1 files — copyFileSync resets mtime to copy time, so with
  // multiple .jsonl files the pick was effectively readdir order, not real
  // v1 recency. Distinct, deliberately-set mtimes on the v1 source files
  // prove the pick is now driven by actual v1 recency.
  it('picks the v1 session with the newest v1 mtime, not directory-read order after the copy', async () => {
    const v1 = tempDir('nanoclaw-sess-v1-');
    const v2 = tempDir('nanoclaw-sess-v2-');
    dbPath = path.join(v2, 'v2.db');
    dataDir = v2;
    process.chdir(v2);
    const claudeDir = path.join(v1, 'data', 'sessions', 'sales', '.claude');
    const v1ProjectDir = path.join(claudeDir, 'projects', '-workspace-group');
    fs.mkdirSync(v1ProjectDir, { recursive: true });
    // Write "z-older" after "a-newer" so directory-read order (typically
    // alphabetical/insertion order) picks the wrong one unless real v1
    // mtimes are honored.
    fs.writeFileSync(path.join(v1ProjectDir, 'a-newer.jsonl'), '{}');
    fs.writeFileSync(path.join(v1ProjectDir, 'z-older.jsonl'), '{}');
    const now = Date.now();
    fs.utimesSync(path.join(v1ProjectDir, 'a-newer.jsonl'), now / 1000, now / 1000);
    fs.utimesSync(path.join(v1ProjectDir, 'z-older.jsonl'), (now - 60_000) / 1000, (now - 60_000) / 1000);
    await seed({ folder: 'sales', agentGroupId: 'ag-sales', wireMessagingGroup: true });

    await run([v1]);

    const db = new Database(dbPath, { readonly: true });
    const session = db.prepare('SELECT id FROM sessions WHERE agent_group_id = ?').get('ag-sales') as { id: string };
    const obPath = path.join(dataDir, 'v2-sessions', 'ag-sales', session.id, 'outbound.db');
    const ob = new Database(obPath, { readonly: true });
    const row = ob.prepare("SELECT value FROM session_state WHERE key = 'continuation:claude'").get() as {
      value: string;
    };
    expect(row.value).toBe('a-newer');
    ob.close();
    db.close();
  });
});

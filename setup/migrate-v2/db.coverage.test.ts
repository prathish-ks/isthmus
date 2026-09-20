/**
 * setup/migrate-v2/db.ts is a top-level CLI script (main().catch(...) runs
 * at import time) that seeds the real v2 central DB from a v1 sqlite
 * fixture. Rather than deep-mocking every src/db collaborator, we point
 * CENTRAL_DB_PATH at a scratch file (same technique as
 * setup/templates.test.ts's "real dispatch" contract test) and let the real
 * DB layer + migrations run — this exercises the actual createAgentGroup /
 * createMessagingGroup contract instead of a hand-rolled fake of it. Only
 * the Discord resolver (network) is mocked, at the module boundary.
 *
 * Each scenario does vi.resetModules() + a fresh dynamic import, which also
 * resets src/db/connection.ts's module-level `_db` singleton, so no manual
 * closeDb() bookkeeping is needed between scenarios.
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
vi.mock('../../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config.js')>()),
  get CENTRAL_DB_PATH() {
    return dbPath;
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
  db.exec(
    'CREATE TABLE registered_groups (jid TEXT, name TEXT, folder TEXT, trigger_pattern TEXT, requires_trigger INTEGER)',
  );
  const stmt = db.prepare(
    'INSERT INTO registered_groups (jid, name, folder, trigger_pattern, requires_trigger) VALUES (@jid, @name, @folder, @trigger_pattern, @requires_trigger)',
  );
  for (const r of rows) {
    stmt.run({ trigger_pattern: null, requires_trigger: 0, ...r });
  }
  db.close();
}

afterEach(async () => {
  process.argv = originalArgv;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  mocks.buildDiscordResolver.mockReset();
  // Defensive: if a scenario's mocked process.exit short-circuited before
  // main() reached its own `await v2Db.close()`, the module-level `_db`
  // singleton in src/db/connection.ts would otherwise leak into whatever
  // generation the next test's dynamic import resolves to.
  try {
    const { closeDb } = await import('../../src/db/connection.js');
    await closeDb();
  } catch {
    // no db module loaded yet — nothing to close
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ logs: string[]; errors: string[]; exit?: number }> {
  vi.resetModules();
  process.argv = ['node', 'db.ts', ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
    logs.push(m);
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => {
    errors.push(m);
  });
  // db.ts wraps its top-level `main()` in `.catch(err => { ...; process.exit(1); })`.
  // Because our mocked process.exit THROWS instead of terminating the process,
  // a deliberate early `process.exit(0|1)` inside main() gets reinterpreted by
  // that wrapper as an unexpected failure, which then calls process.exit(1)
  // AGAIN — masking the script's actual, intended exit code. Real process.exit
  // never returns, so in production the wrapper's re-exit never fires; here we
  // recover the intended behavior by recording every exit call as it happens
  // and trusting only the FIRST one.
  const exitCalls: (number | undefined)[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code);
    throw new ProcessExitError(code);
  }) as never);
  let rejection: unknown;
  const onRejection = (reason: unknown) => {
    rejection = reason;
  };
  process.on('unhandledRejection', onRejection);
  try {
    await import('./db.js');
    await new Promise((r) => setTimeout(r, 0));
  } catch (err) {
    if (!(err instanceof ProcessExitError)) throw err;
  } finally {
    process.off('unhandledRejection', onRejection);
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  void rejection; // surfaced via exitCalls instead; kept for listener symmetry
  return { logs, errors, exit: exitCalls[0] };
}

describe('migrate-v2/db.ts', () => {
  it('usage-exits 1 with no v1 path', async () => {
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);

    const { exit, errors } = await run([]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/db.ts');
  });

  it('exits 1 when the v1 DB does not exist', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);

    const { exit, errors } = await run([v1]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('v1 DB not found');
  });

  it('skips (exit 0) when v1 has zero registered groups', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, []);

    const { logs, exit } = await run([v1]);
    expect(exit).toBe(0);
    expect(logs).toEqual(['SKIPPED:no registered groups in v1']);
  });

  it('creates agent_groups + messaging_groups + wiring for a parseable non-Discord JID', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'tg:12345', name: 'Sales Bot', folder: 'sales', trigger_pattern: null, requires_trigger: 0 }]);

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:groups=1,created=1,reused=0,skipped=0');

    const db = new Database(dbPath, { readonly: true });
    const ag = db.prepare('SELECT * FROM agent_groups WHERE folder = ?').get('sales') as { name: string };
    expect(ag.name).toBe('Sales Bot');
    const mg = db.prepare('SELECT * FROM messaging_groups WHERE platform_id = ?').get('telegram:12345') as {
      unknown_sender_policy: string;
      is_group: number;
    };
    expect(mg.unknown_sender_policy).toBe('public');
    const mga = db.prepare('SELECT * FROM messaging_group_agents').get() as { engage_mode: string };
    expect(mga.engage_mode).toBe('pattern'); // requires_trigger=0 → respond to everything
    db.close();
  });

  it('is idempotent: rerunning the same v1 groups reuses rows instead of duplicating them', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'tg:12345', name: 'Sales Bot', folder: 'sales' }]);

    await run([v1]);
    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:groups=1,created=0,reused=1,skipped=0');

    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare('SELECT COUNT(*) AS n FROM agent_groups').get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it('skips and reports an unparseable JID, and fails the whole run when every group is skipped', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'not-a-valid-jid', name: 'Bad', folder: 'bad' }]);

    const { errors, exit } = await run([v1]);
    expect(exit).toBe(1);
    expect(errors[0]).toBe('FAIL:groups=1,created=0,reused=0,skipped=1');
    expect(errors.some((e) => e.includes('Could not parse JID: not-a-valid-jid'))).toBe(true);
  });

  it('resets unknown_sender_policy to public on a pre-existing zero-wiring messaging group, but leaves an already-wired one alone', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    // Simulate a messaging group the router auto-created (strict policy, no
    // wiring yet) before the migration runs.
    makeV1Db(v1, [{ jid: 'tg:999', name: 'Auto Created', folder: 'auto' }]);

    vi.resetModules();
    const { initDb, closeDb } = await import('../../src/db/connection.js');
    const { runMigrations } = await import('../../src/db/migrations/index.js');
    const { createMessagingGroup } = await import('../../src/db/messaging-groups.js');
    const seedDb = await initDb(dbPath);
    await runMigrations(seedDb);
    await createMessagingGroup({
      id: 'mg-preexisting',
      channel_type: 'telegram',
      platform_id: 'telegram:999',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await closeDb();

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:groups=1,created=1,reused=0,skipped=0');

    const db = new Database(dbPath, { readonly: true });
    const mg = db.prepare('SELECT unknown_sender_policy FROM messaging_groups WHERE id = ?').get('mg-preexisting') as {
      unknown_sender_policy: string;
    };
    expect(mg.unknown_sender_policy).toBe('public');
    db.close();
  });

  it('leaves unknown_sender_policy alone on a pre-existing messaging group that already has a wired agent', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'tg:999', name: 'Already Wired', folder: 'wired' }]);

    vi.resetModules();
    const { initDb, closeDb } = await import('../../src/db/connection.js');
    const { runMigrations } = await import('../../src/db/migrations/index.js');
    const { createAgentGroup } = await import('../../src/db/agent-groups.js');
    const { createMessagingGroup, createMessagingGroupAgent } = await import('../../src/db/messaging-groups.js');
    const seedDb = await initDb(dbPath);
    await runMigrations(seedDb);
    await createAgentGroup({
      id: 'ag-other',
      name: 'Other agent',
      folder: 'other-folder',
      agent_provider: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await createMessagingGroup({
      id: 'mg-preexisting',
      channel_type: 'telegram',
      platform_id: 'telegram:999',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await createMessagingGroupAgent({
      id: 'mga-preexisting',
      messaging_group_id: 'mg-preexisting',
      agent_group_id: 'ag-other',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    await closeDb();

    await run([v1]);

    const db = new Database(dbPath, { readonly: true });
    const mg = db.prepare('SELECT unknown_sender_policy FROM messaging_groups WHERE id = ?').get('mg-preexisting') as {
      unknown_sender_policy: string;
    };
    expect(mg.unknown_sender_policy).toBe('strict'); // left alone: already had a wired agent
    db.close();
  });

  it('formats a non-Error thrown by a collaborator via String(err) in the top-level failure handler', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'dc:chan1', name: 'Discord Group', folder: 'discordgrp' }]);
    // eslint-disable-next-line prefer-promise-reject-errors
    mocks.buildDiscordResolver.mockRejectedValue('not an Error instance');

    const { errors, exit } = await run([v1]);
    expect(exit).toBe(1);
    expect(errors[0]).toBe('FAIL:not an Error instance');
  });

  it('discord: resolves a channel through the guild map and creates a discord:<guild>:<channel> messaging group', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'dc:chan1', name: 'Discord Group', folder: 'discordgrp' }]);
    mocks.buildDiscordResolver.mockResolvedValue({
      resolve: (id: string) => (id === 'chan1' ? 'discord:g1:chan1' : null),
      stats: () => ({ guilds: 1, channels: 1, dms: 0 }),
    });

    const { logs } = await run([v1]);
    expect(logs[0]).toContain('INFO:discord resolver: 1 guild(s)');
    expect(logs.at(-1)).toBe('OK:groups=1,created=1,reused=0,skipped=0');

    const db = new Database(dbPath, { readonly: true });
    const mg = db.prepare('SELECT platform_id FROM messaging_groups WHERE channel_type = ?').get('discord') as {
      platform_id: string;
    };
    expect(mg.platform_id).toBe('discord:g1:chan1');
    db.close();
  });

  it('discord: warns and skips every channel when the resolver reports itself disabled', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [{ jid: 'dc:chan1', name: 'Discord Group', folder: 'discordgrp' }]);
    mocks.buildDiscordResolver.mockResolvedValue({
      resolve: () => null,
      stats: () => ({ guilds: 0, channels: 0, dms: 0, reason: 'no DISCORD_BOT_TOKEN in .env' }),
    });

    const { logs, errors, exit } = await run([v1]);
    expect(logs[0]).toBe('WARN:discord resolver disabled: no DISCORD_BOT_TOKEN in .env');
    expect(exit).toBe(1); // every group skipped
    expect(errors.some((e) => e.includes('discord resolver unavailable'))).toBe(true);
  });

  it('discord: skips a channel the resolver could not find in any guild, with the re-add-bot hint', async () => {
    const v1 = tempDir('nanoclaw-db-v1-');
    const v2 = tempDir('nanoclaw-db-v2-');
    dbPath = path.join(v2, 'v2.db');
    process.chdir(v2);
    makeV1Db(v1, [
      { jid: 'dc:chan1', name: 'Discord Group', folder: 'discordgrp' },
      { jid: 'tg:1', name: 'Fallback', folder: 'fallback' },
    ]);
    mocks.buildDiscordResolver.mockResolvedValue({
      resolve: () => null,
      stats: () => ({ guilds: 1, channels: 0, dms: 0 }),
    });

    const { logs } = await run([v1]);
    expect(logs).toContain('OK:groups=2,created=1,reused=0,skipped=1');
    // Partial success (some groups created) goes through the success path,
    // which prints per-group errors via console.log, not console.error.
    expect(logs.some((e) => e.includes('re-add the bot to that server'))).toBe(true);
  });
});

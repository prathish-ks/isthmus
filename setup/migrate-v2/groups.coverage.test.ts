/**
 * setup/migrate-v2/groups.ts is a top-level CLI script (main() runs at
 * import time). It touches only fs + a real better-sqlite3 v1 fixture, so we
 * drive it end-to-end against scratch directories rather than mocking the DB.
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

const originalArgv = process.argv;
const originalCwd = process.cwd();
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeV1Db(v1Path: string, rows: { folder: string; container_config: string | null }[]): void {
  fs.mkdirSync(path.join(v1Path, 'store'), { recursive: true });
  const db = new Database(path.join(v1Path, 'store', 'messages.db'));
  db.exec('CREATE TABLE registered_groups (folder TEXT, container_config TEXT)');
  const stmt = db.prepare('INSERT INTO registered_groups (folder, container_config) VALUES (?, ?)');
  for (const r of rows) stmt.run(r.folder, r.container_config);
  db.close();
}

afterEach(() => {
  process.argv = originalArgv;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ logs: string[]; errors: string[]; exit?: number }> {
  vi.resetModules();
  process.argv = ['node', 'groups.ts', ...args];
  const logs: string[] = [];
  const errors: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => {
    logs.push(m);
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => {
    errors.push(m);
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  let exit: number | undefined;
  try {
    await import('./groups.js');
  } catch (err) {
    if (err instanceof ProcessExitError) exit = err.code;
    else throw err;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errors, exit };
}

describe('migrate-v2/groups.ts', () => {
  it('usage-exits 1 with no v1 path', async () => {
    const { exit, errors } = await run([]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/groups.ts');
  });

  it('skips (exit 0) when v1 has no groups/ directory', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    process.chdir(v2);

    const { logs, exit } = await run([v1]);
    expect(exit).toBe(0);
    expect(logs).toEqual(['SKIPPED:no v1 groups/ directory']);
  });

  it('copies files, migrates CLAUDE.md to CLAUDE.local.md, and skips symlinks/SKIP_NAMES without a v1 DB', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    const g1 = path.join(v1, 'groups', 'sales');
    fs.mkdirSync(g1, { recursive: true });
    fs.writeFileSync(path.join(g1, 'CLAUDE.md'), 'legacy memory');
    fs.writeFileSync(path.join(g1, 'notes.txt'), 'keep me');
    fs.mkdirSync(path.join(g1, 'logs'));
    fs.writeFileSync(path.join(g1, 'logs', 'ignored.log'), 'x');
    fs.mkdirSync(path.join(g1, '.git'));
    fs.writeFileSync(path.join(g1, '.git', 'config'), 'x');
    fs.symlinkSync('/nowhere', path.join(g1, 'dangling-link'));
    fs.mkdirSync(path.join(g1, 'sub'));
    fs.writeFileSync(path.join(g1, 'sub', 'inner.txt'), 'nested');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs.find((l) => l.startsWith('SKIP:symlink'))).toBeDefined();
    expect(logs.at(-1)).toBe('OK:folders=1,claudes=1,files=2');

    expect(fs.readFileSync(path.join(v2, 'groups', 'sales', 'CLAUDE.local.md'), 'utf-8')).toBe('legacy memory');
    expect(fs.readFileSync(path.join(v2, 'groups', 'sales', 'notes.txt'), 'utf-8')).toBe('keep me');
    expect(fs.readFileSync(path.join(v2, 'groups', 'sales', 'sub', 'inner.txt'), 'utf-8')).toBe('nested');
    expect(fs.existsSync(path.join(v2, 'groups', 'sales', 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(v2, 'groups', 'sales', '.git'))).toBe(false);
    expect(fs.existsSync(path.join(v2, 'groups', 'sales', 'dangling-link'))).toBe(false);
  });

  it('skips a stray file directly under v1 groups/ (only directories are group folders)', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    fs.mkdirSync(path.join(v1, 'groups'), { recursive: true });
    fs.writeFileSync(path.join(v1, 'groups', 'stray-file.txt'), 'not a group');
    fs.mkdirSync(path.join(v1, 'groups', 'real'), { recursive: true });
    fs.writeFileSync(path.join(v1, 'groups', 'real', 'a.txt'), 'x');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:folders=1,claudes=0,files=1');
    expect(fs.existsSync(path.join(v2, 'groups', 'stray-file.txt'))).toBe(false);
  });

  it('does not overwrite an existing v2 CLAUDE.local.md or an existing plain file', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    const g1 = path.join(v1, 'groups', 'sales');
    fs.mkdirSync(g1, { recursive: true });
    fs.writeFileSync(path.join(g1, 'CLAUDE.md'), 'from v1');
    fs.writeFileSync(path.join(g1, 'shared.txt'), 'from v1');
    const v2g = path.join(v2, 'groups', 'sales');
    fs.mkdirSync(v2g, { recursive: true });
    fs.writeFileSync(path.join(v2g, 'CLAUDE.local.md'), 'already migrated');
    fs.writeFileSync(path.join(v2g, 'shared.txt'), 'already there');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs.at(-1)).toBe('OK:folders=1,claudes=0,files=0');
    expect(fs.readFileSync(path.join(v2g, 'CLAUDE.local.md'), 'utf-8')).toBe('already migrated');
    expect(fs.readFileSync(path.join(v2g, 'shared.txt'), 'utf-8')).toBe('already there');
  });

  it('writes container.json from a valid v1 container_config JSON, keyed by folder', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    fs.mkdirSync(path.join(v1, 'groups', 'sales'), { recursive: true });
    makeV1Db(v1, [{ folder: 'sales', container_config: JSON.stringify({ additionalMounts: ['/x'] }) }]);
    process.chdir(v2);

    await run([v1]);

    const containerJson = JSON.parse(fs.readFileSync(path.join(v2, 'groups', 'sales', 'container.json'), 'utf-8'));
    expect(containerJson).toEqual({ additionalMounts: ['/x'] });
  });

  it('writes an unparseable container_config as a sidecar file instead', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    fs.mkdirSync(path.join(v1, 'groups', 'sales'), { recursive: true });
    makeV1Db(v1, [{ folder: 'sales', container_config: 'not valid json {{' }]);
    process.chdir(v2);

    await run([v1]);

    expect(fs.existsSync(path.join(v2, 'groups', 'sales', 'container.json'))).toBe(false);
    expect(fs.readFileSync(path.join(v2, 'groups', 'sales', '.v1-container-config.json'), 'utf-8')).toBe(
      'not valid json {{',
    );
  });

  it('skips container_config writing when the row has none, and skips an existing container.json', async () => {
    const v1 = tempDir('nanoclaw-grp-v1-');
    const v2 = tempDir('nanoclaw-grp-v2-');
    fs.mkdirSync(path.join(v1, 'groups', 'noconfig'), { recursive: true });
    fs.mkdirSync(path.join(v1, 'groups', 'sales'), { recursive: true });
    makeV1Db(v1, [
      { folder: 'noconfig', container_config: null },
      { folder: 'sales', container_config: JSON.stringify({ a: 1 }) },
    ]);
    const v2Sales = path.join(v2, 'groups', 'sales');
    fs.mkdirSync(v2Sales, { recursive: true });
    fs.writeFileSync(path.join(v2Sales, 'container.json'), '{"already":true}');
    process.chdir(v2);

    await run([v1]);

    expect(fs.existsSync(path.join(v2, 'groups', 'noconfig', 'container.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(v2Sales, 'container.json'), 'utf-8'))).toEqual({ already: true });
  });
});

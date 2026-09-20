/**
 * setup/migrate-v2/env.ts is a top-level CLI script (main() runs at import
 * time, calling process.exit() directly). We give it a scratch cwd via
 * process.chdir and a fake argv, then dynamic-import fresh for each scenario
 * — mirroring scripts/upgrade-state.coverage.test.ts's pattern for scripts
 * with top-level side effects. process.exit is stubbed to throw so a test
 * that hits it doesn't fall through into code that assumes it stopped.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

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

afterEach(() => {
  process.argv = originalArgv;
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ logs: string[]; errors: string[]; exit?: number }> {
  vi.resetModules();
  process.argv = ['node', 'env.ts', ...args];
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
    await import('./env.js');
  } catch (err) {
    if (err instanceof ProcessExitError) {
      exit = err.code;
    } else {
      throw err;
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errors, exit };
}

describe('migrate-v2/env.ts', () => {
  it('usage-exits 1 when no v1 path is given', async () => {
    const { errors, exit } = await run([]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/env.ts <v1-path>');
  });

  it('skips (exit 0) when v1 has no .env', async () => {
    const v1 = tempDir('nanoclaw-env-v1-');
    const v2 = tempDir('nanoclaw-env-v2-');
    process.chdir(v2);

    const { logs, exit } = await run([v1]);
    expect(exit).toBe(0);
    expect(logs).toEqual(['SKIPPED:no v1 .env']);
  });

  it('copies every v1 key into a fresh v2 .env under the migrated-from-v1 block', async () => {
    const v1 = tempDir('nanoclaw-env-v1-');
    const v2 = tempDir('nanoclaw-env-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'FOO=bar\n# a comment\n\nBAZ=qux\n');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs[0]).toBe('OK:copied=2,skipped=0');
    expect(logs[1]).toBe('COPIED:FOO,BAZ');

    const written = fs.readFileSync(path.join(v2, '.env'), 'utf-8');
    expect(written).toContain('# ── migrated from v1 ──');
    expect(written).toContain('FOO=bar');
    expect(written).toContain('BAZ=qux');
  });

  it('never overwrites a key that already exists in v2 .env, and appends without a duplicate block header on rerun', async () => {
    const v1 = tempDir('nanoclaw-env-v1-');
    const v2 = tempDir('nanoclaw-env-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'FOO=fromv1\nNEWKEY=added\n');
    fs.writeFileSync(path.join(v2, '.env'), 'FOO=existing\n\n# ── migrated from v1 ──\nOLDKEY=already-there\n');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs[0]).toBe('OK:copied=1,skipped=1');
    expect(logs[1]).toBe('COPIED:NEWKEY');

    const written = fs.readFileSync(path.join(v2, '.env'), 'utf-8');
    // Existing key untouched.
    expect(written).toContain('FOO=existing');
    expect(written).not.toContain('FOO=fromv1');
    // No second block header — it was already migrated.
    expect(written.match(/# ── migrated from v1 ──/g)?.length).toBe(1);
    expect(written).toContain('NEWKEY=added');
  });

  it('skips malformed lines (no "=", invalid key characters) in the v1 .env', async () => {
    const v1 = tempDir('nanoclaw-env-v1-');
    const v2 = tempDir('nanoclaw-env-v2-');
    fs.writeFileSync(v1 + '/.env', 'noequalsatall\n1BADKEY=x\nGOOD_KEY=1\n');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs[0]).toBe('OK:copied=1,skipped=0');
    expect(logs[1]).toBe('COPIED:GOOD_KEY');
  });

  it('adds a newline before appending when existing v2 .env has no trailing newline', async () => {
    const v1 = tempDir('nanoclaw-env-v1-');
    const v2 = tempDir('nanoclaw-env-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'NEWONE=1\n');
    fs.writeFileSync(path.join(v2, '.env'), 'EXISTING=1'); // no trailing newline
    process.chdir(v2);

    await run([v1]);
    const written = fs.readFileSync(path.join(v2, '.env'), 'utf-8');
    expect(written.startsWith('EXISTING=1\n')).toBe(true);
    expect(written).toContain('NEWONE=1');
  });

  it('does not write v2 .env at all when nothing new is copied', async () => {
    const v1 = tempDir('nanoclaw-env-v1-');
    const v2 = tempDir('nanoclaw-env-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'FOO=1\n');
    fs.writeFileSync(path.join(v2, '.env'), 'FOO=already\n');
    process.chdir(v2);

    const { logs } = await run([v1]);
    expect(logs[0]).toBe('OK:copied=0,skipped=1');
    expect(logs[1]).toBeUndefined();
  });
});

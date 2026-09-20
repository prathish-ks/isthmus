/**
 * setup/migrate-v2/channel-auth.ts is a top-level CLI script (main() runs at
 * import time, calling process.exit() directly). Same dynamic-import +
 * scratch-cwd pattern as env.coverage.test.ts.
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
  process.argv = ['node', 'channel-auth.ts', ...args];
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
    await import('./channel-auth.js');
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

describe('migrate-v2/channel-auth.ts', () => {
  it('usage-exits 1 with no v1 path', async () => {
    const { exit, errors } = await run([]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/channel-auth.ts');
  });

  it('usage-exits 1 with a v1 path but zero channels', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const { exit } = await run([v1]);
    expect(exit).toBe(1);
  });

  it('counts an unknown channel as processed but copies nothing for it', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    process.chdir(v2);

    const { logs } = await run([v1, 'totally-unknown-channel']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=0,files=0');
    expect(fs.existsSync(path.join(v2, '.env'))).toBe(false);
  });

  it('copies matching env keys into a fresh v2 .env and reports missing required v2 keys', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'DISCORD_BOT_TOKEN=abc123\n');
    process.chdir(v2);

    const { logs } = await run([v1, 'discord']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=1,files=0');
    // DISCORD_APPLICATION_ID / DISCORD_PUBLIC_KEY are required by v2 but not copied from v1.
    expect(logs[1]).toContain('MISSING:discord:DISCORD_APPLICATION_ID');
    expect(logs[1]).toContain('discord:DISCORD_PUBLIC_KEY');

    const written = fs.readFileSync(path.join(v2, '.env'), 'utf-8');
    expect(written).toContain('DISCORD_BOT_TOKEN=abc123');
  });

  it('does not append a key that already exists in v2 .env', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'WEBEX_BOT_TOKEN=fromv1');
    fs.writeFileSync(path.join(v2, '.env'), 'WEBEX_BOT_TOKEN=existing\n');
    process.chdir(v2);

    const { logs } = await run([v1, 'webex']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=0,files=0');
    const written = fs.readFileSync(path.join(v2, '.env'), 'utf-8');
    expect(written).toBe('WEBEX_BOT_TOKEN=existing\n');
  });

  it('appends onto v2 .env content that has no trailing newline', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'WEBEX_BOT_TOKEN=fromv1');
    fs.writeFileSync(path.join(v2, '.env'), 'OTHER=1'); // no trailing \n
    process.chdir(v2);

    await run([v1, 'webex']);
    const written = fs.readFileSync(path.join(v2, '.env'), 'utf-8');
    expect(written).toBe('OTHER=1\nWEBEX_BOT_TOKEN=fromv1\n');
  });

  it('copies on-disk auth files recursively without overwriting, and reports no missing keys when none are required', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    const sessDir = path.join(v1, 'data', 'sessions', 'telegram');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'session.bin'), 'binary-data');
    fs.mkdirSync(path.join(sessDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'nested', 'inner.txt'), 'x');
    fs.writeFileSync(path.join(v1, '.env'), 'TELEGRAM_BOT_TOKEN=t1\n');
    process.chdir(v2);

    const { logs } = await run([v1, 'telegram']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=1,files=2');
    expect(logs[1]).toBeUndefined(); // no MISSING line: required key was copied
    expect(fs.readFileSync(path.join(v2, 'data', 'sessions', 'telegram', 'session.bin'), 'utf-8')).toBe('binary-data');
    expect(fs.readFileSync(path.join(v2, 'data', 'sessions', 'telegram', 'nested', 'inner.txt'), 'utf-8')).toBe('x');
  });

  it('does not overwrite a file that already exists at the v2 destination', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    const v1Sess = path.join(v1, 'data', 'sessions', 'telegram');
    fs.mkdirSync(v1Sess, { recursive: true });
    fs.writeFileSync(path.join(v1Sess, 'session.bin'), 'from-v1');
    const v2Sess = path.join(v2, 'data', 'sessions', 'telegram');
    fs.mkdirSync(v2Sess, { recursive: true });
    fs.writeFileSync(path.join(v2Sess, 'session.bin'), 'already-here');
    process.chdir(v2);

    const { logs } = await run([v1, 'telegram']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=0,files=0');
    expect(fs.readFileSync(path.join(v2Sess, 'session.bin'), 'utf-8')).toBe('already-here');
  });

  it('is a no-op copyGlob for a candidate path that does not exist in v1', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    process.chdir(v2);

    const { logs } = await run([v1, 'matrix']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=0,files=0');
  });

  it('ignores malformed .env lines (no "=" or leading "=") in v1', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    fs.writeFileSync(v1 + '/.env', 'noequalsatall\n=leadingequals\nWEBEX_BOT_TOKEN=good\n');
    process.chdir(v2);

    const { logs } = await run([v1, 'webex']);
    expect(logs[0]).toBe('OK:channels=1,env_keys=1,files=0');
    expect(fs.readFileSync(path.join(v2, '.env'), 'utf-8')).toContain('WEBEX_BOT_TOKEN=good');
  });

  it('processes multiple channels together, mixing a known and unknown one', async () => {
    const v1 = tempDir('nanoclaw-ca-v1-');
    const v2 = tempDir('nanoclaw-ca-v2-');
    fs.writeFileSync(path.join(v1, '.env'), 'LINEAR_API_KEY=lk1\n');
    process.chdir(v2);

    const { logs } = await run([v1, 'linear', 'not-a-real-channel']);
    expect(logs[0]).toBe('OK:channels=2,env_keys=1,files=0');
  });
});

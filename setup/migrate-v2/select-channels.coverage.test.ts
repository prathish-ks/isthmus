/**
 * setup/migrate-v2/select-channels.ts is a top-level CLI script driven by
 * clack's multiselect. We mock only `multiselect` and `isCancel` (the two
 * exports this script touches) rather than importActual, so we control both
 * the returned selection and what counts as "cancelled" without needing a
 * real terminal or the real clack cancel symbol.
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

const CANCEL = Symbol('cancelled');

const mocks = vi.hoisted(() => ({
  multiselect: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  multiselect: mocks.multiselect,
  isCancel: (v: unknown) => v === CANCEL,
}));

const originalArgv = process.argv;
const originalEnv = { ...process.env };
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.argv = originalArgv;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  mocks.multiselect.mockReset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ exit?: number }> {
  vi.resetModules();
  process.argv = ['node', 'select-channels.ts', ...args];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  let exit: number | undefined;
  // select-channels.ts calls its top-level `main();` without awaiting or
  // .catch()-ing it, so a synchronous throw inside (e.g. our mocked
  // process.exit) rejects a promise nobody holds — it surfaces as an
  // 'unhandledRejection' process event, not as a rejection of the dynamic
  // import() itself. Capture it that way instead of try/catch around import.
  let rejection: unknown;
  const onRejection = (reason: unknown) => {
    rejection = reason;
  };
  process.on('unhandledRejection', onRejection);
  try {
    await import('./select-channels.js');
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off('unhandledRejection', onRejection);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  }
  if (rejection instanceof ProcessExitError) exit = rejection.code;
  return { exit };
}

describe('migrate-v2/select-channels.ts', () => {
  it('usage-exits 1 with no output file', async () => {
    const { exit } = await run([]);
    expect(exit).toBe(1);
    expect(mocks.multiselect).not.toHaveBeenCalled();
  });

  it('writes from NANOCLAW_CHANNELS without prompting, filtering out invalid names', async () => {
    const out = tempDir('nanoclaw-sel-');
    const outFile = path.join(out, 'channels.txt');
    process.env.NANOCLAW_CHANNELS = 'telegram, bogus ,discord';

    await run([outFile]);

    expect(mocks.multiselect).not.toHaveBeenCalled();
    expect(fs.readFileSync(outFile, 'utf-8')).toBe('telegram\ndiscord\n');
  });

  it('ignores a blank NANOCLAW_CHANNELS and falls through to the interactive prompt', async () => {
    const out = tempDir('nanoclaw-sel-');
    const outFile = path.join(out, 'channels.txt');
    process.env.NANOCLAW_CHANNELS = '   ';
    mocks.multiselect.mockResolvedValue(['slack']);

    await run([outFile]);

    expect(mocks.multiselect).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(outFile, 'utf-8')).toBe('slack\n');
  });

  it('writes the selected channels from the interactive multiselect', async () => {
    const out = tempDir('nanoclaw-sel-');
    const outFile = path.join(out, 'channels.txt');
    delete process.env.NANOCLAW_CHANNELS;
    mocks.multiselect.mockResolvedValue(['whatsapp', 'matrix']);

    await run([outFile]);

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('whatsapp\nmatrix\n');
    const opts = mocks.multiselect.mock.calls[0][0];
    expect(opts.required).toBe(false);
    expect(opts.options.map((o: { value: string }) => o.value)).toContain('whatsapp-cloud');
  });

  it('writes an empty file when the prompt is cancelled', async () => {
    const out = tempDir('nanoclaw-sel-');
    const outFile = path.join(out, 'channels.txt');
    delete process.env.NANOCLAW_CHANNELS;
    mocks.multiselect.mockResolvedValue(CANCEL);

    await run([outFile]);

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('');
  });
});

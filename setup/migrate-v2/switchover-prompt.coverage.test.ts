/**
 * setup/migrate-v2/switchover-prompt.ts is a top-level CLI script driven by
 * clack's `select`. Same mocking approach as select-channels.coverage.test.ts:
 * we stub `select` and `isCancel` directly rather than the real clack symbol.
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
  select: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  select: mocks.select,
  isCancel: (v: unknown) => v === CANCEL,
}));

const originalArgv = process.argv;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  mocks.select.mockReset();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ exit?: number; errors: string[] }> {
  vi.resetModules();
  process.argv = ['node', 'switchover-prompt.ts', ...args];
  const errors: string[] = [];
  const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => {
    errors.push(m);
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
  let exit: number | undefined;
  // switchover-prompt.ts calls its top-level `main();` without awaiting or
  // .catch()-ing it, so a synchronous throw inside (our mocked process.exit)
  // rejects a promise nobody holds — it surfaces as an 'unhandledRejection'
  // process event, not as a rejection of the dynamic import() itself.
  let rejection: unknown;
  const onRejection = (reason: unknown) => {
    rejection = reason;
  };
  process.on('unhandledRejection', onRejection);
  try {
    await import('./switchover-prompt.js');
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off('unhandledRejection', onRejection);
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  if (rejection instanceof ProcessExitError) exit = rejection.code;
  return { exit, errors };
}

describe('migrate-v2/switchover-prompt.ts', () => {
  it('usage-exits 1 when the output file is missing', async () => {
    const { exit, errors } = await run(['--offer-switch']);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: tsx setup/migrate-v2/switchover-prompt.ts');
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('usage-exits 1 for an unrecognized mode', async () => {
    const out = tempDir('nanoclaw-swp-');
    const outFile = path.join(out, 'answer.txt');
    const { exit, errors } = await run(['--bogus-mode', outFile]);
    expect(exit).toBe(1);
    expect(errors[0]).toContain('Usage: --offer-switch | --keep-or-revert');
  });

  it('--offer-switch writes the chosen answer', async () => {
    const out = tempDir('nanoclaw-swp-');
    const outFile = path.join(out, 'answer.txt');
    mocks.select.mockResolvedValue('switch');

    await run(['--offer-switch', outFile]);

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('switch');
    expect(mocks.select.mock.calls[0][0].message).toContain('stop the v1 service');
  });

  it('--offer-switch defaults to "skip" when cancelled', async () => {
    const out = tempDir('nanoclaw-swp-');
    const outFile = path.join(out, 'answer.txt');
    mocks.select.mockResolvedValue(CANCEL);

    await run(['--offer-switch', outFile]);

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('skip');
  });

  it('--keep-or-revert writes the chosen answer', async () => {
    const out = tempDir('nanoclaw-swp-');
    const outFile = path.join(out, 'answer.txt');
    mocks.select.mockResolvedValue('keep');

    await run(['--keep-or-revert', outFile]);

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('keep');
    expect(mocks.select.mock.calls[0][0].message).toContain('Keep v2 running');
  });

  it('--keep-or-revert defaults to "revert" when cancelled', async () => {
    const out = tempDir('nanoclaw-swp-');
    const outFile = path.join(out, 'answer.txt');
    mocks.select.mockResolvedValue(CANCEL);

    await run(['--keep-or-revert', outFile]);

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('revert');
  });
});

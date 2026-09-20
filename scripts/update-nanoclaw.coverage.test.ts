import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * scripts/update-nanoclaw.ts is a pure CLI entry point with no exports: it
 * parses argv, dispatches to scripts/update/transaction.js, and runs its
 * main() only when invoked as the process entry point (the
 * `import.meta.url === pathToFileURL(process.argv[1])` guard). We mock the
 * transaction module collaborators, script the fake process.argv to match the
 * module's own URL, and dynamic-import fresh for each scenario.
 */

const mocks = vi.hoisted(() => ({
  prepareUpdate: vi.fn(),
  resumePreparedUpdate: vi.fn(),
  validateUpdate: vi.fn(),
  cutoverUpdate: vi.fn(),
  acknowledgeRequirement: vi.fn(),
  finishUpdate: vi.fn(),
  rollbackUpdate: vi.fn(),
  cleanupUpdate: vi.fn(),
  pruneTransactions: vi.fn(),
  abandonUpdate: vi.fn(),
  loadState: vi.fn(),
  summarizeState: vi.fn((state: { schema: string; phase: string }) => ({
    summarized: true,
    schema: state.schema,
    phase: state.phase,
  })),
}));

vi.mock('./update/transaction.js', () => ({
  abandonUpdate: mocks.abandonUpdate,
  acknowledgeRequirement: mocks.acknowledgeRequirement,
  cleanupUpdate: mocks.cleanupUpdate,
  cutoverUpdate: mocks.cutoverUpdate,
  finishUpdate: mocks.finishUpdate,
  loadState: mocks.loadState,
  prepareUpdate: mocks.prepareUpdate,
  pruneTransactions: mocks.pruneTransactions,
  resumePreparedUpdate: mocks.resumePreparedUpdate,
  rollbackUpdate: mocks.rollbackUpdate,
  summarizeState: mocks.summarizeState,
  validateUpdate: mocks.validateUpdate,
}));

const originalArgv = process.argv;
const MOD_PATH = path.resolve(__dirname, 'update-nanoclaw.ts');

// Each scenario below does vi.resetModules() + a fresh dynamic import of the
// entry script, which (via some import-machinery listener registration, not
// this module's own code) adds a process-level listener per cycle. Node's
// MaxListenersExceededWarning would otherwise print through our
// process.stderr.write spy and corrupt the captured JSON output.
process.setMaxListeners(100);

function updateState(overrides: Partial<{ phase: string; id: string }> = {}) {
  return {
    schema: 'nanoclaw-update/v1',
    id: overrides.id ?? 'tx-1',
    phase: overrides.phase ?? 'prepared',
  };
}

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.summarizeState.mockImplementation((state: { schema: string; phase: string }) => ({
    summarized: true,
    schema: state.schema,
    phase: state.phase,
  }));
});

async function runEntry(args: string[]): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  vi.resetModules();
  process.argv = ['node', MOD_PATH, ...args];
  process.exitCode = undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr.push(String(chunk));
    return true;
  });
  try {
    await import('./update-nanoclaw.js');
    // main() is fired with `void main()`, so we poll until output appears and
    // is stable for one more tick — this both waits long enough for a slow
    // resolution and guarantees the write finishes before the spy is
    // restored, so it can never bleed into the next test's spy.
    let last = -1;
    let stableStreak = 0;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
      const current = stdout.length + stderr.length;
      if (current > 0 && current === last) {
        stableStreak += 1;
        if (stableStreak >= 2) break;
      } else {
        stableStreak = 0;
      }
      last = current;
    }
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { stdout, stderr, exitCode };
}

describe('entry guard', () => {
  it('does not run main() when argv[1] does not match the module URL', async () => {
    vi.resetModules();
    process.argv = ['node', '/somewhere/else.js', 'status', '--id', 'x'];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await import('./update-nanoclaw.js');
      await new Promise((r) => setTimeout(r, 20));
      expect(outSpy).not.toHaveBeenCalled();
      expect(mocks.loadState).not.toHaveBeenCalled();
    } finally {
      outSpy.mockRestore();
    }
  });
});

describe('parseArgs via the CLI entry', () => {
  it('reports a missing command', async () => {
    const { stderr, exitCode } = await runEntry([]);
    const err = JSON.parse(stderr.join(''));
    expect(err).toMatchObject({ schema: 'nanoclaw-update-error/v1', error: 'Missing command' });
    expect(exitCode).toBe(1);
  });

  it('rejects an unknown argument', async () => {
    const { stderr, exitCode } = await runEntry(['status', '--id', 'x', '--nope', 'y']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Unknown argument: --nope');
    expect(exitCode).toBe(1);
  });

  it('rejects a flag with a missing value', async () => {
    const { stderr, exitCode } = await runEntry(['prepare', '--upstream-ref']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Missing value for --upstream-ref');
    expect(exitCode).toBe(1);
  });

  it('rejects an unknown --strategy value', async () => {
    const { stderr } = await runEntry(['prepare', '--upstream-ref', 'v1', '--strategy', 'bogus']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Unknown strategy: bogus');
  });

  it('rejects an unknown --status value', async () => {
    const { stderr } = await runEntry(['ack', '--id', 'tx-1', '--requirement', 'req-1', '--status', 'bogus']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Unknown status: bogus');
  });

  it('splits and filters --commits, honors --project-root and --dry-run', async () => {
    mocks.pruneTransactions.mockReturnValue({
      schema: 'nanoclaw-update-prune/v1',
      keepId: 'tx-1',
      dryRun: true,
      removed: [],
      retained: ['tx-1'],
    });

    const { stdout } = await runEntry(['prune', '--project-root', '/tmp/some-root', '--id', 'tx-1', '--dry-run']);

    expect(mocks.pruneTransactions).toHaveBeenCalledWith(path.resolve('/tmp/some-root'), 'tx-1', true);
    const output = JSON.parse(stdout.join(''));
    expect(output).toEqual({
      schema: 'nanoclaw-update-prune/v1',
      keepId: 'tx-1',
      dryRun: true,
      removed: [],
      retained: ['tx-1'],
    });
    // prune output bypasses summarizeState entirely
    expect(mocks.summarizeState).not.toHaveBeenCalled();
  });

  it('defaults --dry-run to false and defaults --project-root to cwd when omitted', async () => {
    mocks.pruneTransactions.mockReturnValue({
      schema: 'nanoclaw-update-prune/v1',
      keepId: 'tx-1',
      dryRun: false,
      removed: [],
      retained: [],
    });

    await runEntry(['prune', '--id', 'tx-1']);

    expect(mocks.pruneTransactions).toHaveBeenCalledWith(process.cwd(), 'tx-1', false);
  });
});

describe('execute() command dispatch via the CLI entry', () => {
  it('prepares an update with upstream-ref, strategy, and parsed commits', async () => {
    mocks.prepareUpdate.mockReturnValue(updateState({ phase: 'prepared' }));

    const { stdout } = await runEntry([
      'prepare',
      '--upstream-ref',
      'v2.3.0',
      '--strategy',
      'rebase',
      '--commits',
      'abc,,def',
    ]);

    expect(mocks.prepareUpdate).toHaveBeenCalledWith({
      projectRoot: process.cwd(),
      upstreamRef: 'v2.3.0',
      strategy: 'rebase',
      commits: ['abc', 'def'],
    });
    const output = JSON.parse(stdout.join(''));
    expect(output).toEqual({ summarized: true, schema: 'nanoclaw-update/v1', phase: 'prepared' });
  });

  it('requires --upstream-ref for prepare', async () => {
    const { stderr, exitCode } = await runEntry(['prepare']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Missing --upstream-ref');
    expect(exitCode).toBe(1);
  });

  it('requires --id for every non-prepare command', async () => {
    const { stderr } = await runEntry(['status']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Missing --id');
  });

  it('resumes a prepared update', async () => {
    mocks.resumePreparedUpdate.mockReturnValue(updateState({ phase: 'prepared' }));
    await runEntry(['resume', '--id', 'tx-1']);
    expect(mocks.resumePreparedUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('validates an update', async () => {
    mocks.validateUpdate.mockReturnValue(updateState({ phase: 'validated' }));
    await runEntry(['validate', '--id', 'tx-1']);
    expect(mocks.validateUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('cuts over an update', async () => {
    mocks.cutoverUpdate.mockReturnValue(updateState({ phase: 'cutover' }));
    await runEntry(['cutover', '--id', 'tx-1']);
    expect(mocks.cutoverUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('acknowledges a requirement with a rollback note', async () => {
    mocks.acknowledgeRequirement.mockReturnValue(updateState());
    await runEntry([
      'ack',
      '--id',
      'tx-1',
      '--requirement',
      'req-1',
      '--status',
      'succeeded',
      '--rollback',
      'reverted locally',
    ]);
    expect(mocks.acknowledgeRequirement).toHaveBeenCalledWith(
      process.cwd(),
      'tx-1',
      'req-1',
      'succeeded',
      'reverted locally',
    );
  });

  it('acknowledges a requirement with no rollback note', async () => {
    mocks.acknowledgeRequirement.mockReturnValue(updateState());
    await runEntry(['ack', '--id', 'tx-1', '--requirement', 'req-1', '--status', 'failed']);
    expect(mocks.acknowledgeRequirement).toHaveBeenCalledWith(process.cwd(), 'tx-1', 'req-1', 'failed', undefined);
  });

  it('requires --requirement for ack', async () => {
    const { stderr } = await runEntry(['ack', '--id', 'tx-1', '--status', 'succeeded']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Missing --requirement');
  });

  it('finishes an update', async () => {
    mocks.finishUpdate.mockReturnValue(updateState({ phase: 'complete' }));
    await runEntry(['finish', '--id', 'tx-1']);
    expect(mocks.finishUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('rolls back an update', async () => {
    mocks.rollbackUpdate.mockReturnValue(updateState({ phase: 'rolled-back' }));
    await runEntry(['rollback', '--id', 'tx-1']);
    expect(mocks.rollbackUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('cleans up an update', async () => {
    mocks.cleanupUpdate.mockReturnValue(updateState());
    await runEntry(['cleanup', '--id', 'tx-1']);
    expect(mocks.cleanupUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('abandons an update', async () => {
    mocks.abandonUpdate.mockReturnValue(updateState({ phase: 'abandoned' }));
    await runEntry(['abandon', '--id', 'tx-1']);
    expect(mocks.abandonUpdate).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('loads status', async () => {
    mocks.loadState.mockReturnValue(updateState());
    await runEntry(['status', '--id', 'tx-1']);
    expect(mocks.loadState).toHaveBeenCalledWith(process.cwd(), 'tx-1');
  });

  it('rejects an unknown command after --id is validated', async () => {
    const { stderr, exitCode } = await runEntry(['bogus-command', '--id', 'tx-1']);
    const err = JSON.parse(stderr.join(''));
    expect(err.error).toBe('Unknown command: bogus-command');
    expect(exitCode).toBe(1);
  });
});

describe('main() output shaping', () => {
  it('sets exitCode 2 when the result reaches a conflict phase', async () => {
    mocks.validateUpdate.mockReturnValue(updateState({ phase: 'conflict' }));
    const { exitCode, stdout } = await runEntry(['validate', '--id', 'tx-1']);
    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ phase: 'conflict' });
  });

  it('leaves exitCode unset for a non-conflict phase', async () => {
    mocks.validateUpdate.mockReturnValue(updateState({ phase: 'validated' }));
    const { exitCode } = await runEntry(['validate', '--id', 'tx-1']);
    expect(exitCode).toBeUndefined();
  });

  it('stringifies a non-Error rejection instead of crashing', async () => {
    mocks.loadState.mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'a raw failure';
    });
    const { stderr, exitCode } = await runEntry(['status', '--id', 'tx-1']);
    const err = JSON.parse(stderr.join(''));
    expect(err).toEqual({ schema: 'nanoclaw-update-error/v1', error: 'a raw failure' });
    expect(exitCode).toBe(1);
  });
});

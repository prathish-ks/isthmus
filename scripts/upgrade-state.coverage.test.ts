import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * scripts/upgrade-state.ts is a thin CLI wrapper with top-level side effects
 * (it reads process.argv and prints/exits at module-load time). We mock the
 * src/upgrade-state.js collaborators it delegates to and re-import fresh for
 * each scenario, restoring process.argv/console/process.exit afterward.
 */

const originalArgv = process.argv;

const mocks = vi.hoisted(() => ({
  getCodeVersion: vi.fn(),
  markerPath: vi.fn(),
  readUpgradeState: vi.fn(),
  writeUpgradeState: vi.fn(),
}));

vi.mock('../src/upgrade-state.js', () => ({
  getCodeVersion: mocks.getCodeVersion,
  markerPath: mocks.markerPath,
  readUpgradeState: mocks.readUpgradeState,
  writeUpgradeState: mocks.writeUpgradeState,
}));

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  Object.values(mocks).forEach((m) => m.mockReset());
});

async function run(args: string[]): Promise<void> {
  vi.resetModules();
  process.argv = ['node', '/fake/scripts/upgrade-state.ts', ...args];
  await import('./upgrade-state.js');
}

describe('scripts/upgrade-state.ts CLI', () => {
  it('prints the stored state as JSON for `get` when a marker exists', async () => {
    const state = { version: '2.3.0', commit: 'abc', tree: 'def', updatedAt: '2026-01-01T00:00:00.000Z', via: 'setup' };
    mocks.readUpgradeState.mockReturnValue(state);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['get']);

    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(state));
  });

  it('prints "none" for `get` when no marker exists', async () => {
    mocks.readUpgradeState.mockReturnValue(null);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['get']);

    expect(logSpy).toHaveBeenCalledWith('none');
  });

  it('stamps an explicit version and via for `set`', async () => {
    const written = { version: '9.9.9', commit: 'c', tree: 't', updatedAt: 'now', via: 'ci' };
    mocks.writeUpgradeState.mockReturnValue(written);
    mocks.markerPath.mockReturnValue('/data/upgrade-state.json');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['set', '9.9.9', 'ci']);

    expect(mocks.writeUpgradeState).toHaveBeenCalledWith({ version: '9.9.9', via: 'ci' });
    expect(logSpy).toHaveBeenCalledWith(`Stamped /data/upgrade-state.json: ${JSON.stringify(written)}`);
  });

  it('falls back to the code version and "manual" via when `set` is given no arguments', async () => {
    mocks.getCodeVersion.mockReturnValue('2.3.0');
    mocks.writeUpgradeState.mockReturnValue({
      version: '2.3.0',
      commit: 'c',
      tree: 't',
      updatedAt: 'now',
      via: 'manual',
    });
    mocks.markerPath.mockReturnValue('/data/upgrade-state.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['set']);

    expect(mocks.getCodeVersion).toHaveBeenCalled();
    expect(mocks.writeUpgradeState).toHaveBeenCalledWith({ version: '2.3.0', via: 'manual' });
  });

  it('prints usage and exits 2 for an unknown command', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await run(['bogus']);

    expect(errorSpy).toHaveBeenCalledWith('Usage: pnpm exec tsx scripts/upgrade-state.ts get | set [version] [via]');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('prints usage and exits 2 when no command is given', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await run([]);

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

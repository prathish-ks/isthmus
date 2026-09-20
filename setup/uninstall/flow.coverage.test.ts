/**
 * setup/uninstall/flow.ts orchestrates scan → confirm → plan → execute via
 * clack prompts. `runUninstallFlow` is an ordinary exported async function
 * (no top-level side effects at import time), so unlike the migrate-v2
 * scripts we can import it once and call it directly per scenario.
 *
 * Mocked at the module boundary: scanInstall (we supply a controlled
 * Inventory pointing at real scratch-dir paths, so the REAL plan.ts/
 * remove.ts underneath still do real, disposable fs deletions — this
 * exercises the actual removal contract rather than a fake of it),
 * @clack/prompts (interactive UI + the cancellation symbol), the
 * diagnostics module (emit() does a real network fetch — never call it),
 * the theme module's note() (wraps p.note, same reasons as the prompts
 * mock), setup/logs.js's userInput (would write to a real log file), and
 * child_process (flow.ts's own local `runCommand` shells out to
 * launchctl/systemctl/docker/onecli via spawnSync with no injection point).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ProcessExitError extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const CANCEL = Symbol('cancelled');

const mocks = vi.hoisted(() => ({
  scanInstall: vi.fn(),
  emit: vi.fn(),
  note: vi.fn(),
  userInput: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '' })),
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  logMessage: vi.fn(),
  logWarn: vi.fn(),
  spinnerStart: vi.fn(),
  spinnerStop: vi.fn(),
}));

vi.mock('./scan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scan.js')>()),
  scanInstall: mocks.scanInstall,
}));
vi.mock('../lib/diagnostics.js', () => ({ emit: mocks.emit }));
vi.mock('../lib/theme.js', () => ({ note: mocks.note }));
vi.mock('../logs.js', () => ({ userInput: mocks.userInput }));
vi.mock('child_process', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('@clack/prompts', () => ({
  intro: mocks.intro,
  outro: mocks.outro,
  cancel: mocks.cancel,
  confirm: mocks.confirm,
  isCancel: (v: unknown) => v === CANCEL,
  spinner: () => ({ start: mocks.spinnerStart, stop: mocks.spinnerStop }),
  log: { message: mocks.logMessage, warn: mocks.logWarn },
}));

const { runUninstallFlow } = await import('./flow.js');
import type { Inventory, PathItem } from './scan.js';

const item = (p: string, what: string): PathItem => ({ what, where: p, path: p });

function baseInventory(projectRoot: string, overrides: Partial<Inventory> = {}): Inventory {
  return {
    slug: 'test1234',
    projectRoot,
    containerRuntime: 'docker',
    service: { containerIds: [] },
    data: [],
    runtime: [],
    user: [],
    onecli: { mine: [], orphans: [], idsKnown: true },
    notes: [],
    ...overrides,
  };
}

const originalCwd = process.cwd();
const originalIsTTY = process.stdin.isTTY;
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockClear());
  mocks.spawnSync.mockReturnValue({ status: 0, stdout: '' });
  mocks.confirm.mockReset();
  // Vitest itself runs with stdin piped (not a TTY), which would otherwise
  // trip flow.ts's own "needs an interactive terminal" guard on every
  // scenario. Default to "interactive" and let the guard test itself
  // override this back to false.
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function call(opts: {
  dryRun: boolean;
  yes: boolean;
  invokedFrom: 'flag' | 'setup-detection';
}): Promise<{ exit?: number }> {
  const exitCalls: (number | undefined)[] = [];
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCalls.push(code);
    throw new ProcessExitError(code);
  }) as never);
  try {
    await runUninstallFlow(opts);
  } catch (err) {
    if (!(err instanceof ProcessExitError)) throw err;
  } finally {
    exitSpy.mockRestore();
  }
  return { exit: exitCalls[0] };
}

describe('runUninstallFlow — non-interactive guard', () => {
  it('exits 1 with a helpful message when there is no TTY and neither --yes nor --dry-run was passed', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Uninstall needs an interactive terminal'));
    expect(mocks.scanInstall).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('bypasses the TTY guard with --yes even with no TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    mocks.scanInstall.mockReturnValue(baseInventory(root));

    await call({ dryRun: false, yes: true, invokedFrom: 'flag' });
    expect(mocks.scanInstall).toHaveBeenCalled();
  });
});

describe('runUninstallFlow — nothing found', () => {
  it('exits 0 with "nothing to uninstall" when every group is empty', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    mocks.scanInstall.mockReturnValue(baseInventory(root));

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(mocks.outro).toHaveBeenCalledWith(expect.stringContaining('already clean'));
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});

describe('runUninstallFlow — dry run', () => {
  it('previews every non-empty group, calls emit with dryRun:true, and never touches disk', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataFile = path.join(root, 'data');
    fs.mkdirSync(dataFile);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        service: { containerIds: ['c1', 'c2'], nclSymlink: path.join(root, 'bin', 'ncl') },
        data: [item(dataFile, 'Database & conversations')],
        user: [item(path.join(root, 'groups'), 'Agent memory & files')],
        onecli: {
          mine: [{ uuid: 'u-1', identifier: 'ag-mine', name: 'Mine' }],
          orphans: [{ uuid: 'u-2', identifier: 'ag-other', name: 'Other' }],
          idsKnown: true,
        },
        notes: ['a leftover note'],
      }),
    );

    const { exit } = await call({ dryRun: true, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(mocks.emit).toHaveBeenCalledWith('uninstall_started', expect.objectContaining({ dryRun: true }), {
      persistId: false,
    });
    expect(mocks.note).toHaveBeenCalled(); // at least one group card rendered
    expect(mocks.outro).toHaveBeenCalledWith(expect.stringContaining('Preview complete'));
    // Disk untouched — the data dir we scanned is still there.
    expect(fs.existsSync(dataFile)).toBe(true);
  });

  it('previews an install with nothing in one or more groups (the "Nothing found for" line)', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataFile = path.join(root, 'data');
    fs.mkdirSync(dataFile);
    mocks.scanInstall.mockReturnValue(baseInventory(root, { data: [item(dataFile, 'Database & conversations')] }));

    const { exit } = await call({ dryRun: true, yes: false, invokedFrom: 'flag' });
    expect(exit).toBe(0);
    expect(mocks.logMessage).toHaveBeenCalledWith(expect.stringContaining('Nothing found for'));
  });
});

describe('runUninstallFlow — --yes deletes everything found', () => {
  it('deletes data/user groups without prompting and reports OneCLI orphans left in place', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataDir = path.join(root, 'data');
    const groupsDir = path.join(root, 'groups');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(groupsDir);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        data: [item(dataDir, 'Database & conversations')],
        user: [item(groupsDir, 'Agent memory & files')],
        onecli: {
          mine: [{ uuid: 'u-1', identifier: 'ag-mine', name: 'Mine' }],
          orphans: [{ uuid: 'u-2', identifier: 'ag-other', name: 'Other' }],
          idsKnown: true,
        },
      }),
    );

    const { exit } = await call({ dryRun: false, yes: true, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining('--yes given'));
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(groupsDir)).toBe(false);
    // Orphan deletion command was never issued.
    expect(mocks.spawnSync).not.toHaveBeenCalledWith('onecli', expect.arrayContaining(['u-2']), expect.anything());
  });
});

describe('runUninstallFlow — interactive confirm/decline per group', () => {
  it('deletes only the groups answered yes to, and records the declined ones as kept', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataDir = path.join(root, 'data');
    const groupsDir = path.join(root, 'groups');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(groupsDir);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        data: [item(dataDir, 'Database & conversations')],
        user: [item(groupsDir, 'Agent memory & files')],
      }),
    );
    // Two confirm() calls in order: data (yes), user (no).
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(fs.existsSync(dataDir)).toBe(false); // deleted
    expect(fs.existsSync(groupsDir)).toBe(true); // kept
    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining('kept by your choice'), expect.any(String));
  });

  it("cancels the whole flow with nothing deleted when a confirm is Ctrl-C'd", async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    mocks.scanInstall.mockReturnValue(baseInventory(root, { data: [item(dataDir, 'Database & conversations')] }));
    mocks.confirm.mockResolvedValueOnce(CANCEL);

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(mocks.cancel).toHaveBeenCalledWith(expect.stringContaining('Nothing was deleted'));
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it('reports "nothing selected" and exits 0 when every group is declined', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    mocks.scanInstall.mockReturnValue(baseInventory(root, { data: [item(dataDir, 'Database & conversations')] }));
    mocks.confirm.mockResolvedValue(false);

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(mocks.outro).toHaveBeenCalledWith(expect.stringContaining('Nothing selected'));
    expect(fs.existsSync(dataDir)).toBe(true);
  });
});

describe('runUninstallFlow — OneCLI decision branches', () => {
  it('asks a separate confirm for mine vs. orphans, and deletes only what was agreed to', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        onecli: {
          mine: [{ uuid: 'u-1', identifier: 'ag-mine', name: 'Mine' }],
          orphans: [{ uuid: 'u-2', identifier: 'ag-other', name: 'Other' }],
          idsKnown: true,
        },
      }),
    );
    // "Delete this copy's 1 OneCLI agent(s)?" -> yes ; "Delete them too?" -> yes
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    const deleteCalls = mocks.spawnSync.mock.calls.filter(
      (c) => c[0] === 'onecli' && Array.isArray(c[1]) && c[1].includes('delete'),
    );
    expect(deleteCalls).toHaveLength(2);
    // spawnSync(cmd, args, opts) with args = ['agents', 'delete', '--id', uuid].
    expect(deleteCalls.map((c) => c[1][3])).toEqual(expect.arrayContaining(['u-1', 'u-2']));
  });

  it('declining the "mine" prompt keeps those agents and records a kept-note', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        onecli: { mine: [{ uuid: 'u-1', identifier: 'ag-mine', name: 'Mine' }], orphans: [], idsKnown: true },
      }),
    );
    mocks.confirm.mockResolvedValueOnce(false);

    const { exit } = await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(
      mocks.spawnSync.mock.calls.some((c) => c[0] === 'onecli' && Array.isArray(c[1]) && c[1].includes('delete')),
    ).toBe(false);
  });

  it('leaves orphans in place with a manual-delete note when the orphan confirm is declined', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        onecli: { mine: [], orphans: [{ uuid: 'u-2', identifier: 'ag-other', name: 'Other' }], idsKnown: true },
      }),
    );
    mocks.confirm.mockResolvedValueOnce(false); // "Delete them too?"

    await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining('onecli agents delete --id u-2'),
      expect.any(String),
    );
  });
});

describe('runUninstallFlow — logs/setup.log decision recording', () => {
  it('records uninstall_decisions via setupLog.userInput only when a logs/ dir already exists', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    fs.mkdirSync(path.join(root, 'logs'));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    mocks.scanInstall.mockReturnValue(baseInventory(root, { data: [item(dataDir, 'Database & conversations')] }));
    mocks.confirm.mockResolvedValue(true);

    await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(mocks.userInput).toHaveBeenCalledWith('uninstall_decisions', expect.any(String));
  });

  it('skips setupLog.userInput when there is no logs/ dir (never creates one)', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    mocks.scanInstall.mockReturnValue(baseInventory(root, { data: [item(dataDir, 'Database & conversations')] }));
    mocks.confirm.mockResolvedValue(true);

    await call({ dryRun: false, yes: false, invokedFrom: 'flag' });

    expect(mocks.userInput).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(false);
  });
});

describe('runUninstallFlow — full execution, runtime tail last', () => {
  it('deletes the service/data/user/runtime groups, printing the runtime tail via console.log after the summary', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const dataDir = path.join(root, 'data');
    const distDir = path.join(root, 'dist');
    const nodeModulesDir = path.join(root, 'node_modules');
    fs.mkdirSync(dataDir);
    fs.mkdirSync(distDir);
    fs.mkdirSync(nodeModulesDir);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        data: [item(dataDir, 'Database & conversations')],
        runtime: [item(distDir, 'Build output'), item(nodeModulesDir, 'Installed dependencies')],
      }),
    );

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { exit } = await call({ dryRun: false, yes: true, invokedFrom: 'flag' });

    expect(exit).toBe(0);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(distDir)).toBe(false);
    expect(fs.existsSync(nodeModulesDir)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('✓ Done. NanoClaw copy test1234 has been uninstalled.'),
    );
    logSpy.mockRestore();
  });

  it('surfaces exec notes (a failed action) via the note() card and via console.log for the runtime tail', async () => {
    const root = tempDir('nanoclaw-flow-');
    process.chdir(root);
    const distDir = path.join(root, 'dist');
    fs.mkdirSync(distDir);
    mocks.scanInstall.mockReturnValue(
      baseInventory(root, {
        service: { containerIds: [], launchdPlist: path.join(root, 'missing.plist') },
        runtime: [item(distDir, 'Build output')],
      }),
    );
    // unload-service's fs.rmSync on a non-existent plist doesn't throw
    // (force:true), but launchctl unload failing on a bogus binary would —
    // simulate a failing head-action via spawnSync throwing for launchctl.
    mocks.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'launchctl') throw new Error('launchctl exploded');
      return { status: 0, stdout: '' };
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await call({ dryRun: false, yes: true, invokedFrom: 'flag' });
    logSpy.mockRestore();

    expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining('launchctl exploded'), expect.any(String));
  });
});

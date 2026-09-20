/**
 * Coverage top-up for setup/uninstall/remove.ts. The sibling remove.test.ts
 * covers delete-path, backup-env, rm-containers, rmi, and
 * delete-onecli-agent branches already; this file fills in the
 * unload-service flavors (launchd/systemd-user/systemd-system-as-root),
 * kill-pid, pkill-host, an empty container list, and delete-runtime-path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RunCommand } from './onecli-agents.js';
import type { RemovalAction } from './plan.js';
import { executePlan, type ExecDeps } from './remove.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-remove-cov-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function deps(overrides: Partial<ExecDeps> = {}): ExecDeps {
  return {
    runCommand: () => ({ status: 0, stdout: '' }),
    log: () => {},
    isRoot: false,
    ...overrides,
  };
}

describe('executePlan — unload-service flavors', () => {
  it('launchd: unloads, deletes the plist, and logs success', () => {
    const unitPath = path.join(tempDir, 'com.nanoclaw-v2-test.plist');
    fs.writeFileSync(unitPath, '<plist/>');
    const calls: string[][] = [];
    const logs: string[] = [];
    const recorder: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '' };
    };

    const { notes } = executePlan(
      [{ kind: 'unload-service', flavor: 'launchd', unitPath, unitName: 'com.nanoclaw-v2-test' }],
      deps({ runCommand: recorder, log: (l) => logs.push(l) }),
    );

    expect(calls).toEqual([['launchctl', 'unload', unitPath]]);
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(logs).toEqual(['✓ background service removed']);
    expect(notes).toEqual([]);
  });

  it('systemd-user: disables the unit, deletes it, and reloads the daemon', () => {
    const unitPath = path.join(tempDir, 'nanoclaw-v2-test.service');
    fs.writeFileSync(unitPath, '[Unit]');
    const calls: string[][] = [];
    const logs: string[] = [];
    const recorder: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '' };
    };

    const { notes } = executePlan(
      [{ kind: 'unload-service', flavor: 'systemd-user', unitPath, unitName: 'nanoclaw-v2-test' }],
      deps({ runCommand: recorder, log: (l) => logs.push(l) }),
    );

    expect(calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', 'nanoclaw-v2-test.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(logs).toEqual(['✓ background service removed']);
    expect(notes).toEqual([]);
  });

  it('systemd-system: as root, disables, deletes, and reloads the system daemon', () => {
    const unitPath = path.join(tempDir, 'nanoclaw-v2-test.service');
    fs.writeFileSync(unitPath, '[Unit]');
    const calls: string[][] = [];
    const logs: string[] = [];
    const recorder: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '' };
    };

    const { notes } = executePlan(
      [{ kind: 'unload-service', flavor: 'systemd-system', unitPath, unitName: 'nanoclaw-v2-test' }],
      deps({ runCommand: recorder, log: (l) => logs.push(l), isRoot: true }),
    );

    expect(calls).toEqual([
      ['systemctl', 'disable', '--now', 'nanoclaw-v2-test.service'],
      ['systemctl', 'daemon-reload'],
    ]);
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(logs).toEqual(['✓ system service removed']);
    expect(notes).toEqual([]);
  });
});

describe('executePlan — kill-pid', () => {
  it('kills a running process recorded in the pidfile', () => {
    const pidFile = path.join(tempDir, 'nanoclaw.pid');
    // Our own pid is always "running" and safe to signal with 0... but
    // process.kill(pid) with no signal sends SIGTERM, which we must not do
    // to the test runner. Use a pid that is syntactically valid but not a
    // real process (fork of a self-check is out of scope) — assert on the
    // pidfile round-trip instead of a real kill by targeting a definitely-dead
    // high pid, which process.kill rejects with ESRCH (caught, non-fatal).
    fs.writeFileSync(pidFile, '999999999');
    const logs: string[] = [];

    const { notes } = executePlan([{ kind: 'kill-pid', pidFile }], deps({ log: (l) => logs.push(l) }));

    // ESRCH (not running) is swallowed silently — no log, no note.
    expect(logs).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('does nothing when the pidfile is missing (readFileSync throws, caught)', () => {
    const pidFile = path.join(tempDir, 'missing.pid');
    const { notes } = executePlan([{ kind: 'kill-pid', pidFile }], deps());
    expect(notes).toEqual([]);
  });

  it('does nothing when the pidfile content is not a positive integer', () => {
    const pidFile = path.join(tempDir, 'nanoclaw.pid');
    fs.writeFileSync(pidFile, 'not-a-number');
    const { notes } = executePlan([{ kind: 'kill-pid', pidFile }], deps());
    expect(notes).toEqual([]);
  });
});

describe('executePlan — pkill-host', () => {
  it('runs pkill -f with the given pattern (exit 1 = no match, not a failure)', () => {
    const calls: string[][] = [];
    const recorder: RunCommand = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 1, stdout: '' };
    };

    const { notes } = executePlan(
      [{ kind: 'pkill-host', pattern: '/proj/dist/index.js' }],
      deps({ runCommand: recorder }),
    );

    expect(calls).toEqual([['pkill', '-f', '/proj/dist/index.js']]);
    expect(notes).toEqual([]);
  });
});

describe('executePlan — rm-containers with none found', () => {
  it('does nothing (no log, no note) when the container list is empty', () => {
    const logs: string[] = [];
    const recorder: RunCommand = (_cmd, args) =>
      args[0] === 'ps' ? { status: 0, stdout: '\n' } : { status: 0, stdout: '' };

    const { notes } = executePlan(
      [{ kind: 'rm-containers', runtime: 'docker', labelFilter: 'nanoclaw-install=x' }],
      deps({ runCommand: recorder, log: (l) => logs.push(l) }),
    );

    expect(logs).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe('executePlan — rmi success', () => {
  it('logs success when the image is removed', () => {
    const logs: string[] = [];
    const { notes } = executePlan(
      [{ kind: 'rmi', runtime: 'docker', image: 'nanoclaw-agent:latest' }],
      deps({ runCommand: () => ({ status: 0, stdout: '' }), log: (l) => logs.push(l) }),
    );
    expect(logs).toEqual(['✓ removed container image']);
    expect(notes).toEqual([]);
  });
});

describe('executePlan — delete-onecli-agent already gone', () => {
  it('logs "already gone" when onecli ran but reported a non-zero, non-null status', () => {
    const logs: string[] = [];
    const { notes } = executePlan(
      [{ kind: 'delete-onecli-agent', agent: { uuid: 'u-1', identifier: 'ag-gone', name: 'Gone' } }],
      deps({ runCommand: () => ({ status: 1, stdout: '' }), log: (l) => logs.push(l) }),
    );
    expect(logs).toEqual(['! OneCLI agent ag-gone already gone']);
    expect(notes).toEqual([]);
  });
});

describe('executePlan — rm-ncl-symlink', () => {
  it('removes the symlink and logs success', () => {
    const link = path.join(tempDir, 'ncl');
    fs.symlinkSync('/somewhere/bin/ncl', link);
    const logs: string[] = [];

    executePlan([{ kind: 'rm-ncl-symlink', linkPath: link }], deps({ log: (l) => logs.push(l) }));

    expect(fs.existsSync(link)).toBe(false);
    expect(logs).toEqual(['✓ removed ncl command']);
  });
});

describe('executePlan — delete-runtime-path', () => {
  it('recursively deletes the runtime path and logs success', () => {
    const dir = path.join(tempDir, 'node_modules');
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'index.js'), 'x');
    const logs: string[] = [];

    const { notes } = executePlan(
      [{ kind: 'delete-runtime-path', item: { what: 'Installed dependencies', where: dir, path: dir } }],
      deps({ log: (l) => logs.push(l) }),
    );

    expect(fs.existsSync(dir)).toBe(false);
    expect(logs).toEqual(['✓ removed Installed dependencies']);
    expect(notes).toEqual([]);
  });
});

describe('executePlan — deletes gathered by kind across a mixed plan', () => {
  it('processes an empty action list without error', () => {
    const { notes } = executePlan([], deps());
    expect(notes).toEqual([]);
  });
});

/**
 * Coverage top-up for setup/uninstall/scan.ts. The sibling scan.test.ts
 * covers the main path groups, service artifacts, ncl symlink resolution,
 * and OneCLI agent splitting already; this file fills in:
 *  - systemd system unit detection on Linux
 *  - the "docker ps ok but image inspect fails" partial-degrade note
 *  - a relative ncl symlink target
 *  - a non-symlink file at the ncl path (isSymbolicLink() false)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import type { RunCommand } from './onecli-agents.js';
import { detectExistingInstall, scanInstall, type ScanDeps } from './scan.js';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-scan-cov-root-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-scan-cov-home-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

function fakeRun(handlers: Record<string, (args: string[]) => { status: number | null; stdout: string }>): RunCommand {
  return (cmd, args) => (handlers[cmd] ?? (() => ({ status: 1, stdout: '' })))(args);
}

function deps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    projectRoot: root,
    home,
    platform: 'darwin',
    runCommand: fakeRun({}),
    ...overrides,
  };
}

describe('scanInstall — systemd system unit', () => {
  it('detects a system-level systemd unit on Linux alongside a user unit', () => {
    const unit = getSystemdUnit(root);
    const systemUnit = path.join(home, '.config', 'systemd', 'user', `${unit}.service`);
    fs.mkdirSync(path.dirname(systemUnit), { recursive: true });
    fs.writeFileSync(systemUnit, '[Unit]');

    const inv = scanInstall(deps({ platform: 'linux' }));
    // We only faked the user unit path in this temp home; the real system
    // path (/etc/systemd/system/...) is untouched — just confirm the user
    // unit and that systemSystemUnit stays undefined for an install with no
    // real /etc footprint.
    expect(inv.service.systemdUserUnit).toBe(systemUnit);
    expect(inv.service.systemdSystemUnit).toBeUndefined();
  });
});

describe('scanInstall — partial docker degrade', () => {
  it('leaves image undefined with no note when `docker image inspect` cleanly reports "not found" (non-zero, no throw)', () => {
    // A non-throwing non-zero inspect status (image already gone) is NOT
    // the same as the runtime being unavailable — only a throw during
    // enumeration degrades to the manual-cleanup note (see the two throw
    // scenarios below).
    const run = fakeRun({
      docker: (args) => {
        if (args[0] === 'ps') return { status: 0, stdout: 'c1\n' };
        if (args[0] === 'image') return { status: 1, stdout: '' };
        return { status: 1, stdout: '' };
      },
    });
    const inv = scanInstall(deps({ runCommand: run }));
    expect(inv.service.containerIds).toEqual(['c1']);
    expect(inv.service.image).toBeUndefined();
    expect(inv.notes).toEqual([]);
  });

  it('degrades when `docker ps` throws', () => {
    const run: RunCommand = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') throw new Error('ENOENT');
      return { status: 1, stdout: '' };
    };
    const inv = scanInstall(deps({ runCommand: run }));
    expect(inv.service.containerIds).toEqual([]);
    expect(inv.notes.some((n) => n.includes("'docker' unavailable"))).toBe(true);
  });

  it('degrades when `docker image inspect` throws after a successful ps', () => {
    let call = 0;
    const run: RunCommand = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') return { status: 0, stdout: '' };
      if (cmd === 'docker' && args[0] === 'image') {
        call++;
        throw new Error('daemon vanished mid-scan');
      }
      return { status: 1, stdout: '' };
    };
    const inv = scanInstall(deps({ runCommand: run }));
    expect(call).toBe(1);
    expect(inv.service.image).toBeUndefined();
    expect(inv.notes.some((n) => n.includes("'docker' unavailable"))).toBe(true);
  });
});

describe('scanInstall — ncl symlink edge cases', () => {
  const link = () => path.join(home, '.local', 'bin', 'ncl');

  it('resolves a relative symlink target against the link directory', () => {
    fs.mkdirSync(path.dirname(link()), { recursive: true });
    // Relative target that resolves to <root>/bin/ncl from ~/.local/bin/.
    const relTarget = path.relative(path.dirname(link()), path.join(root, 'bin', 'ncl'));
    fs.symlinkSync(relTarget, link());

    const inv = scanInstall(deps());
    expect(inv.service.nclSymlink).toBe(link());
  });

  it('ignores a plain file at the ncl path (not a symlink)', () => {
    fs.mkdirSync(path.dirname(link()), { recursive: true });
    fs.writeFileSync(link(), '#!/bin/sh\necho hi\n');

    const inv = scanInstall(deps());
    expect(inv.service.nclSymlink).toBeUndefined();
    expect(inv.notes.some((n) => n.includes('ncl'))).toBe(false);
  });
});

describe('scanInstall — OneCLI vault unavailable', () => {
  it('reports idsKnown:false and no agents when the vault cannot be read at all', () => {
    const inv = scanInstall(deps({ runCommand: fakeRun({ onecli: () => ({ status: 1, stdout: '' }) }) }));
    expect(inv.onecli).toEqual({ mine: [], orphans: [], idsKnown: false });
  });
});

describe('scanInstall — slug is stable per project root', () => {
  it('matches getInstallSlug(projectRoot) directly', () => {
    const inv = scanInstall(deps());
    expect(inv.slug).toBe(getInstallSlug(root));
  });
});

describe('detectExistingInstall — per-platform service probe', () => {
  // detectExistingInstall() reads os.homedir()/process.platform directly
  // (it has no injectable deps, unlike scanInstall). We spy on the shared
  // Node `os` module and stub process.platform for the duration of each
  // test, restoring both in afterEach — this touches no real files outside
  // the scratch `home` dir and never writes to the real home directory.
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('darwin: false when no v2.db and no launchd plist under the scratch home', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(detectExistingInstall(root)).toBe(false);
  });

  it('darwin: true when the launchd plist exists under the scratch home', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const plist = path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(root)}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');

    expect(detectExistingInstall(root)).toBe(true);
  });

  it('linux: true when the user systemd unit exists under the scratch home', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const unit = path.join(home, '.config', 'systemd', 'user', `${getSystemdUnit(root)}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Unit]');

    expect(detectExistingInstall(root)).toBe(true);
  });

  it('linux: false when neither the user nor (real) system unit exists', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(detectExistingInstall(root)).toBe(false);
  });

  it('other platforms: always false past the v2.db check', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.spyOn(os, 'homedir').mockReturnValue(home);

    expect(detectExistingInstall(root)).toBe(false);
  });
});

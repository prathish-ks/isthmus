/**
 * Coverage for setup/service.ts — the `service` step that builds the
 * project, stamps the upgrade marker, runs the peer-cleanup preflight, and
 * installs the OS service (launchd plist / systemd unit / nohup wrapper)
 * plus the `ncl` CLI symlink.
 *
 * `./platform.js` is mocked wholesale so every OS-detection function
 * (getPlatform, getNodePath, getServiceManager, isRoot, etc.) is directly
 * controllable per test rather than depending on the real host's actual
 * platform, PATH, or /proc contents. `./peer-cleanup.js` and
 * `../src/upgrade-state.js` are mocked too — both are separate collaborators
 * covered by their own sibling test files, not part of this file's surface.
 * `child_process`'s `execSync` is mocked so no real launchctl/systemctl/
 * docker/sudo/loginctl command ever runs. Real fs + a temp directory (used
 * as both `process.cwd()` and `os.homedir()`) exercise the actual
 * plist/unit/wrapper/symlink writes service.ts performs — except the
 * root-owned systemd path, which targets a real absolute `/etc/...` path;
 * for that one case `fs.writeFileSync`/`mkdirSync` are spied on and redirected
 * away from `/etc` so the test can never touch the real filesystem there.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown> & { step: string }>);
vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    emitted.push({ step, ...fields });
  }),
}));

const mockPlatform = vi.hoisted(() => ({
  commandExists: vi.fn((_name: string) => false),
  getPlatform: vi.fn(() => 'macos' as 'macos' | 'linux' | 'unknown'),
  getNodePath: vi.fn(() => '/usr/local/bin/node'),
  getServiceManager: vi.fn(() => 'launchd' as 'launchd' | 'systemd' | 'none'),
  hasSystemd: vi.fn(() => false),
  isRoot: vi.fn(() => false),
  isWSL: vi.fn(() => false),
}));
vi.mock('./platform.js', () => mockPlatform);

const mockPeerCleanup = vi.hoisted(() => ({
  cleanupUnhealthyPeers: vi.fn(() => ({ checked: [], unloaded: [], removed: [], failures: [] })),
}));
vi.mock('./peer-cleanup.js', () => mockPeerCleanup);

const mockUpgradeState = vi.hoisted(() => ({
  writeUpgradeState: vi.fn(() => ({
    version: 'test-version',
    commit: 'abc',
    tree: 'def',
    updatedAt: 'now',
    via: 'setup',
  })),
}));
vi.mock('../src/upgrade-state.js', () => mockUpgradeState);

const state = vi.hoisted(() => ({
  failPatterns: [] as RegExp[],
  /** Fail this exact command starting from its Nth invocation (1-based). */
  failFromCall: null as { cmd: string; fromCall: number } | null,
  launchctlListOutput: '',
  whoamiOutput: 'testuser\n',
  execCalls: [] as string[],
  execCallCounts: new Map<string, number>(),
}));
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string, _opts?: unknown) => {
    state.execCalls.push(cmd);
    const n = (state.execCallCounts.get(cmd) ?? 0) + 1;
    state.execCallCounts.set(cmd, n);
    if (state.failPatterns.some((p) => p.test(cmd))) {
      throw new Error(`mock execSync failure: ${cmd}`);
    }
    if (state.failFromCall && state.failFromCall.cmd === cmd && n >= state.failFromCall.fromCall) {
      throw new Error(`mock execSync failure (call #${n}): ${cmd}`);
    }
    if (cmd === 'launchctl list') return state.launchctlListOutput;
    if (cmd === 'whoami') return state.whoamiOutput;
    return '';
  }),
}));

const origCwd = process.cwd();
const origExit = process.exit;
let tmpDir: string;
let homeDir: string;

beforeEach(() => {
  // realpathSync: on macOS os.tmpdir() lives under a symlink (/var ->
  // /private/var), and process.cwd() inside the step returns the resolved
  // path. Resolving once here keeps every path built from `tmpDir` in this
  // test consistent with what service.ts computes internally (matters for
  // the install-slug hash baked into the plist label / systemd unit name).
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'service-test-')));
  homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'project'), { recursive: true });
  process.chdir(path.join(tmpDir, 'project'));
  fs.mkdirSync(path.join(tmpDir, 'project', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'project', 'bin', 'ncl'), '#!/bin/sh\necho ncl\n', { mode: 0o755 });

  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

  emitted.length = 0;
  state.failPatterns = [];
  state.failFromCall = null;
  state.launchctlListOutput = '';
  state.whoamiOutput = 'testuser\n';
  state.execCalls = [];
  state.execCallCounts = new Map();

  mockPlatform.commandExists.mockReset().mockReturnValue(false);
  mockPlatform.getPlatform.mockReset().mockReturnValue('macos');
  mockPlatform.getNodePath.mockReset().mockReturnValue('/usr/local/bin/node');
  mockPlatform.getServiceManager.mockReset().mockReturnValue('launchd');
  mockPlatform.hasSystemd.mockReset().mockReturnValue(false);
  mockPlatform.isRoot.mockReset().mockReturnValue(false);
  mockPlatform.isWSL.mockReset().mockReturnValue(false);

  mockPeerCleanup.cleanupUnhealthyPeers.mockReset().mockReturnValue({
    checked: [],
    unloaded: [],
    removed: [],
    failures: [],
  });
  mockUpgradeState.writeUpgradeState.mockReset().mockReturnValue({
    version: 'test-version',
    commit: 'abc',
    tree: 'def',
    updatedAt: 'now',
    via: 'setup',
  });

  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  process.chdir(origCwd);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

async function runService(): Promise<{ exits: number[] }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  const { run } = await import('./service.js');
  try {
    await run([]);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return { exits };
}

describe('service — build step', () => {
  it('fails with build_failed when `pnpm run build` fails, before anything else runs', async () => {
    state.failPatterns.push(/^pnpm run build$/);
    const { exits } = await runService();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ step: 'SETUP_SERVICE', STATUS: 'failed', ERROR: 'build_failed' });
    expect(mockUpgradeState.writeUpgradeState).not.toHaveBeenCalled();
  });
});

describe('service — unsupported platform', () => {
  it('fails with unsupported_platform', async () => {
    mockPlatform.getPlatform.mockReturnValue('unknown');
    const { exits } = await runService();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'unsupported_platform' });
  });
});

describe('service — peer-cleanup preflight logging', () => {
  it('logs (non-fatally) when peers were unloaded and removed', async () => {
    mockPeerCleanup.cleanupUnhealthyPeers.mockReturnValue({
      checked: [],
      unloaded: [{ label: 'com.nanoclaw-v2-dead', configPath: '/x', state: 'exited', runs: 99, unhealthy: true }],
      removed: [{ label: 'com.nanoclaw-v2-gone', configPath: '/y' }],
      failures: [],
    });
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });
});

describe('service — launchd (macOS)', () => {
  it('writes the plist, loads it, and reports success when the service shows up in `launchctl list`', async () => {
    const label = getLaunchdLabel(path.join(tmpDir, 'project'));
    state.launchctlListOutput = `0\t0\t${label}\n`;

    const { exits } = await runService();
    expect(exits).toEqual([]);

    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    expect(fs.existsSync(plistPath)).toBe(true);
    const plist = fs.readFileSync(plistPath, 'utf-8');
    expect(plist).toContain(`<string>${label}</string>`);
    expect(plist).toContain('/usr/local/bin/node');

    expect(state.execCalls.some((c) => c.startsWith('launchctl unload'))).toBe(true);
    expect(state.execCalls.some((c) => c.startsWith('launchctl load'))).toBe(true);
    expect(state.execCalls.some((c) => c.startsWith('launchctl kickstart'))).toBe(true);

    const status = emitted.at(-1)!;
    expect(status).toMatchObject({
      SERVICE_TYPE: 'launchd',
      SERVICE_LABEL: label,
      SERVICE_LOADED: true,
      STATUS: 'success',
    });

    // ncl symlink was installed alongside the service.
    const symlinkPath = path.join(homeDir, '.local', 'bin', 'ncl');
    expect(fs.lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
  });

  it('tolerates `launchctl unload` and `load` failures and still reports (load failure keeps SERVICE_LOADED false)', async () => {
    state.failPatterns.push(/^launchctl unload/, /^launchctl load/, /^launchctl kickstart/);
    state.launchctlListOutput = ''; // label absent -> not loaded
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE_LOADED: false, STATUS: 'success' });
  });

  it('reports SERVICE_LOADED false when `launchctl list` itself fails', async () => {
    state.failPatterns.push(/^launchctl list$/);
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE_LOADED: false });
  });
});

describe('service — ncl CLI symlink', () => {
  it('replaces an existing stale symlink', async () => {
    const targetDir = path.join(homeDir, '.local', 'bin');
    fs.mkdirSync(targetDir, { recursive: true });
    const staleTarget = path.join(tmpDir, 'nowhere', 'ncl');
    fs.symlinkSync(staleTarget, path.join(targetDir, 'ncl'));

    const { exits } = await runService();
    expect(exits).toEqual([]);
    const linkTarget = fs.readlinkSync(path.join(targetDir, 'ncl'));
    expect(linkTarget).toBe(path.join(tmpDir, 'project', 'bin', 'ncl'));
  });

  it('refuses to clobber a real (non-symlink) file at the target path', async () => {
    const targetDir = path.join(homeDir, '.local', 'bin');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'ncl'), 'not a symlink');

    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(fs.lstatSync(path.join(targetDir, 'ncl')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(targetDir, 'ncl'), 'utf-8')).toBe('not a symlink');
  });
});

describe('service — systemd (Linux, non-root)', () => {
  beforeEach(() => {
    mockPlatform.getPlatform.mockReturnValue('linux');
    mockPlatform.getServiceManager.mockReturnValue('systemd');
    mockPlatform.isRoot.mockReturnValue(false);
  });

  it('installs a user-level unit and reports success (docker group not stale)', async () => {
    const { exits } = await runService();
    expect(exits).toEqual([]);

    const unit = getSystemdUnit(path.join(tmpDir, 'project'));
    const unitPath = path.join(homeDir, '.config', 'systemd', 'user', `${unit}.service`);
    expect(fs.existsSync(unitPath)).toBe(true);
    const content = fs.readFileSync(unitPath, 'utf-8');
    expect(content).toContain('WantedBy=default.target');
    expect(content).toContain(`/usr/local/bin/node ${path.join(tmpDir, 'project')}/dist/index.js`);

    const status = emitted.at(-1)!;
    expect(status).toMatchObject({
      SERVICE_TYPE: 'systemd-user',
      SERVICE_UNIT: unit,
      SERVICE_LOADED: true,
      LINGER_ENABLED: true,
      STATUS: 'success',
    });
    expect(status.DOCKER_GROUP_STALE).toBeUndefined();
    expect(state.execCalls.some((c) => c === 'loginctl enable-linger')).toBe(true);
    expect(state.execCalls.some((c) => c.startsWith('pkill -f'))).toBe(true);
  });

  it('falls back to the nohup wrapper when the user systemd session is unavailable', async () => {
    state.failPatterns.push(/^systemctl --user daemon-reload$/);
    const { exits } = await runService();
    expect(exits).toEqual([]);
    const wrapperPath = path.join(tmpDir, 'project', 'start-nanoclaw.sh');
    expect(fs.existsSync(wrapperPath)).toBe(true);
    const wrapper = fs.readFileSync(wrapperPath, 'utf-8');
    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(emitted.at(-1)).toMatchObject({ SERVICE_TYPE: 'nohup', FALLBACK: 'wsl_no_systemd', STATUS: 'success' });
  });

  it('applies the setfacl workaround when the docker group is stale in the systemd session', async () => {
    // systemd-run docker probe fails, but plain `docker info` succeeds ->
    // stale-group detection fires.
    state.failPatterns.push(/^systemd-run --user --pipe --wait docker info$/);
    mockPlatform.commandExists.mockImplementation((name: string) => name === 'setfacl');
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(state.execCalls.some((c) => c === 'whoami')).toBe(true);
    expect(state.execCalls.some((c) => c.includes('setfacl -m u:testuser:rw'))).toBe(true);
    // The workaround succeeded -> dockerGroupStale flips back to false, so
    // the field is omitted from the status block.
    expect(emitted.at(-1)!.DOCKER_GROUP_STALE).toBeUndefined();
  });

  it('reports DOCKER_GROUP_STALE when setfacl itself fails', async () => {
    state.failPatterns.push(/^systemd-run --user --pipe --wait docker info$/, /^sudo setfacl/);
    mockPlatform.commandExists.mockImplementation((name: string) => name === 'setfacl');
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ DOCKER_GROUP_STALE: true });
  });

  it('warns but does not crash when setfacl is not installed and docker is genuinely broken', async () => {
    // Neither the systemd-session probe nor the plain docker probe succeeds
    // -> checkDockerGroupStale's own catch returns false (not a stale-group
    // situation, docker is just down) - so DOCKER_GROUP_STALE is absent.
    state.failPatterns.push(/docker info$/);
    mockPlatform.commandExists.mockReturnValue(false); // no setfacl
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)!.DOCKER_GROUP_STALE).toBeUndefined();
  });

  it('warns (and reports the stale flag) when the group is stale but setfacl is not installed at all', async () => {
    // systemd-run fails but plain `docker info` succeeds -> genuinely stale.
    state.failPatterns.push(/^systemd-run --user --pipe --wait docker info$/);
    mockPlatform.commandExists.mockReturnValue(false); // setfacl absent
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ DOCKER_GROUP_STALE: true });
    expect(state.execCalls.some((c) => c.startsWith('sudo setfacl'))).toBe(false);
  });

  it('logs (non-fatally) when the real daemon-reload call fails after the availability probe already succeeded', async () => {
    // Both calls share the exact command string 'systemctl --user
    // daemon-reload': the first (line ~293) probes user-session
    // availability, the second (line ~369) is the real reload. Failing only
    // from the 2nd invocation lets the probe pass (systemd path taken) while
    // still exercising the real reload's own catch/log.error branch.
    state.failFromCall = { cmd: 'systemctl --user daemon-reload', fromCall: 2 };
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE_TYPE: 'systemd-user' });
  });

  it('logs (non-fatally) when daemon-reload / enable / restart / is-active all fail', async () => {
    state.failPatterns.push(
      /^systemctl --user enable/,
      /^systemctl --user restart/,
      /^systemctl --user is-active/,
      /^loginctl enable-linger$/,
    );
    const { exits } = await runService();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE_LOADED: false });
  });
});

describe('service — systemd (Linux, root)', () => {
  it('installs a system-level unit at /etc/systemd/system without touching the real filesystem', async () => {
    mockPlatform.getPlatform.mockReturnValue('linux');
    mockPlatform.getServiceManager.mockReturnValue('systemd');
    mockPlatform.isRoot.mockReturnValue(true);

    const realWriteFileSync = fs.writeFileSync.bind(fs);
    const realMkdirSync = fs.mkdirSync.bind(fs);
    const etcWrites: Array<{ filePath: string; content: string }> = [];
    const etcMkdirs: string[] = [];
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      filePath: fs.PathOrFileDescriptor,
      content: unknown,
      opts?: unknown,
    ) => {
      if (typeof filePath === 'string' && filePath.startsWith('/etc/')) {
        etcWrites.push({ filePath, content: String(content) });
        return undefined as never;
      }
      return realWriteFileSync(filePath, content as never, opts as never);
    }) as typeof fs.writeFileSync);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((dirPath: fs.PathLike, opts?: unknown) => {
      if (typeof dirPath === 'string' && dirPath.startsWith('/etc/')) {
        etcMkdirs.push(dirPath);
        return undefined;
      }
      return realMkdirSync(dirPath, opts as never);
    }) as typeof fs.mkdirSync);

    const { exits } = await runService();
    expect(exits).toEqual([]);

    const unit = getSystemdUnit(path.join(tmpDir, 'project'));
    // The root branch assumes /etc/systemd/system already exists (it does on
    // any real systemd host) and never calls mkdirSync for it — only the
    // writeFileSync interception is exercised here.
    expect(etcMkdirs).toEqual([]);
    const write = etcWrites.find((w) => w.filePath === `/etc/systemd/system/${unit}.service`);
    expect(write).toBeDefined();
    expect(write!.content).toContain('WantedBy=multi-user.target');

    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ SERVICE_TYPE: 'systemd-system', SERVICE_LOADED: true, LINGER_ENABLED: false });
    // Root path never checks/enables lingering, and the systemctl calls have
    // no `--user` prefix.
    expect(state.execCalls.some((c) => c === 'loginctl enable-linger')).toBe(false);
    expect(state.execCalls.some((c) => c === 'systemctl daemon-reload')).toBe(true);
    expect(state.execCalls.some((c) => c.startsWith(`systemctl enable ${unit}`))).toBe(true);
  });
});

describe('service — nohup fallback (non-systemd Linux, e.g. WSL)', () => {
  it('writes the wrapper script directly (getServiceManager returns none)', async () => {
    mockPlatform.getPlatform.mockReturnValue('linux');
    mockPlatform.getServiceManager.mockReturnValue('none');
    const { exits } = await runService();
    expect(exits).toEqual([]);
    const wrapperPath = path.join(tmpDir, 'project', 'start-nanoclaw.sh');
    const wrapper = fs.readFileSync(wrapperPath, 'utf-8');
    expect(wrapper).toContain('start-nanoclaw.sh');
    expect((fs.statSync(wrapperPath).mode & 0o777).toString(8)).toBe('755');
    expect(emitted.at(-1)).toMatchObject({ SERVICE_TYPE: 'nohup', SERVICE_LOADED: false, STATUS: 'success' });
  });
});

/**
 * Coverage for setup/verify.ts — the `verify` step's `run()` end-to-end
 * health check (determineVerifyStatus, the pure decision function, is
 * already fully covered by the sibling setup/verify.test.ts and is not
 * re-tested here).
 *
 * `./platform.js` is mocked wholesale so the service-manager branch
 * (launchd/systemd/none), root/non-root, are directly selectable per test.
 * `child_process`'s execSync is mocked so no real launchctl/systemctl/ps/
 * docker command ever runs. `./central-db-inspection.js` and
 * `./lib/registry-state.js` are mocked — both are separate collaborators
 * with their own coverage elsewhere, not part of this file's surface. Real
 * fs + a temp directory (used as both `process.cwd()` and `os.homedir()`)
 * exercise the actual `.env` / mount-allowlist / WhatsApp-auth-dir reads.
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
  getPlatform: vi.fn(() => 'macos' as 'macos' | 'linux' | 'unknown'),
  getServiceManager: vi.fn(() => 'launchd' as 'launchd' | 'systemd' | 'none'),
  hasSystemd: vi.fn(() => false),
  isRoot: vi.fn(() => false),
}));
vi.mock('./platform.js', () => mockPlatform);

const mockCentralDb = vi.hoisted(() => ({
  inspectCentralDb: vi.fn(async () => ({ displayName: null, registeredGroups: 0, derivedGroups: 0 })),
}));
vi.mock('./central-db-inspection.js', () => mockCentralDb);

const mockRegistryState = vi.hoisted(() => ({
  readImageSource: vi.fn((): 'local' | 'hardened' => 'local'),
  inspectAgentImage: vi.fn(() => ({ ref: 'x:latest', labels: {}, source: 'missing' as const })),
}));
vi.mock('./lib/registry-state.js', () => mockRegistryState);

const execState = vi.hoisted(() => ({
  failPatterns: [] as RegExp[],
  responses: new Map<string, string>(),
}));
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string, _opts?: unknown) => {
    if (execState.failPatterns.some((p) => p.test(cmd))) {
      throw new Error(`mock execSync failure: ${cmd}`);
    }
    for (const [pattern, out] of execState.responses) {
      if (cmd.includes(pattern)) return out;
    }
    return '';
  }),
}));

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}
const origExit = process.exit;
const origCwd = process.cwd();
let tmpDir: string;
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-')));
  homeDir = path.join(tmpDir, 'home');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.chdir(projectDir);
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

  emitted.length = 0;
  execState.failPatterns = [];
  execState.responses = new Map();

  mockPlatform.getPlatform.mockReset().mockReturnValue('macos');
  mockPlatform.getServiceManager.mockReset().mockReturnValue('launchd');
  mockPlatform.hasSystemd.mockReset().mockReturnValue(false);
  mockPlatform.isRoot.mockReset().mockReturnValue(false);

  mockCentralDb.inspectCentralDb
    .mockReset()
    .mockResolvedValue({ displayName: null, registeredGroups: 0, derivedGroups: 0 });
  mockRegistryState.readImageSource.mockReset().mockReturnValue('local');
  mockRegistryState.inspectAgentImage.mockReset().mockReturnValue({ ref: 'x:latest', labels: {}, source: 'missing' });

  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  process.chdir(origCwd);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEnv(content: string): void {
  fs.writeFileSync(path.join(projectDir, '.env'), content);
}

async function runVerify(): Promise<{ exits: number[] }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  const { run } = await import('./verify.js');
  try {
    await run([]);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return { exits };
}

function baseHealthy(): void {
  writeEnv('ANTHROPIC_API_KEY=sk-ant-xxx\n');
  mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: 'Andy', registeredGroups: 1, derivedGroups: 0 });
  const label = getLaunchdLabel(projectDir);
  execState.responses.set('launchctl list', `1234\t0\t${label}\n5678\t0\tcom.other\n`);
  execState.responses.set('ps -p 1234', `node ${projectDir}/dist/index.js\n`);
}

describe('verify — launchd service detection', () => {
  it('reports running + success when the service is loaded with a real PID under this checkout', async () => {
    baseHealthy();
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ step: 'VERIFY', SERVICE: 'running', STATUS: 'success' });
  });

  it('reports stopped when the label is present but the PID column is "-"', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\n');
    const label = getLaunchdLabel(projectDir);
    execState.responses.set('launchctl list', `-\t0\t${label}\n`);
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'stopped', STATUS: 'failed' });
  });

  it('reports not_found when the label never appears in `launchctl list`', async () => {
    execState.responses.set('launchctl list', 'com.something.else\n');
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'not_found' });
  });

  it('tolerates `launchctl list` itself failing (launchctl not available)', async () => {
    execState.failPatterns.push(/^launchctl list$/);
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'not_found' });
  });

  it('flags running_other_checkout when the resolved script lives outside this project root', async () => {
    baseHealthy();
    execState.responses.set('ps -p 1234', 'node /somewhere/else/dist/index.js\n');
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running_other_checkout', STATUS: 'failed' });
  });

  it('leaves runningFromPath null (no mismatch check) when the PID cannot be resolved to a script', async () => {
    baseHealthy();
    execState.failPatterns.push(/^ps -p 1234/);
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running' });
  });

  it('leaves runningFromPath null when `ps` prints no recognizable script token', async () => {
    baseHealthy();
    execState.responses.set('ps -p 1234', 'launchd\n');
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running' });
  });

  it('skips the PID-resolve step entirely for a non-numeric/zero PID field', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\n');
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 1, derivedGroups: 0 });
    const label = getLaunchdLabel(projectDir);
    execState.responses.set('launchctl list', `0\t0\t${label}\n`);
    const { exits } = await runVerify();
    // pid=0 fails the `pid > 0` guard -> runningFromPath stays null -> no mismatch flag.
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running' });
  });
});

describe('verify — systemd service detection', () => {
  beforeEach(() => {
    mockPlatform.getServiceManager.mockReturnValue('systemd');
  });

  it('reports running (user session) with the resolved PID script under this checkout', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\n');
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 1, derivedGroups: 0 });
    const unit = getSystemdUnit(projectDir);
    execState.responses.set(`is-active ${unit}`, '');
    execState.responses.set(`show ${unit} -p MainPID`, '4321\n');
    execState.responses.set('ps -p 4321', `node ${projectDir}/dist/index.js\n`);
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running', STATUS: 'success' });
    expect(execState.failPatterns).toEqual([]); // sanity: this test uses only responses
  });

  it('uses the unprefixed systemctl (no --user) when running as root', async () => {
    mockPlatform.isRoot.mockReturnValue(true);
    writeEnv('ANTHROPIC_API_KEY=x\n');
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 1, derivedGroups: 0 });
    const unit = getSystemdUnit(projectDir);
    execState.responses.set(`is-active ${unit}`, '');
    execState.failPatterns.push(new RegExp(`^systemctl show ${unit}`));
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running' });
  });

  it('falls back to stopped when is-active fails but the unit is listed', async () => {
    const unit = getSystemdUnit(projectDir);
    execState.failPatterns.push(new RegExp(`^systemctl --user is-active ${unit}`));
    execState.responses.set('list-unit-files', `${unit}.service enabled\n`);
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'stopped' });
  });

  it('reports not_found when is-active fails and the unit is not listed either', async () => {
    execState.failPatterns.push(/^systemctl --user is-active/);
    execState.responses.set('list-unit-files', 'some-other.service\n');
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'not_found' });
  });

  it('reports not_found when list-unit-files itself fails too', async () => {
    execState.failPatterns.push(/^systemctl --user is-active/, /^systemctl --user list-unit-files/);
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'not_found' });
  });

  it('running but MainPID unreadable: leaves runningFromPath null without failing', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\n');
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 1, derivedGroups: 0 });
    const unit = getSystemdUnit(projectDir);
    execState.responses.set(`is-active ${unit}`, '');
    execState.failPatterns.push(new RegExp(`^systemctl --user show ${unit}`));
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running' });
  });
});

describe('verify — nohup fallback detection (no service manager)', () => {
  beforeEach(() => {
    mockPlatform.getServiceManager.mockReturnValue('none');
  });

  it('reports not_found when there is no pid file at all', async () => {
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'not_found' });
  });

  it('reports running when the pid file names a live process', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\n');
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 1, derivedGroups: 0 });
    fs.writeFileSync(path.join(projectDir, 'nanoclaw.pid'), String(process.pid));
    execState.responses.set(`ps -p ${process.pid}`, `node ${projectDir}/dist/index.js\n`);
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'running' });
  });

  it('reports stopped when the pid file names a dead/nonexistent process', async () => {
    // A PID essentially guaranteed not to exist.
    fs.writeFileSync(path.join(projectDir, 'nanoclaw.pid'), '999999');
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'stopped' });
  });

  it('reports not_found (not stopped — the guard condition simply fails, no exception) for an invalid PID file', async () => {
    // Number('not-a-pid') is NaN, so `raw && Number.isInteger(pid) && pid > 0`
    // is false and the if-block is skipped entirely; `service` is left at its
    // initial 'not_found' rather than being set to 'stopped' by the catch
    // (which never fires — nothing threw).
    fs.writeFileSync(path.join(projectDir, 'nanoclaw.pid'), 'not-a-pid');
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ SERVICE: 'not_found' });
  });
});

describe('verify — container runtime / credentials / channel auth', () => {
  it('reports docker as the runtime when `docker info` succeeds', async () => {
    baseHealthy();
    execState.responses.set('docker info', '');
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONTAINER_RUNTIME: 'docker' });
  });

  it('reports "none" as the runtime when docker is unreachable', async () => {
    baseHealthy();
    execState.failPatterns.push(/^docker info$/);
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONTAINER_RUNTIME: 'none' });
  });

  it('reports credentials missing with no .env at all', async () => {
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ CREDENTIALS: 'missing' });
  });

  it('recognizes ONECLI_URL as a valid credential', async () => {
    writeEnv('ONECLI_URL=http://127.0.0.1:10254\n');
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 1, derivedGroups: 0 });
    const label = getLaunchdLabel(projectDir);
    execState.responses.set('launchctl list', `1\t0\t${label}\n`);
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CREDENTIALS: 'configured' });
  });

  it('detects a configured channel from process.env directly (not just .env)', async () => {
    vi.stubEnv('DISCORD_BOT_TOKEN', 'tok');
    baseHealthy();
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONFIGURED_CHANNELS: 'discord' });
    vi.unstubAllEnvs();
  });

  it('requires BOTH slack tokens before counting slack as configured', async () => {
    baseHealthy();
    writeEnv('ANTHROPIC_API_KEY=x\nSLACK_BOT_TOKEN=x\n'); // app token missing
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONFIGURED_CHANNELS: '' });
  });

  it('counts slack configured once both tokens are present', async () => {
    baseHealthy();
    writeEnv('ANTHROPIC_API_KEY=x\nSLACK_BOT_TOKEN=x\nSLACK_APP_TOKEN=y\n');
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONFIGURED_CHANNELS: 'slack' });
  });

  it('counts imessage configured via IMESSAGE_ENABLED alone', async () => {
    baseHealthy();
    writeEnv('ANTHROPIC_API_KEY=x\nIMESSAGE_ENABLED=true\n');
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONFIGURED_CHANNELS: 'imessage' });
  });

  it('counts imessage configured via the Photon project id+secret pair (not just one)', async () => {
    baseHealthy();
    writeEnv('ANTHROPIC_API_KEY=x\nPHOTON_PROJECT_ID=p\n'); // secret missing
    let r = await runVerify();
    expect(r.exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONFIGURED_CHANNELS: '' });

    writeEnv('ANTHROPIC_API_KEY=x\nPHOTON_PROJECT_ID=p\nPHOTON_PROJECT_SECRET=s\n');
    vi.resetModules();
    r = await runVerify();
    expect(r.exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ CONFIGURED_CHANNELS: 'imessage' });
  });

  it('detects whatsapp (Baileys) auth from a non-empty store/auth directory', async () => {
    baseHealthy();
    const authDir = path.join(projectDir, 'store', 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    const channelAuth = JSON.parse(String(emitted.at(-1)!.CHANNEL_AUTH));
    expect(channelAuth.whatsapp).toBe('authenticated');
  });

  it('does not count an empty store/auth directory as whatsapp-authenticated', async () => {
    baseHealthy();
    fs.mkdirSync(path.join(projectDir, 'store', 'auth'), { recursive: true });
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    const channelAuth = JSON.parse(String(emitted.at(-1)!.CHANNEL_AUTH));
    expect(channelAuth.whatsapp).toBeUndefined();
  });
});

describe('verify — mount allowlist / registered groups / wiring-pending / image source', () => {
  it('reports mount allowlist configured when the file exists', async () => {
    baseHealthy();
    const dir = path.join(homeDir, '.config', 'nanoclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mount-allowlist.json'), '[]');
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ MOUNT_ALLOWLIST: 'configured' });
  });

  it('reports mount allowlist missing otherwise', async () => {
    baseHealthy();
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ MOUNT_ALLOWLIST: 'missing' });
  });

  it('passes through registered/derived group counts from inspectCentralDb', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\n');
    const label = getLaunchdLabel(projectDir);
    execState.responses.set('launchctl list', `1\t0\t${label}\n`);
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: 'Andy', registeredGroups: 3, derivedGroups: 2 });
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ REGISTERED_GROUPS: 3, DERIVED_GROUPS: 2 });
  });

  it('treats zero groups as success (WIRING pending) when every configured channel defers wiring', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\nTEAMS_APP_ID=a\nTEAMS_APP_PASSWORD=b\n');
    const label = getLaunchdLabel(projectDir);
    execState.responses.set('launchctl list', `1\t0\t${label}\n`);
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 0, derivedGroups: 0 });
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success', WIRING: 'pending_first_dm', REGISTERED_GROUPS: 0 });
  });

  it('does not treat zero groups as pending when a wire-during-setup channel is also configured', async () => {
    writeEnv('ANTHROPIC_API_KEY=x\nTEAMS_APP_ID=a\nTEAMS_APP_PASSWORD=b\nDISCORD_BOT_TOKEN=d\n');
    const label = getLaunchdLabel(projectDir);
    execState.responses.set('launchctl list', `1\t0\t${label}\n`);
    mockCentralDb.inspectCentralDb.mockResolvedValue({ displayName: null, registeredGroups: 0, derivedGroups: 0 });
    const { exits } = await runVerify();
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed' });
    expect(emitted.at(-1)!.WIRING).toBeUndefined();
  });

  it('reports IMAGE_SOURCE / IMAGE_SOURCE_ACTUAL / IMAGE_DIGEST from registry-state when docker is up', async () => {
    baseHealthy();
    execState.responses.set('docker info', '');
    mockRegistryState.readImageSource.mockReturnValue('hardened');
    mockRegistryState.inspectAgentImage.mockReturnValue({
      ref: 'x:latest',
      labels: {},
      source: 'hardened',
      registryDigest: 'sha256:abc',
    });
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({
      IMAGE_SOURCE: 'hardened',
      IMAGE_SOURCE_ACTUAL: 'hardened',
      IMAGE_DIGEST: 'sha256:abc',
    });
  });

  it('reports IMAGE_SOURCE_ACTUAL "unknown" (and empty digest) without inspecting docker when it is unreachable', async () => {
    baseHealthy();
    execState.failPatterns.push(/^docker info$/);
    const { exits } = await runVerify();
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ IMAGE_SOURCE_ACTUAL: 'unknown', IMAGE_DIGEST: '' });
    expect(mockRegistryState.inspectAgentImage).not.toHaveBeenCalled();
  });
});

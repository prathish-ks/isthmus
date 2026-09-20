/**
 * Coverage for setup/container.ts — the `container` step that builds (or
 * pulls) the agent Docker image and smoke-tests it.
 *
 * `child_process` (execSync/spawnSync) and `timers/promises` (the 2s poll
 * delay in tryStartDocker) are mocked at the module boundary so no real
 * Docker, sudo, or 60-second wait ever runs. `./registry-reconcile.js` is
 * mocked too, since it is dynamically imported only on the pull-success
 * path and would otherwise touch the central DB. `process.exit` is trapped
 * as a thrown sentinel, matching the convention used elsewhere in this
 * bundle (see setup/register.coverage.test.ts / src/cli/client.coverage.test.ts).
 * Real fs + a temp directory as `process.cwd()` are used for the small
 * amount of real file I/O the step does (.env, versions.json, the smoke
 * workspace under data/).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown> & { step: string }>);
vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    emitted.push({ step, ...fields });
  }),
}));

type SpawnResult = { status: number | null; stdout?: string; stderr?: string };

const state = vi.hoisted(() => ({
  /** name -> present as a real command, checked by `command -v <name>` */
  presentCommands: new Set<string>(['docker']),
  execSyncShouldThrow: new Set<string>(), // exact command strings that should throw
  dockerInfo: (): SpawnResult => ({ status: 0, stdout: '', stderr: '' }),
  idGroups: (): SpawnResult => ({ status: 0, stdout: 'wheel staff docker\n', stderr: '' }),
  sgResult: (): SpawnResult => ({ status: 0, stdout: '', stderr: '' }),
  buildResult: (): SpawnResult => ({ status: 0, stdout: '', stderr: '' }),
  pullResult: (): SpawnResult => ({ status: 0, stdout: '', stderr: '' }),
  testResult: (): SpawnResult => ({ status: 0, stdout: 'Container OK\n', stderr: '' }),
  imageInspectResult: (): SpawnResult => ({ status: 0, stdout: '', stderr: '' }),
  execSyncCalls: [] as string[],
  spawnSyncCalls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string, _opts?: unknown) => {
    state.execSyncCalls.push(cmd);
    if (state.execSyncShouldThrow.has(cmd)) {
      throw new Error(`mock execSync failure: ${cmd}`);
    }
    const covMatch = cmd.match(/^command -v (\S+)/);
    if (covMatch) {
      if (state.presentCommands.has(covMatch[1])) return '';
      throw new Error(`command not found: ${covMatch[1]}`);
    }
    return '';
  }),
  spawnSync: vi.fn((cmd: string, args: string[] = [], _opts?: unknown) => {
    state.spawnSyncCalls.push({ cmd, args });
    if (cmd === 'docker' && args[0] === 'info') return state.dockerInfo();
    if (cmd === 'id' && args[0] === '-nG') return state.idGroups();
    if (cmd === 'sudo') return { status: 0, stdout: '', stderr: '' };
    if (cmd === 'sg') return state.sgResult();
    if (cmd === 'docker' && args[0] === 'build') return state.buildResult();
    if (cmd === 'bash' && String(args[0] ?? '').includes('pull.sh')) return state.pullResult();
    if (cmd === 'docker' && args[0] === 'run') return state.testResult();
    if (cmd === 'docker' && args[0] === 'image') return state.imageInspectResult();
    return { status: 1, stdout: '', stderr: '' };
  }),
}));

vi.mock('timers/promises', () => ({
  setTimeout: vi.fn(() => Promise.resolve()),
}));

vi.mock('./registry-reconcile.js', () => ({
  reconcileDerivedImages: vi.fn(async () => ({ cleared: [], removed: [], foreign: [] })),
}));

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

const origCwd = process.cwd();
const origExit = process.exit;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'container-test-'));
  process.chdir(tmpDir);
  fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
  emitted.length = 0;
  state.presentCommands = new Set(['docker']);
  state.execSyncShouldThrow = new Set();
  state.dockerInfo = () => ({ status: 0, stdout: '', stderr: '' });
  state.idGroups = () => ({ status: 0, stdout: 'wheel staff docker\n', stderr: '' });
  state.sgResult = () => ({ status: 0, stdout: '', stderr: '' });
  state.buildResult = () => ({ status: 0, stdout: '', stderr: '' });
  state.pullResult = () => ({ status: 0, stdout: '', stderr: '' });
  state.testResult = () => ({ status: 0, stdout: 'Container OK\n', stderr: '' });
  state.imageInspectResult = () => ({ status: 0, stdout: '', stderr: '' });
  state.execSyncCalls = [];
  state.spawnSyncCalls = [];
  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function runContainer(args: string[] = []): Promise<{ exits: number[] }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  const { run } = await import('./container.js');
  try {
    await run(args);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return { exits };
}

describe('container — argument / preflight validation', () => {
  it('fails with unknown_runtime for a non-docker --runtime', async () => {
    const { exits } = await runContainer(['--runtime', 'podman']);
    expect(exits).toEqual([4]);
    expect(emitted.at(-1)).toMatchObject({
      step: 'SETUP_CONTAINER',
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      RUNTIME: 'podman',
    });
  });

  it('runs install-docker.sh when docker is missing, then fails runtime_not_available if still missing', async () => {
    state.presentCommands = new Set(); // docker never becomes available
    const { exits } = await runContainer([]);
    expect(exits).toEqual([2]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'runtime_not_available' });
    expect(state.execSyncCalls.some((c) => c.includes('install-docker.sh'))).toBe(true);
  });

  it('swallows an install-docker.sh failure and still reports runtime_not_available', async () => {
    state.presentCommands = new Set();
    state.execSyncShouldThrow.add('bash setup/install-docker.sh');
    const { exits } = await runContainer([]);
    expect(exits).toEqual([2]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'runtime_not_available' });
  });
});

describe('container — docker daemon not running', () => {
  it('tries to start docker (macOS) and proceeds once it comes up', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    let calls = 0;
    state.dockerInfo = () => {
      calls++;
      return calls === 1 ? { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } : { status: 0 };
    };
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    expect(state.execSyncCalls).toContain('open -a Docker');
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });

  it('reports docker_group_not_active when the daemon never comes up and status is no-permission', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin'); // non-linux -> no sg re-exec branch
    state.dockerInfo = () => ({ status: 1, stdout: '', stderr: 'permission denied while trying to connect' });
    // 'open -a Docker' throws so tryStartDocker returns 'other' immediately,
    // which still surfaces as docker_group_not_active-or-runtime_not_available
    // depending on the *original* dockerStatus() call before tryStartDocker.
    const { exits } = await runContainer([]);
    expect(exits).toEqual([2]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed' });
    expect(['docker_group_not_active', 'runtime_not_available']).toContain(emitted.at(-1)!.ERROR);
  });

  it('gives up after the daemon never comes up (no-daemon) and reports runtime_not_available', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    state.dockerInfo = () => ({ status: 1, stdout: '', stderr: 'is the docker daemon running?' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([2]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'runtime_not_available' });
  });

  it('returns "other" on an unknown platform without attempting to start anything', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('sunos' as NodeJS.Platform);
    state.dockerInfo = () => ({ status: 1, stdout: '', stderr: 'boom' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([2]);
    // No attempt to `open` or `systemctl start docker` was made.
    expect(state.execSyncCalls.some((c) => c.includes('open -a Docker'))).toBe(false);
    expect(state.execSyncCalls.some((c) => c.includes('systemctl start docker'))).toBe(false);
  });

  it('swallows a failed start command (execSync throws) and reports failure', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    state.dockerInfo = () => ({ status: 1, stdout: '', stderr: 'boom' });
    state.execSyncShouldThrow.add('open -a Docker');
    const { exits } = await runContainer([]);
    expect(exits).toEqual([2]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed' });
  });

  it('re-execs under `sg docker` on linux when the socket is permission-denied', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    state.presentCommands = new Set(['docker', 'sg']);
    state.dockerInfo = () => ({ status: 1, stdout: '', stderr: 'permission denied' });
    state.idGroups = () => ({ status: 0, stdout: 'wheel staff\n', stderr: '' }); // NOT already in docker group
    state.sgResult = () => ({ status: 3, stdout: '', stderr: '' });
    const { exits } = await runContainer([]);
    // Re-exec propagates the child's exit code verbatim.
    expect(exits).toEqual([3]);
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'sudo')).toBe(true); // usermod attempted
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'sg')).toBe(true);
  });

  it('re-execs under `sg docker` without the usermod step when already in the group', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    state.presentCommands = new Set(['docker', 'sg']);
    state.dockerInfo = () => ({ status: 1, stdout: '', stderr: 'permission denied' });
    state.idGroups = () => ({ status: 0, stdout: 'wheel staff docker\n', stderr: '' }); // already in group
    state.sgResult = () => ({ status: 0, stdout: '', stderr: '' });
    state.buildResult = () => ({ status: 0 });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([0]);
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'sudo')).toBe(false);
  });
});

describe('container — build (local) path', () => {
  it('builds locally, smoke-tests, and reports success', async () => {
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ STATUS: 'success', SOURCE: 'build', BUILD_OK: true, TEST_OK: true });
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'build')).toBe(true);
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'run')).toBe(true);
  });

  it('reports failed with no TEST_OK when the build itself fails (and never runs the smoke test)', async () => {
    state.buildResult = () => ({ status: 1, stdout: '', stderr: 'build broke' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', BUILD_OK: false, TEST_OK: false });
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'run')).toBe(false);
  });

  it('reports failed when the build succeeds but the smoke test fails', async () => {
    state.testResult = () => ({ status: 1, stdout: '', stderr: 'not ok' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', BUILD_OK: true, TEST_OK: false });
  });

  it('reports failed when the smoke test exits 0 but never prints "Container OK"', async () => {
    state.testResult = () => ({ status: 0, stdout: 'something else\n', stderr: '' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ TEST_OK: false });
  });

  it('passes --build-arg INSTALL_CJK_FONTS=true when .env sets it', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'INSTALL_CJK_FONTS=true\n');
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    const buildCall = state.spawnSyncCalls.find((c) => c.cmd === 'docker' && c.args[0] === 'build')!;
    expect(buildCall.args.join(' ')).toContain('--build-arg INSTALL_CJK_FONTS=true');
  });

  it('does not pass the CJK build-arg when .env is absent or the flag is not "true"', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'INSTALL_CJK_FONTS=false\n');
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    const buildCall = state.spawnSyncCalls.find((c) => c.cmd === 'docker' && c.args[0] === 'build')!;
    expect(buildCall.args.join(' ')).not.toContain('INSTALL_CJK_FONTS');
  });
});

describe('container — pull (hardened image) path', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'NANOCLAW_HARDENED_IMAGE=true\n');
  });

  it('pulls, reconciles derived images, and reports success with a digest', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'versions.json'),
      JSON.stringify({ 'agent-image': 'registry.example/nanoclaw-agent@sha256:deadbeef' }),
    );
    state.imageInspectResult = () => ({
      status: 0,
      stdout: 'registry.example/nanoclaw-agent@sha256:deadbeef\n',
      stderr: '',
    });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ STATUS: 'success', SOURCE: 'pull', BUILD_OK: true, TEST_OK: true });
    expect(status.DIGEST).toContain('sha256:deadbeef');
    expect(state.spawnSyncCalls.some((c) => c.cmd === 'bash' && c.args[0]?.includes('pull.sh'))).toBe(true);
  });

  it('resolves a platform-keyed versions.json pin and reports image_ref_not_configured on pull exit 2', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'versions.json'),
      JSON.stringify({ 'agent-image': { 'linux/amd64': 'registry.example/nanoclaw-agent@sha256:aaaa' } }),
    );
    state.pullResult = () => ({ status: 2, stdout: '', stderr: '' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({
      STATUS: 'failed',
      SOURCE: 'pull',
      BUILD_OK: false,
      ERROR: 'image_ref_not_configured',
    });
  });

  it('reports image_pull_failed on any other non-zero pull exit code', async () => {
    state.pullResult = () => ({ status: 1, stdout: '', stderr: '' });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'image_pull_failed' });
  });

  it('resolves the repo from a platform-keyed versions.json pin object (no NANOCLAW_AGENT_IMAGE_REF override)', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'versions.json'),
      JSON.stringify({ 'agent-image': { 'linux/amd64': 'registry.example/nanoclaw-agent@sha256:bbbb' } }),
    );
    state.imageInspectResult = () => ({
      status: 0,
      stdout: 'registry.example/nanoclaw-agent@sha256:bbbb\n',
      stderr: '',
    });
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success', SOURCE: 'pull' });
    expect(emitted.at(-1)!.DIGEST).toContain('sha256:bbbb');
  });

  it('tolerates a missing/invalid versions.json (pinnedRepo -> undefined) and still succeeds', async () => {
    // No versions.json written at all.
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success', SOURCE: 'pull' });
  });

  it('continues (non-fatally) when reconcileDerivedImages rejects', async () => {
    const mod = await import('./registry-reconcile.js');
    vi.mocked(mod.reconcileDerivedImages).mockRejectedValueOnce(new Error('db exploded'));
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success' });
  });

  it('honors NANOCLAW_HARDENED_IMAGE from process.env over .env', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), 'NANOCLAW_HARDENED_IMAGE=false\n');
    vi.stubEnv('NANOCLAW_HARDENED_IMAGE', 'true');
    const { exits } = await runContainer([]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ SOURCE: 'pull' });
    vi.unstubAllEnvs();
  });
});

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getInstallSlug, getRuntimeSocketDir } from '../../src/install-slug.js';

export interface CommandRunner {
  run(command: string, args: string[], cwd?: string): string;
  tryRun(command: string, args: string[], cwd?: string): { ok: boolean; stdout: string; status: number | null };
}

export function createCommandRunner(): CommandRunner {
  const run = (command: string, args: string[], cwd?: string): string =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Node's default maxBuffer is 1 MiB; a full vitest run on a large repo
      // exceeds it and the whole validate step dies as `spawnSync pnpm
      // ENOBUFS` with the tests never judged. 64 MiB is far above any real
      // build/test output while still bounding a runaway.
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  return {
    run,
    tryRun(command, args, cwd) {
      try {
        return { ok: true, stdout: run(command, args, cwd), status: 0 };
      } catch (err) {
        const failed = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
        return {
          ok: false,
          stdout: [failed.stdout, failed.stderr]
            .map((part) => part?.toString().trim())
            .filter(Boolean)
            .join('\n'),
          status: failed.status ?? null,
        };
      }
    },
  };
}

export type ServiceMode = 'launchd' | 'systemd-user' | 'systemd-system' | 'nohup' | 'unmanaged' | 'none';

export interface ServiceHandle {
  mode: ServiceMode;
  active: boolean;
  /** Unit still starting or stopping: must be stopped like a running one, never counts as healthy. */
  transitional?: boolean;
  name?: string;
  definition?: string;
  pid?: number;
}

export interface ServiceEnvironment {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  runner: CommandRunner;
  sleep(ms: number): Promise<void>;
  /** Progress line for a wait the operator would otherwise read as a hang. */
  log?(message: string): void;
  /** procfs mount for nohup host identity checks; tests point it at a fixture. */
  procRoot?: string;
}

export function defaultServiceEnvironment(runner = createCommandRunner()): ServiceEnvironment {
  return {
    platform: process.platform,
    home: os.homedir(),
    uid: process.getuid?.() ?? 0,
    runner,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nohupPidFile(projectRoot: string): string {
  return path.join(projectRoot, 'nanoclaw.pid');
}

function readNohupPid(projectRoot: string): number | undefined {
  try {
    const text = fs.readFileSync(nohupPidFile(projectRoot), 'utf8').trim();
    // Positive only: `kill` with 0 or a negative pid signals a process group.
    return /^[1-9][0-9]*$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

function realpathOr(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

// start-nanoclaw.sh's launched entrypoint (argv[1] is this checkout's dist/index.js),
// by realpath so a symlinked checkout matches. A recorded pid may be reused.
function isNohupHost(pid: number, projectRoot: string, env: ServiceEnvironment): boolean {
  try {
    const script = fs.readFileSync(path.join(env.procRoot ?? '/proc', String(pid), 'cmdline'), 'utf8').split('\0')[1];
    const entrypoint = realpathOr(path.join(projectRoot, 'dist', 'index.js'));
    return !!script && path.isAbsolute(script) && realpathOr(script) === entrypoint;
  } catch {
    return false;
  }
}

/**
 * The launcher records every start in nanoclaw.pid, so a handle captured
 * before a later start (e.g. finishUpdate's own restart) must be re-pointed
 * at whichever host is recorded now, not the pid captured at cutover time —
 * which may be stale or, worse, reused by an unrelated process since.
 */
export function withRecordedNohupHost(
  handle: ServiceHandle,
  projectRoot: string,
  env: ServiceEnvironment,
): ServiceHandle {
  if (handle.mode !== 'nohup') return handle;
  const pid = readNohupPid(projectRoot);
  if (pid !== undefined && isNohupHost(pid, projectRoot, env)) {
    env.log?.(`Found running NanoClaw host (PID ${pid}); stopping it`);
    return { ...handle, pid, active: true };
  }
  env.log?.('No running NanoClaw host found for this checkout; nothing to stop');
  return { ...handle, pid: undefined, active: false };
}

/**
 * `systemctl --user` needs XDG_RUNTIME_DIR; `su -`, cron and non-interactive
 * SSH leave it unset while the user manager still runs (linger or another
 * session). Adopt /run/user/<uid> process-wide: stop and start need it too.
 */
export function adoptUserRuntimeDir(uid: number, runRoot = '/run/user'): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const runtimeDir = path.join(runRoot, String(uid));
  if (fs.existsSync(runtimeDir)) process.env.XDG_RUNTIME_DIR = runtimeDir;
}

/**
 * Liveness by exit code: 0 = running (stdout), `stoppedExit` = stopped
 * (undefined), anything else = the probe itself failed, so throw. Reading
 * every failure as "stopped" (the old `tryRun(...).ok` check) let a run
 * without the user bus skip stop and restart, pass health against the stale
 * host, and report complete.
 */
export function probe(
  env: ServiceEnvironment,
  command: string,
  args: string[],
  stoppedExit: number[],
  hint: string,
): { stdout: string; transitional: boolean } | undefined {
  try {
    return { stdout: env.runner.run(command, args), transitional: false };
  } catch (err) {
    const failed = err as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
    if (typeof failed.status === 'number' && stoppedExit.includes(failed.status)) {
      // systemctl is-active exits 3 for activating/deactivating too (a unit
      // mid auto-restart still holds the service): only its terminal states
      // are stopped. Other tools print nothing on their stopped exit.
      const state = failed.stdout?.toString().trim() ?? '';
      return /^(activating|deactivating)$/.test(state) ? { stdout: state, transitional: true } : undefined;
    }
    const detail = failed.stderr?.toString().trim() || (err instanceof Error ? err.message : String(err));
    throw new Error(
      `Cannot tell whether NanoClaw is running: \`${command} ${args.join(' ')}\` failed (${detail}). ${hint}`,
    );
  }
}

function flag(unit: { transitional: boolean } | undefined): { transitional?: true } {
  return unit?.transitional ? { transitional: true } : {};
}

function userBusHint(uid: number): string {
  return `Run the update from a login session of this user, or with XDG_RUNTIME_DIR=/run/user/${uid} while the user manager runs (loginctl enable-linger).`;
}

export function detectService(projectRoot: string, env: ServiceEnvironment): ServiceHandle {
  const slug = getInstallSlug(projectRoot);
  if (env.platform === 'darwin') {
    const name = `com.nanoclaw-v2-${slug}`;
    const definition = path.join(env.home, 'Library', 'LaunchAgents', `${name}.plist`);
    if (fs.existsSync(definition)) {
      // 113: not loaded in this domain; 112 (no such domain) and the rest are probe failures.
      const unit = probe(
        env,
        'launchctl',
        ['print', `gui/${env.uid}/${name}`],
        [113],
        'Run the update from a login session of this user.',
      );
      return { mode: 'launchd', name, definition, active: unit !== undefined, ...flag(unit) };
    }
  }

  if (env.platform === 'linux') {
    const name = `nanoclaw-v2-${slug}`;
    const userDefinition = path.join(env.home, '.config', 'systemd', 'user', `${name}.service`);
    const systemDefinition = `/etc/systemd/system/${name}.service`;
    if (fs.existsSync(userDefinition)) {
      adoptUserRuntimeDir(env.uid);
      // 3: not active; a bus error exits 1 and is not "stopped".
      const unit = probe(env, 'systemctl', ['--user', 'is-active', name], [3], userBusHint(env.uid));
      return { mode: 'systemd-user', name, definition: userDefinition, active: unit !== undefined, ...flag(unit) };
    }
    if (fs.existsSync(systemDefinition)) {
      const unit = probe(
        env,
        'systemctl',
        ['is-active', name],
        [3],
        'Run the update where systemctl can reach the system manager.',
      );
      return { mode: 'systemd-system', name, definition: systemDefinition, active: unit !== undefined, ...flag(unit) };
    }

    const definition = path.join(projectRoot, 'start-nanoclaw.sh');
    if (fs.existsSync(definition) && fs.existsSync(nohupPidFile(projectRoot))) {
      const pid = readNohupPid(projectRoot);
      return { mode: 'nohup', definition, pid, active: pid !== undefined && isNohupHost(pid, projectRoot, env) };
    }
  }

  // pgrep exits 1 for no match; a missing or broken pgrep must not read as "nothing running".
  const unmanaged = probe(
    env,
    'pgrep',
    ['-f', `${escapeRegex(projectRoot)}/(dist/index\\.js|src/index\\.ts)`],
    [1],
    'Install procps (pgrep) and retry.',
  );
  if (unmanaged?.stdout) {
    return { mode: 'unmanaged', active: true, name: unmanaged.stdout.split('\n').join(',') };
  }
  return { mode: 'none', active: false };
}

/**
 * Idempotent per mode: stopping an already-stopped service is success, in the
 * service manager's own vocabulary — `launchctl bootout` fails a not-loaded
 * job with "No such process", `process.kill` raises ESRCH, and `systemctl
 * stop` of a stopped-but-loaded unit already exits 0. The rollback path stops
 * a handle captured before cutover (which stopped the service itself), so
 * without this the restore died on its own stop and left the live checkout on
 * the target commit with the service down. Any OTHER stop failure still
 * throws: a service that is genuinely still running must abort the caller
 * before anything is destroyed.
 */
export async function stopService(handle: ServiceHandle, env: ServiceEnvironment): Promise<void> {
  if (!handle.active) return;
  if (handle.mode === 'launchd') {
    const target = `gui/${env.uid}/${handle.name}`;
    // Every PID the job ever reports while we poll — KeepAlive can respawn
    // the host under a new PID between checks, so track all of them, not
    // just the first.
    const pids = new Set<number>();
    const stillLoaded = (): boolean => {
      const probe = env.runner.tryRun('launchctl', ['print', target]);
      const pid = Number(/^\s*pid = (\d+)/m.exec(probe.stdout)?.[1]);
      if (pid) pids.add(pid);
      return probe.ok;
    };
    stillLoaded();
    try {
      env.runner.run('launchctl', ['bootout', target]);
    } catch (err) {
      if (!/No such process/i.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    // bootout returns while the host is still running its own shutdown
    // handlers — without waiting here, the next snapshot/bootstrap can race
    // that shutdown and fail with "5: Input/output error", rolling the
    // whole update back. Poll the same way the nohup branch below already
    // does (60 x 500ms).
    const stillStopping = () => stillLoaded() || [...pids].some(processExists);
    for (let i = 0; i < 60 && stillStopping(); i += 1) await env.sleep(500);
    if (stillStopping()) {
      throw new Error(
        `NanoClaw service ${handle.name} did not stop (PID ${[...pids].join(', ') || 'unknown'}). ` +
          `Once it has exited, start it again with: launchctl bootstrap gui/${env.uid} ${handle.definition}`,
      );
    }
  } else if (handle.mode === 'systemd-user') {
    adoptUserRuntimeDir(env.uid);
    env.runner.run('systemctl', ['--user', 'stop', handle.name!]);
  } else if (handle.mode === 'systemd-system') {
    env.runner.run('systemctl', ['stop', handle.name!]);
  } else if (handle.mode === 'nohup' && handle.pid) {
    try {
      process.kill(handle.pid, 'SIGTERM');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      return;
    }
    for (let i = 0; i < 60 && processExists(handle.pid); i += 1) await env.sleep(500);
    if (processExists(handle.pid)) throw new Error(`NanoClaw process ${handle.pid} did not stop`);
  } else if (handle.mode === 'unmanaged') {
    throw new Error(
      `NanoClaw is running outside a supported service wrapper (PID ${handle.name}). Stop it, then retry cutover`,
    );
  }
}

export function startService(handle: ServiceHandle, projectRoot: string, env: ServiceEnvironment): void {
  if (!handle.active) return;
  if (handle.mode === 'launchd') {
    env.runner.run('launchctl', ['bootstrap', `gui/${env.uid}`, handle.definition!]);
    env.runner.run('launchctl', ['kickstart', `gui/${env.uid}/${handle.name}`]);
  } else if (handle.mode === 'systemd-user') {
    adoptUserRuntimeDir(env.uid);
    env.runner.run('systemctl', ['--user', 'start', handle.name!]);
  } else if (handle.mode === 'systemd-system') {
    env.runner.run('systemctl', ['start', handle.name!]);
  } else if (handle.mode === 'nohup') {
    env.runner.run('bash', [handle.definition!], projectRoot);
  }
}

export async function drainContainers(
  projectRoot: string,
  env: ServiceEnvironment,
  timeoutMs = 300_000,
): Promise<void> {
  const runtime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const label = `nanoclaw-install=${getInstallSlug(projectRoot)}`;
  const started = Date.now();
  while (true) {
    const listed = env.runner.tryRun(runtime, ['ps', '-q', '--filter', `label=${label}`]);
    if (!listed.ok) throw new Error(`Cannot inspect active NanoClaw containers with ${runtime}`);
    if (!listed.stdout) return;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for active NanoClaw containers: ${listed.stdout.split('\n').join(', ')}`);
    }
    await env.sleep(1_000);
  }
}

export async function verifyServiceHealth(
  handle: ServiceHandle,
  projectRoot: string,
  env: ServiceEnvironment,
  timeoutMs = 60_000,
): Promise<boolean> {
  if (!handle.active) return true;
  // NOT data/ncl.sock — src/install-slug.ts's getRuntimeSocketDir moved
  // the real socket to a short, slug-keyed runtime dir (sockaddr_un's
  // 104-byte limit made a DATA_DIR-relative path unsafe for a deep
  // install path). Mirrors src/cli/socket-client.ts's DEFAULT_SOCKET_PATH
  // computation for this specific projectRoot, since that constant's own
  // default (process.cwd()) may not match the install being verified here.
  const socket = process.env.NANOCLAW_NCL_SOCKET || path.join(getRuntimeSocketDir(projectRoot), 'ncl.sock');
  const started = Date.now();
  // A probe failure here is "not healthy yet", not a verdict: the start just
  // succeeded, so the manager is reachable and the window is for settling.
  // Only a failure that persists to the timeout is reported — see below.
  let probeError: unknown;
  while (Date.now() - started < timeoutMs) {
    let current: ServiceHandle | undefined;
    try {
      current = detectService(projectRoot, env);
      probeError = undefined;
    } catch (err) {
      probeError = err;
    }
    if (current?.active && !current.transitional && fs.existsSync(socket)) {
      if (env.runner.tryRun(path.join(projectRoot, 'bin', 'ncl'), ['groups', 'list'], projectRoot).ok) return true;
    }
    await env.sleep(500);
  }
  if (probeError) throw probeError;
  return false;
}

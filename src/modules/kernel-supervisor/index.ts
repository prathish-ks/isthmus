/**
 * Kernel supervisor — Phase 11 (Release Packaging), P10-01.
 *
 * Before this module, `nanogo serve` (the Go security kernel EC-02/EC-03
 * wired the TS host to dial exclusively for container.wake/kill/build_image
 * — see src/kernel/client.ts) had zero process-lifecycle wiring anywhere in
 * this codebase. Every real run so far (EC-05's live-Docker tests, EC-06's
 * live smoke test, ADR-018/ADR-019) started it by hand, in a separate
 * terminal, before the TS host ever ran. A beginner install cannot be
 * expected to do that — see ADR-020
 * (go-host/docs/ADR-020-p10-01-minimum-trust-install.md) for the full
 * design rationale. This module closes that gap the same way every other
 * host capability is wired in: host-lifecycle.ts's onHostStart/
 * onHostShutdown registry (the same mechanism approvals/self-mod/etc. use),
 * so `nanogo serve` starts and stops in step with the TS host itself, at
 * the same trust level — same user, no elevated privilege, no separate
 * service unit, no sudo anywhere in this file.
 *
 * Deliberately NOT a new security control. If the `nanogo` binary can't be
 * found, or the process can't be started, this module warns loudly and
 * lets the host keep running. `KernelClient` already fails closed on a
 * missing kernel — every EC-02-gated call throws instead of proceeding — so
 * a host running without a supervised kernel behaves exactly as it always
 * has when nobody happened to start `nanogo serve` by hand: agent
 * containers simply cannot wake. This module only removes the "by hand"
 * part for the common case.
 */
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, KERNEL_SOCKET_PATH, MOUNT_ALLOWLIST_PATH } from '../../config.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';

const PROJECT_ROOT = path.dirname(DATA_DIR);
const SURFACE_ROOT = path.join(PROJECT_ROOT, 'container');
const SERVE_CONFIG_PATH = path.join(DATA_DIR, 'nanogo-serve-config.json');
const TRACE_FILE_PATH = path.join(DATA_DIR, 'nanogo-kernel-trace.json');

const SOCKET_READY_TIMEOUT_MS = 5_000;
const SOCKET_POLL_INTERVAL_MS = 100;
const SHUTDOWN_GRACE_MS = 5_000;
// Capped exponential backoff between automatic restarts. After
// MAX_CONSECUTIVE_FAILURES (== this array's length) failures with no
// RESTART_RESET_AFTER_MS of clean uptime in between, this module stops
// retrying and logs a loud, one-time error rather than looping forever —
// matching this project's existing "never silently keep failing without
// telling anyone" posture (see circuit-breaker.ts for the same idea applied
// to host startup itself).
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const RESTART_RESET_AFTER_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = RESTART_BACKOFF_MS.length;

let child: ChildProcess | null = null;
let shuttingDown = false;
let consecutiveFailures = 0;
let startedAt = 0;
let restartTimer: NodeJS.Timeout | null = null;

/**
 * Locate the `nanogo` binary. Checked in order: an explicit override
 * (NANOCLAW_NANOGO_BIN — for development, or a non-standard install
 * layout), a binary built in place by `go-host/scripts/install.sh`'s
 * build-from-source path, a binary installed by that same script's
 * downloaded-release path (~/.local/bin — the conventional user-owned,
 * no-sudo bin dir; see ADR-020), then finally the shell's own PATH. Never
 * searches a system-wide location that would imply a privileged install.
 */
export function locateNanogoBinary(): string | null {
  const override = process.env.NANOCLAW_NANOGO_BIN;
  if (override) {
    return fs.existsSync(override) ? override : null;
  }

  const candidates = [
    path.join(PROJECT_ROOT, 'go-host', 'bin', 'nanogo'),
    path.join(os.homedir(), '.local', 'bin', 'nanogo'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'nanogo');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Write the minimal single-session config file `nanogo serve -config`
 * requires (internal/config.Config — every field mandatory per its own
 * Validate()). buildServeKernel (cmd/nanogo/serve.go) only ever reads
 * DataDir/GroupsDir from it for the real production kernel — the
 * user/agent-group/session fields are P3-02's original single-session
 * protocol-proof format, and are never consulted by anything serve's own
 * kernel construction does. This is a real, load-bearing rough edge in a
 * format now doing a job (production server config) it wasn't designed
 * for — named plainly here and in ADR-020, rather than silently worked
 * around. The placeholder values below are inert: nothing reads them.
 */
function ensureServeConfig(): string {
  const cfg = {
    data_dir: DATA_DIR,
    groups_dir: GROUPS_DIR,
    user_id: 'kernel-supervisor',
    agent_group_id: 'kernel-supervisor',
    agent_folder: 'kernel-supervisor',
    session_id: 'kernel-supervisor',
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SERVE_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  return SERVE_CONFIG_PATH;
}

function buildServeArgs(): string[] {
  const args = [
    'serve',
    '-config',
    ensureServeConfig(),
    '-kernel-socket',
    KERNEL_SOCKET_PATH,
    // Reuses the SAME allowlist file src/modules/mount-security/index.ts
    // already manages (~/.config/nanoclaw/mount-allowlist.json) — the Go
    // port (mount.CheckAllowlistedExtra, ADR-004) reads the identical file
    // format for parity, so this is the one allowlist an operator
    // maintains, not a second copy. If it's missing, buildServeKernel logs
    // its own loud "no -allowlist configured" warning (ADR-018's follow-up)
    // — this module does not duplicate that check.
    '-allowlist',
    MOUNT_ALLOWLIST_PATH,
    '-surface-root',
    SURFACE_ROOT,
  ];
  if (process.env.NANOCLAW_KERNEL_RESOLVE_SYMLINKS === '1') {
    args.push('-resolve-symlinks');
  }
  if (process.env.NANOCLAW_KERNEL_DOCKER_NETWORK) {
    args.push('-docker-network', process.env.NANOCLAW_KERNEL_DOCKER_NETWORK);
  }
  // On by default: `nanogo trace <id>` (P7-03) is otherwise unusable
  // out of the box, and OBJ-06 (diagnostics) is a named project goal.
  if (process.env.NANOCLAW_KERNEL_DISABLE_TRACE !== '1') {
    args.push('-trace-file', TRACE_FILE_PATH, '-trace-capacity', '200');
  }
  return args;
}

/**
 * Poll for socketPath to appear, bailing out early (returning `false`
 * without waiting out the full timeout) once `superseded()` reports this
 * particular spawn attempt is no longer the current one — e.g. its child
 * already crashed and a restart has taken over. Without this, a crashed
 * attempt's own wait loop keeps polling the same path for the full
 * timeout, and — since a fast crash-and-restart cycle can complete a
 * socket before that timeout elapses — would then falsely report "is
 * listening" under its own, already-dead pid once the RESTARTED process
 * creates the socket. Found via this module's own sandbox self-test before
 * delivery (a duplicate, misattributed "is listening" log line); each
 * spawn attempt now only ever reports on its own child's actual fate.
 */
async function waitForSocket(socketPath: string, timeoutMs: number, superseded: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return true;
    if (superseded()) return false;
    await new Promise((r) => setTimeout(r, SOCKET_POLL_INTERVAL_MS));
  }
  return fs.existsSync(socketPath);
}

function scheduleRestart(nanogoPath: string): void {
  if (shuttingDown) return;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    log.error(
      'nanogo serve keeps crashing — giving up automatic restarts. Container wake/kill will fail until this is fixed and the host is restarted.',
      { consecutiveFailures },
    );
    return;
  }
  const delay = RESTART_BACKOFF_MS[Math.min(consecutiveFailures, RESTART_BACKOFF_MS.length - 1)];
  log.warn('Scheduling nanogo serve restart', { delayMs: delay, consecutiveFailures });
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void spawnKernel(nanogoPath);
  }, delay);
}

/**
 * Start (or restart) the kernel process. Resolves `true` once THIS
 * invocation's own child has opened the socket within
 * SOCKET_READY_TIMEOUT_MS; resolves `false` if that child crashes, is
 * superseded by a restart, or the timeout elapses first. Only ever reports
 * on the specific child it spawned — see waitForSocket's doc comment for
 * why: an earlier draft let a crashed attempt's own wait loop keep polling
 * past its child's death and log a misattributed "is listening" line once
 * a *different*, restarted process created the socket. Found and fixed via
 * this module's own sandbox self-test before delivery.
 */
async function spawnKernel(nanogoPath: string): Promise<boolean> {
  const args = buildServeArgs();
  log.info('Starting nanogo serve', { bin: nanogoPath, socket: KERNEL_SOCKET_PATH });

  // Stale socket from an unclean previous exit: nanogo's own listener setup
  // would otherwise fail with "address already in use" against a socket
  // file nothing is listening on. Safe to remove unconditionally here —
  // this function only runs when we're about to become the one process
  // that should own this path.
  try {
    fs.unlinkSync(KERNEL_SOCKET_PATH);
  } catch {
    // ENOENT is the expected case; anything else surfaces via the exit
    // handler below when nanogo itself fails to bind.
  }

  const proc = spawn(nanogoPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group — same reasoning as drivers/cli.ts's realCli: a
    // service manager (or an interactive Ctrl-C) signaling the host's whole
    // group must not also blindly signal this child. Shutdown is always
    // explicit, from onHostShutdown below, so ordering is deterministic.
    detached: true,
  });
  child = proc;
  startedAt = Date.now();

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log.info(`nanogo: ${line}`);
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log.warn(`nanogo: ${line}`);
    }
  });

  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    if (shuttingDown) {
      log.info('nanogo serve stopped', { code, signal });
      return;
    }
    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs >= RESTART_RESET_AFTER_MS) {
      consecutiveFailures = 0;
    }
    consecutiveFailures += 1;
    log.error('nanogo serve exited unexpectedly', { code, signal, uptimeMs, consecutiveFailures });
    scheduleRestart(nanogoPath);
  });

  proc.on('error', (err) => {
    log.error('Failed to start nanogo serve', { err });
  });

  const ready = await waitForSocket(KERNEL_SOCKET_PATH, SOCKET_READY_TIMEOUT_MS, () => child !== proc);
  if (child !== proc) {
    // Superseded — this child already exited and a restart has taken over
    // (or shutdown began). That restart's own spawnKernel call is
    // responsible for reporting readiness; saying anything here would be
    // misattributed to a pid that is already gone.
    return ready;
  }
  if (ready) {
    log.info('nanogo serve is listening', { socket: KERNEL_SOCKET_PATH, pid: proc.pid });
  } else {
    log.warn(
      'nanogo serve did not open its socket within the expected time — it may still be starting, or may have failed; check the logs above',
      {
        socket: KERNEL_SOCKET_PATH,
      },
    );
  }
  return ready;
}

onHostStart(async () => {
  if (process.env.NANOCLAW_KERNEL_DISABLE === '1') {
    log.info(
      'nanogo serve supervision disabled via NANOCLAW_KERNEL_DISABLE — container wake/kill will fail unless something else runs it',
    );
    return;
  }
  const nanogoPath = locateNanogoBinary();
  if (!nanogoPath) {
    log.warn(
      'nanogo binary not found — container wake/kill will fail until it is installed. Run go-host/scripts/install.sh, or set NANOCLAW_NANOGO_BIN to an existing binary.',
    );
    return;
  }
  await spawnKernel(nanogoPath);
});

onHostShutdown(async () => {
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  const proc = child;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.warn('nanogo serve did not exit after SIGTERM — sending SIGKILL', { pid: proc.pid });
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, SHUTDOWN_GRACE_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
});

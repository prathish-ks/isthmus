import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRuntimeSocketDir } from '../../src/install-slug.js';
import {
  adoptUserRuntimeDir,
  createCommandRunner,
  detectService,
  drainContainers,
  probe,
  startService,
  stopService,
  verifyServiceHealth,
  type CommandRunner,
  type ServiceEnvironment,
  type ServiceHandle,
} from './service.js';

const roots: string[] = [];

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-update-service-'));
  roots.push(root);
  return root;
}

type FakeResponse = { ok: boolean; stdout?: string; status?: number | null; stderr?: string };

function makeEnv(platform: NodeJS.Platform, responses: Record<string, FakeResponse> = {}) {
  const home = temp();
  const calls: string[] = [];
  const runner: CommandRunner = {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key];
      if (response && !response.ok) {
        // Same shape as execFileSync's error: exit status (null when unspawnable) + stderr.
        throw Object.assign(new Error(`Command failed: ${key}\n${response.stderr ?? ''}`), {
          status: response.status === undefined ? 1 : response.status,
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
        });
      }
      return response?.stdout ?? '';
    },
    tryRun(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key] ?? { ok: true, stdout: '' };
      return { ok: response.ok, stdout: response.stdout ?? '', status: response.status ?? (response.ok ? 0 : 1) };
    },
  };
  const env: ServiceEnvironment = {
    platform,
    home,
    uid: 1000,
    runner,
    sleep: async () => {},
  };
  return { env, calls, home };
}

function slug(root: string): string {
  return createHash('sha1').update(root).digest('hex').slice(0, 8);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('service-mode detection and control', () => {
  it('detects and controls a user systemd unit', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, calls, home } = makeEnv('linux', {
      [`systemctl --user is-active ${name}`]: { ok: true },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');

    const handle = detectService(root, env);
    expect(handle).toMatchObject({ mode: 'systemd-user', active: true, name });
    await stopService(handle, env);
    startService(handle, root, env);

    expect(calls).toContain(`systemctl --user stop ${name}`);
    expect(calls).toContain(`systemctl --user start ${name}`);
  });

  it('uses system-level systemctl without --user for root-installed units', async () => {
    const { env, calls } = makeEnv('linux');
    const handle = { mode: 'systemd-system' as const, active: true, name: 'nanoclaw-v2-root' };

    await stopService(handle, env);
    startService(handle, '/srv/nanoclaw', env);

    expect(calls).toEqual(['systemctl stop nanoclaw-v2-root', 'systemctl start nanoclaw-v2-root']);
  });

  it('bootstraps an unloaded launchd plist instead of relying on kickstart alone', () => {
    const root = temp();
    const name = `com.nanoclaw-v2-${slug(root)}`;
    const { env, calls, home } = makeEnv('darwin', {
      [`launchctl print gui/1000/${name}`]: { ok: false, status: 113, stderr: 'Could not find service' },
    });
    const plist = path.join(home, 'Library', 'LaunchAgents', `${name}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>\n');
    const detected = detectService(root, env);
    expect(detected).toMatchObject({ mode: 'launchd', active: false });

    startService({ ...detected, active: true }, root, env);
    expect(calls).toContain(`launchctl bootstrap gui/1000 ${plist}`);
    expect(calls).toContain(`launchctl kickstart gui/1000/${name}`);
  });

  it('restarts a WSL/nohup install through its recorded start script', () => {
    const root = temp();
    const definition = path.join(root, 'start-nanoclaw.sh');
    const { env, calls } = makeEnv('linux');

    startService({ mode: 'nohup', active: true, definition, pid: 4242 }, root, env);

    expect(calls).toEqual([`bash ${definition}`]);
  });

  it('refuses to mutate under an unmanaged pnpm-dev process', async () => {
    const root = temp();
    const pattern = `${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(dist/index\\.js|src/index\\.ts)`;
    const { env } = makeEnv('linux', {
      [`pgrep -f ${pattern}`]: { ok: true, stdout: '1234' },
    });

    const handle = detectService(root, env);
    expect(handle).toMatchObject({ mode: 'unmanaged', active: true, name: '1234' });
    await expect(stopService(handle, env)).rejects.toThrow('outside a supported service wrapper');
  });
});

describe('liveness probes: running / stopped / probe failed', () => {
  // The bug: `.ok` read every non-zero exit as "stopped". With no user bus
  // (`su -`, cron, non-interactive SSH) systemctl fails before it can look,
  // and cutover then skipped the stop, finished the restart, and reported
  // the update complete against the stale host. Only the documented
  // stopped-exit code is actually "stopped" — anything else is a refusal.
  const busError = 'Failed to connect to bus: No medium found';

  it('systemd --user: exit 3 is stopped, a bus error is a refusal that names the fix', () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const stopped = makeEnv('linux', { [`systemctl --user is-active ${name}`]: { ok: false, status: 3 } });
    const unitDir = path.join(stopped.home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, `${name}.service`), '[Service]\n');
    expect(detectService(root, stopped.env)).toMatchObject({ mode: 'systemd-user', active: false });

    const root2 = temp();
    const name2 = `nanoclaw-v2-${slug(root2)}`;
    const failed = makeEnv('linux', {
      [`systemctl --user is-active ${name2}`]: { ok: false, status: 1, stderr: busError },
    });
    const unitDir2 = path.join(failed.home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir2, { recursive: true });
    fs.writeFileSync(path.join(unitDir2, `${name2}.service`), '[Service]\n');
    expect(() => detectService(root2, failed.env)).toThrow(/Cannot tell whether NanoClaw is running/);
    expect(() => detectService(root2, failed.env)).toThrow(/No medium found/);
  });

  it('systemd-user: a unit mid auto-restart (activating/deactivating) is transitional, never healthy', () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, home } = makeEnv('linux', {
      [`systemctl --user is-active ${name}`]: { ok: false, status: 3, stdout: 'deactivating' },
    });
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, `${name}.service`), '[Service]\n');
    expect(detectService(root, env)).toMatchObject({ mode: 'systemd-user', active: true, transitional: true });
  });

  it('launchd: 113 (not loaded) is stopped, 112 (no domain, e.g. SSH without a GUI session) refuses', () => {
    const root = temp();
    const name = `com.nanoclaw-v2-${slug(root)}`;
    const key = `launchctl print gui/1000/${name}`;
    const notLoaded = makeEnv('darwin', { [key]: { ok: false, status: 113, stderr: 'Could not find service' } });
    fs.mkdirSync(path.join(notLoaded.home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(notLoaded.home, 'Library', 'LaunchAgents', `${name}.plist`), '<plist/>\n');
    expect(detectService(root, notLoaded.env)).toMatchObject({ mode: 'launchd', active: false });

    const root2 = temp();
    const name2 = `com.nanoclaw-v2-${slug(root2)}`;
    const key2 = `launchctl print gui/1000/${name2}`;
    const noDomain = makeEnv('darwin', {
      [key2]: { ok: false, status: 112, stderr: 'Could not find domain for user gui: 1000' },
    });
    fs.mkdirSync(path.join(noDomain.home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(noDomain.home, 'Library', 'LaunchAgents', `${name2}.plist`), '<plist/>\n');
    expect(() => detectService(root2, noDomain.env)).toThrow(/Could not find domain/);
  });

  it('pgrep: exit 1 is nothing running, an unspawnable pgrep refuses (real runner)', () => {
    const root = temp();
    const runner = createCommandRunner();
    const { env } = makeEnv('linux');
    env.runner = runner;
    expect(detectService(root, env)).toEqual({ mode: 'none', active: false });

    env.runner = {
      run: (command, args, cwd) => runner.run(command === 'pgrep' ? 'pgrep-missing-zz' : command, args, cwd),
      tryRun: runner.tryRun,
    };
    expect(() => detectService(root, env)).toThrow(/pgrep.*ENOENT.*Install procps/s);
  });

  it('probe() distinguishes a stopped exit from a probe failure directly', () => {
    const args = ['is-active', 'nanoclaw-v2-x'];
    const key = `systemctl ${args.join(' ')}`;
    const stopped = makeEnv('linux', { [key]: { ok: false, status: 3, stdout: 'inactive' } });
    expect(probe(stopped.env, 'systemctl', args, [3], 'hint')).toBeUndefined();
    const running = makeEnv('linux', { [key]: { ok: true, stdout: 'active' } });
    expect(probe(running.env, 'systemctl', args, [3], 'hint')).toEqual({ stdout: 'active', transitional: false });
    const broken = makeEnv('linux', { [key]: { ok: false, status: 1, stderr: busError } });
    expect(() => probe(broken.env, 'systemctl', args, [3], 'hint')).toThrow(/No medium found.*hint/s);
  });

  it('adopts /run/user/<uid> as XDG_RUNTIME_DIR only when unset and present', () => {
    const runRoot = temp();
    const saved = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      adoptUserRuntimeDir(1000, runRoot);
      expect(process.env.XDG_RUNTIME_DIR).toBeUndefined();

      fs.mkdirSync(path.join(runRoot, '1000'));
      adoptUserRuntimeDir(1000, runRoot);
      expect(process.env.XDG_RUNTIME_DIR).toBe(path.join(runRoot, '1000'));

      process.env.XDG_RUNTIME_DIR = '/run/user/keep';
      adoptUserRuntimeDir(1000, runRoot);
      expect(process.env.XDG_RUNTIME_DIR).toBe('/run/user/keep');
    } finally {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    }
  });

  it('verifyServiceHealth tolerates a transient probe failure but reports a persistent one at the timeout', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const key = `systemctl --user is-active ${name}`;
    const { env, home } = makeEnv('linux', {
      [`${path.join(root, 'bin', 'ncl')} groups list`]: { ok: true },
    });
    const unitDir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, `${name}.service`), '[Service]\n');
    fs.mkdirSync(getRuntimeSocketDir(root), { recursive: true });
    fs.writeFileSync(path.join(getRuntimeSocketDir(root), 'ncl.sock'), 'test socket stand-in');
    const handle = { mode: 'systemd-user' as const, active: true, name };

    let probes = 0;
    env.runner.run = (command, args) => {
      if (`${command} ${args.join(' ')}` !== key) return '';
      probes += 1;
      if (probes === 1) throw Object.assign(new Error('Command failed'), { status: 1, stderr: busError });
      return '';
    };
    await expect(verifyServiceHealth(handle, root, env, 5_000)).resolves.toBe(true);
    expect(probes).toBe(2);

    let clock = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      env.sleep = async () => {
        clock += 500;
      };
      env.runner.run = () => {
        throw Object.assign(new Error('Command failed'), { status: 1, stderr: busError });
      };
      await expect(verifyServiceHealth(handle, root, env, 2_000)).rejects.toThrow(/No medium found/);
    } finally {
      now.mockRestore();
    }
  });
});

describe('drain and health gates', () => {
  const roleFormat = '{{.ID}}|{{.Label "nanoclaw-role"}}';

  it('filters active containers by this install slug', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const key = `docker ps --filter label=${label} --format ${roleFormat}`;
    const { env, calls } = makeEnv('linux', {
      [key]: { ok: true, stdout: '' },
    });

    await drainContainers(root, env);
    expect(calls).toEqual([key]);
  });

  it('never waits on a gateway-role container (#3948) — returns immediately', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const key = `docker ps --filter label=${label} --format ${roleFormat}`;
    const { env } = makeEnv('linux', {
      [key]: { ok: true, stdout: 'abc123|gateway' },
    });

    // No non-gateway containers present — must return without ever sleeping
    // (a sleep that never resolves would hang this test past its timeout).
    await drainContainers(root, env, 5_000);
  });

  it('still waits for (and times out on) a real non-gateway container', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const key = `docker ps --filter label=${label} --format ${roleFormat}`;
    let sleeps = 0;
    const { env } = makeEnv('linux', {
      [key]: { ok: true, stdout: 'def456|agent' },
    });
    env.sleep = async () => {
      sleeps += 1;
    };

    await expect(drainContainers(root, env, 10)).rejects.toThrow('Timed out waiting for active NanoClaw containers');
    expect(sleeps).toBeGreaterThan(0);
  });

  it('requires active process state, the ncl socket, and a successful CLI probe', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, home } = makeEnv('linux', {
      [`systemctl --user is-active ${name}`]: { ok: true },
      [`${path.join(root, 'bin', 'ncl')} groups list`]: { ok: true },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');
    // Not data/ncl.sock — verifyServiceHealth now checks the same
    // slug-keyed runtime dir the real socket lives in (src/install-slug.ts's
    // getRuntimeSocketDir); the old DATA_DIR-relative path this test used
    // to stand in at was exactly the stale location the socket relocation
    // introduced a real, undetected regression against.
    fs.mkdirSync(getRuntimeSocketDir(root), { recursive: true });
    fs.writeFileSync(path.join(getRuntimeSocketDir(root), 'ncl.sock'), 'test socket stand-in');

    const healthy = await verifyServiceHealth(
      { mode: 'systemd-user', active: true, name, definition: unit },
      root,
      env,
      10,
    );
    expect(healthy).toBe(true);
  });
});

describe('command runner output capacity', () => {
  it('captures well over the 1 MiB default maxBuffer (ENOBUFS regression)', () => {
    // A full vitest run on a large repo exceeds Node's 1 MiB spawnSync default
    // and killed validate as `spawnSync pnpm ENOBUFS` before the tests were
    // ever judged.
    const runner = createCommandRunner();
    const out = runner.run('node', ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024))']);
    expect(out.length).toBe(2 * 1024 * 1024);
  });
});

describe('controller main-module guard', () => {
  it('runs when invoked through a symlink-spelled path (macOS mktemp lives under /var → /private/var)', () => {
    // Before the realpath in the guard, a symlinked argv made the guard false
    // and the controller exited 0 having done nothing — silent success.
    const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-link-'));
    const link = path.join(linkRoot, 'repo');
    fs.symlinkSync(path.resolve(__dirname, '..', '..'), link);
    try {
      const result = spawnSync('pnpm', ['exec', 'tsx', path.join(link, 'scripts', 'update-nanoclaw.ts')], {
        cwd: path.resolve(__dirname, '..', '..'),
        encoding: 'utf8',
        timeout: 60_000,
      });
      // Reaching main() at all means the guard held: no arguments is a loud
      // usage error (exit 1 + error JSON), never a silent empty exit 0.
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('nanoclaw-update-error/v1');
      expect(result.stderr).toContain('Missing command');
    } finally {
      fs.rmSync(linkRoot, { recursive: true, force: true });
    }
  });
});

describe('stopService idempotency (already-stopped is success, per mode)', () => {
  const env = (runner: CommandRunner): ServiceEnvironment => ({
    platform: 'darwin',
    home: os.homedir(),
    uid: 501,
    runner,
    sleep: async () => {},
  });

  // launchctl as stopService sees it: `print` reports the job (with a pid)
  // while it's still in the domain, for `loadedPolls` calls after bootout,
  // then reports not-found.
  function launchd(options: { loadedPolls: number; pid?: number; bootoutError?: string }) {
    let remaining: number | undefined;
    let sleeps = 0;
    const runner: CommandRunner = {
      run(command, args) {
        if (args[0] === 'bootout') {
          remaining = options.loadedPolls;
          if (options.bootoutError) throw new Error(`Boot-out failed: ${options.bootoutError}`);
          return '';
        }
        return '';
      },
      tryRun(command, args) {
        if (args[0] === 'print') {
          if (remaining === undefined || remaining-- > 0) {
            return { ok: true, stdout: `state = running\n\tpid = ${options.pid ?? 99999999}\n` };
          }
          return { ok: false, stdout: '' };
        }
        return { ok: true, stdout: '' };
      },
    };
    const environment: ServiceEnvironment = { ...env(runner), sleep: async () => void (sleeps += 1) };
    return { environment, sleeps: () => sleeps };
  }
  const handle: ServiceHandle = { mode: 'launchd', active: true, name: 'x', definition: '/Users/me/x.plist' };

  it('waits after launchd bootout until the job has left the domain', async () => {
    const fake = launchd({ loadedPolls: 3 });
    await expect(stopService(handle, fake.environment)).resolves.toBeUndefined();
    expect(fake.sleeps()).toBe(3);
  });

  it('throws when the launchd job is still loaded after the bounded wait', async () => {
    const fake = launchd({ loadedPolls: Infinity, pid: 4242 });
    await expect(stopService(handle, fake.environment)).rejects.toThrow(
      /NanoClaw service x did not stop \(PID 4242\)\..*launchctl bootstrap gui\/501 \/Users\/me\/x\.plist/,
    );
    expect(fake.sleeps()).toBe(60);
  });

  it('tolerates launchd bootout of a not-loaded job, in launchctl own words', async () => {
    const fake = launchd({ loadedPolls: 0, bootoutError: '3: No such process' });
    await expect(stopService(handle, fake.environment)).resolves.toBeUndefined();
    expect(fake.sleeps()).toBe(0);
  });

  it('still throws for any other launchd stop failure — the caller must abort before destroying anything', async () => {
    const fake = launchd({ loadedPolls: 0, bootoutError: '5: Input/output error' });
    await expect(stopService(handle, fake.environment)).rejects.toThrow(/Input\/output error/);
  });

  it('tolerates ESRCH for a nohup pid that already exited', async () => {
    // A freshly-exited real pid; if the OS reused it in the microseconds
    // since spawnSync returned, kill() raises no ESRCH and the wait loop
    // fails loudly rather than the test passing vacuously.
    const dead = spawnSync('node', ['-e', '']);
    await expect(
      stopService(
        { mode: 'nohup', active: true, pid: dead.pid },
        env({ run: () => '', tryRun: () => ({ ok: true, stdout: '' }) }),
      ),
    ).resolves.toBeUndefined();
  });
});

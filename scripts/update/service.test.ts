import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getRuntimeSocketDir } from '../../src/install-slug.js';
import {
  createCommandRunner,
  detectService,
  drainContainers,
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

function makeEnv(platform: NodeJS.Platform, responses: Record<string, { ok: boolean; stdout?: string }> = {}) {
  const home = temp();
  const calls: string[] = [];
  const runner: CommandRunner = {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key];
      if (response && !response.ok) throw new Error(key);
      return response?.stdout ?? '';
    },
    tryRun(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key] ?? { ok: true, stdout: '' };
      return { ok: response.ok, stdout: response.stdout ?? '' };
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
      [`systemctl --user is-active --quiet ${name}`]: { ok: true },
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
      [`launchctl print gui/1000/${name}`]: { ok: false },
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

describe('drain and health gates', () => {
  it('filters active containers by this install slug', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env, calls } = makeEnv('linux', {
      [`docker ps -q --filter label=${label}`]: { ok: true, stdout: '' },
    });

    await drainContainers(root, env);
    expect(calls).toEqual([`docker ps -q --filter label=${label}`]);
  });

  it('requires active process state, the ncl socket, and a successful CLI probe', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, home } = makeEnv('linux', {
      [`systemctl --user is-active --quiet ${name}`]: { ok: true },
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

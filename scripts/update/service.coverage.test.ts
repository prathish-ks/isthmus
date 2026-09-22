import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRuntimeSocketDir } from '../../src/install-slug.js';
import {
  createCommandRunner,
  defaultServiceEnvironment,
  detectService,
  drainContainers,
  startService,
  stopService,
  verifyServiceHealth,
  type CommandRunner,
  type ServiceEnvironment,
} from './service.js';

const roots: string[] = [];
const killAfter: number[] = [];

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-update-service-cov-'));
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
  for (const pid of killAfter.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

describe('createCommandRunner (real execFileSync)', () => {
  it('runs a command and trims stdout on success', () => {
    const runner = createCommandRunner();
    const out = runner.run('node', ['-e', "process.stdout.write('  hello  \\n')"]);
    expect(out).toBe('hello');
  });

  it('throws when the underlying command fails', () => {
    const runner = createCommandRunner();
    expect(() => runner.run('node', ['-e', 'process.exit(1)'])).toThrow();
  });

  it('tryRun reports ok:true with the trimmed stdout on success', () => {
    const runner = createCommandRunner();
    const result = runner.tryRun('node', ['-e', "process.stdout.write('fine')"]);
    expect(result).toEqual({ ok: true, stdout: 'fine' });
  });

  it('tryRun reports ok:false and joins stdout+stderr on failure', () => {
    const runner = createCommandRunner();
    const result = runner.tryRun('node', [
      '-e',
      "process.stdout.write('OUT'); process.stderr.write('ERR'); process.exit(3)",
    ]);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe('OUT\nERR');
  });

  it('honors an explicit cwd', () => {
    const root = temp();
    const runner = createCommandRunner();
    const out = runner.run('node', ['-e', 'process.stdout.write(process.cwd())'], root);
    expect(fs.realpathSync(out)).toBe(fs.realpathSync(root));
  });
});

describe('defaultServiceEnvironment', () => {
  it('reflects the real platform/home/uid and a working sleep', async () => {
    const env = defaultServiceEnvironment();
    expect(env.platform).toBe(process.platform);
    expect(env.home).toBe(os.homedir());
    expect(env.uid).toBe(process.getuid?.() ?? 0);
    expect(typeof env.runner.run).toBe('function');
    const started = Date.now();
    await env.sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
  });

  it('accepts an injected runner', () => {
    const fakeRunner: CommandRunner = { run: () => '', tryRun: () => ({ ok: true, stdout: '' }) };
    const env = defaultServiceEnvironment(fakeRunner);
    expect(env.runner).toBe(fakeRunner);
  });
});

describe('detectService fallthrough and edge branches', () => {
  it('falls through darwin with no plist to the unmanaged/none probe', () => {
    const root = temp();
    const { env } = makeEnv('darwin');
    expect(detectService(root, env)).toEqual({ mode: 'none', active: false });
  });

  it('falls through linux with no unit files or nohup pair to none', () => {
    const root = temp();
    const { env } = makeEnv('linux');
    expect(detectService(root, env)).toEqual({ mode: 'none', active: false });
  });

  it('treats a non-empty pgrep match as unmanaged even on an unrecognized platform', () => {
    const root = temp();
    const { env } = makeEnv('win32' as NodeJS.Platform, {
      [`pgrep -f ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(dist/index\\.js|src/index\\.ts)`]: {
        ok: true,
        stdout: '111\n222',
      },
    });
    expect(detectService(root, env)).toEqual({ mode: 'unmanaged', active: true, name: '111,222' });
  });

  it('treats an empty pgrep match as mode none', () => {
    const root = temp();
    const { env } = makeEnv('win32' as NodeJS.Platform, {
      [`pgrep -f ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(dist/index\\.js|src/index\\.ts)`]: {
        ok: true,
        stdout: '',
      },
    });
    expect(detectService(root, env)).toEqual({ mode: 'none', active: false });
  });

  it('detects a system-level systemd unit outside HOME', () => {
    // /etc/systemd/system is not writable in this sandbox, so the presence
    // check is stubbed via fs.existsSync rather than a real file.
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env } = makeEnv('linux', {
      [`systemctl is-active --quiet ${name}`]: { ok: true },
    });
    const systemDefinition = `/etc/systemd/system/${name}.service`;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === systemDefinition);
    try {
      expect(detectService(root, env)).toEqual({
        mode: 'systemd-system',
        name,
        definition: systemDefinition,
        active: true,
      });
    } finally {
      existsSpy.mockRestore();
    }
  });

  it('ignores a start script with no matching pid file', () => {
    const root = temp();
    const { env } = makeEnv('linux');
    fs.writeFileSync(path.join(root, 'start-nanoclaw.sh'), '#!/bin/sh\n');
    expect(detectService(root, env)).toEqual({ mode: 'none', active: false });
  });

  it('detects a live nohup process from its recorded pid', () => {
    const root = temp();
    const { env } = makeEnv('linux');
    fs.writeFileSync(path.join(root, 'start-nanoclaw.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'nanoclaw.pid'), String(process.pid));

    const handle = detectService(root, env);
    expect(handle).toEqual({
      mode: 'nohup',
      definition: path.join(root, 'start-nanoclaw.sh'),
      pid: process.pid,
      active: true,
    });
  });

  it('records an undefined pid and inactive state when the pid file is not numeric', () => {
    const root = temp();
    const { env } = makeEnv('linux');
    fs.writeFileSync(path.join(root, 'start-nanoclaw.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'nanoclaw.pid'), 'not-a-number');

    const handle = detectService(root, env);
    expect(handle).toEqual({
      mode: 'nohup',
      definition: path.join(root, 'start-nanoclaw.sh'),
      pid: undefined,
      active: false,
    });
  });

  it('reports a stale nohup pid as inactive', () => {
    const root = temp();
    const { env } = makeEnv('linux');
    fs.writeFileSync(path.join(root, 'start-nanoclaw.sh'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(root, 'nanoclaw.pid'), '2147483647');

    const handle = detectService(root, env);
    expect(handle).toEqual({
      mode: 'nohup',
      definition: path.join(root, 'start-nanoclaw.sh'),
      pid: 2147483647,
      active: false,
    });
  });
});

describe('stopService branch coverage', () => {
  it('does nothing for an inactive handle', async () => {
    const { env, calls } = makeEnv('linux');
    await stopService({ mode: 'launchd', active: false }, env);
    expect(calls).toEqual([]);
  });

  it('boots out an active launchd job', async () => {
    const { env, calls } = makeEnv('darwin');
    await stopService({ mode: 'launchd', active: true, name: 'com.nanoclaw-v2-x' }, env);
    expect(calls).toEqual(['launchctl bootout gui/1000/com.nanoclaw-v2-x']);
  });

  it('does nothing for a nohup handle with no pid recorded', async () => {
    const { env, calls } = makeEnv('linux');
    await stopService({ mode: 'nohup', active: true }, env);
    expect(calls).toEqual([]);
  });

  it('successfully stops a nohup process that exits promptly', async () => {
    const { env } = makeEnv('linux');
    const child = spawn('sleep', ['0.05'], { stdio: 'ignore' });
    const pid = child.pid as number;
    // Real sleep() so the polling loop observes the child actually exiting.
    env.sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await expect(stopService({ mode: 'nohup', active: true, pid }, env)).resolves.toBeUndefined();
    let stillAlive = true;
    try {
      process.kill(pid, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);
  });

  it('throws when a nohup process refuses to stop within the poll budget', async () => {
    const { env } = makeEnv('linux');
    const child = spawn('sleep', ['5'], { stdio: 'ignore' });
    const pid = child.pid as number;
    killAfter.push(pid);
    // No-op sleep so the 60-iteration loop spins fast without waiting on the real clock,
    // and the still-alive child causes the final throw.
    env.sleep = async () => {};
    await expect(stopService({ mode: 'nohup', active: true, pid }, env)).rejects.toThrow(
      `NanoClaw process ${pid} did not stop`,
    );
  });
});

describe('startService branch coverage', () => {
  it('does nothing for an inactive handle', () => {
    const { env, calls } = makeEnv('linux');
    startService({ mode: 'systemd-user', active: false, name: 'x' }, '/root', env);
    expect(calls).toEqual([]);
  });

  it('is a no-op for an active handle whose mode matches none of the managed branches', () => {
    const { env, calls } = makeEnv('linux');
    startService({ mode: 'none', active: true }, '/root', env);
    expect(calls).toEqual([]);
  });
});

describe('drainContainers branch coverage', () => {
  it('throws when the runtime cannot be inspected', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env } = makeEnv('linux', {
      [`docker ps -q --filter label=${label}`]: { ok: false },
    });
    await expect(drainContainers(root, env)).rejects.toThrow('Cannot inspect active NanoClaw containers');
  });

  it('times out when containers stay listed past the deadline', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env } = makeEnv('linux', {
      [`docker ps -q --filter label=${label}`]: { ok: true, stdout: '9999' },
    });
    await expect(drainContainers(root, env, 0)).rejects.toThrow(
      'Timed out waiting for active NanoClaw containers: 9999',
    );
  });

  it('polls again when containers are still listed but the deadline has not passed', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    let calls = 0;
    const env: ServiceEnvironment = {
      platform: 'linux',
      home: temp(),
      uid: 1000,
      runner: {
        run: () => '',
        tryRun: () => {
          calls += 1;
          return calls === 1 ? { ok: true, stdout: '123' } : { ok: true, stdout: '' };
        },
      },
      sleep: async () => {},
    };
    await drainContainers(root, env, 60_000);
    expect(calls).toBe(2);
  });
});

describe('verifyServiceHealth branch coverage', () => {
  it('returns true immediately for an inactive handle', async () => {
    const { env } = makeEnv('linux');
    const healthy = await verifyServiceHealth({ mode: 'none', active: false }, '/root', env, 10);
    expect(healthy).toBe(true);
  });

  it('times out and returns false when the service never becomes healthy', async () => {
    const root = temp();
    const { env } = makeEnv('linux');
    const healthy = await verifyServiceHealth({ mode: 'systemd-user', active: true, name: 'x' }, root, env, 5);
    expect(healthy).toBe(false);
  });

  it('keeps polling when active+socket present but the ncl probe fails, then times out', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, home } = makeEnv('linux', {
      [`systemctl --user is-active --quiet ${name}`]: { ok: true },
      [`${path.join(root, 'bin', 'ncl')} groups list`]: { ok: false },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');
    // Not data/ncl.sock — see verifyServiceHealth's own comment (service.ts).
    fs.mkdirSync(getRuntimeSocketDir(root), { recursive: true });
    fs.writeFileSync(path.join(getRuntimeSocketDir(root), 'ncl.sock'), 'stand-in');

    const healthy = await verifyServiceHealth(
      { mode: 'systemd-user', active: true, name, definition: unit },
      root,
      env,
      5,
    );
    expect(healthy).toBe(false);
  });
});

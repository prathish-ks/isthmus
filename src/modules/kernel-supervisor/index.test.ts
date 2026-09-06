import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let tmpDir: string;
let dataDir: string;
let groupsDir: string;
let socketPath: string;
let allowlistPath: string;
let fixturesDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-supervisor-test-'));
  dataDir = path.join(tmpDir, 'data');
  groupsDir = path.join(tmpDir, 'groups');
  socketPath = path.join(dataDir, 'nanogo-kernel.sock');
  allowlistPath = path.join(tmpDir, 'mount-allowlist.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(groupsDir, { recursive: true });
  fixturesDir = path.join(__dirname, '__fixtures__');

  vi.doMock('../../config.js', () => ({
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
    KERNEL_SOCKET_PATH: socketPath,
    MOUNT_ALLOWLIST_PATH: allowlistPath,
  }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NANOCLAW_NANOGO_BIN;
  delete process.env.NANOCLAW_KERNEL_DISABLE;
});

function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

/** Poll a predicate until it's true or the timeout elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe('kernel-supervisor: binary location', () => {
  it('prefers an explicit NANOCLAW_NANOGO_BIN override', async () => {
    const explicit = fixture('fake-nanogo-normal.sh');
    process.env.NANOCLAW_NANOGO_BIN = explicit;
    const mod = await import('./index.js');
    expect(mod.locateNanogoBinary()).toBe(explicit);
  });

  it('returns null when the override path does not exist', async () => {
    process.env.NANOCLAW_NANOGO_BIN = path.join(tmpDir, 'does-not-exist');
    const mod = await import('./index.js');
    expect(mod.locateNanogoBinary()).toBeNull();
  });

  it('falls back to a locally-built go-host/bin/nanogo under the project root', async () => {
    // PROJECT_ROOT is derived as path.dirname(DATA_DIR) — mirror that here.
    const projectRoot = path.dirname(dataDir);
    const localBin = path.join(projectRoot, 'go-host', 'bin', 'nanogo');
    fs.mkdirSync(path.dirname(localBin), { recursive: true });
    fs.writeFileSync(localBin, '#!/bin/sh\n');
    fs.chmodSync(localBin, 0o755);
    try {
      const mod = await import('./index.js');
      expect(mod.locateNanogoBinary()).toBe(localBin);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('returns null when nanogo is nowhere to be found', async () => {
    // Isolate against the real machine's actual home directory, which may
    // have a real ~/.local/bin/nanogo (e.g. from a prior
    // go-host/scripts/install.sh run) — locateNanogoBinary() checks that
    // path unconditionally, so without this the test's own environment
    // decides the outcome instead of the code under test. Mirrors how the
    // "falls back to a locally-built go-host/bin/nanogo" test above
    // isolates PROJECT_ROOT via DATA_DIR.
    const fakeHome = path.join(tmpDir, 'fake-home');
    fs.mkdirSync(fakeHome, { recursive: true });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const mod = await import('./index.js');
    // Real PATH may or may not contain a stray "nanogo" — assert only
    // that a deliberately empty PATH with no override/local build finds
    // nothing, which is the property that actually matters here.
    const realPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(mod.locateNanogoBinary()).toBeNull();
    } finally {
      process.env.PATH = realPath;
      homedirSpy.mockRestore();
    }
  });
});

describe('kernel-supervisor: real process lifecycle (fixture scripts, no mocked spawn)', () => {
  it('starts nanogo, waits for the socket, and shuts it down gracefully', async () => {
    process.env.NANOCLAW_NANOGO_BIN = fixture('fake-nanogo-normal.sh');
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    for (const cb of lifecycle.getHostStartCallbacks()) {
      await cb({ db: {} as never, signal: new AbortController().signal });
    }
    expect(await waitUntil(() => fs.existsSync(socketPath), 3000)).toBe(true);

    for (const cb of lifecycle.getHostShutdownCallbacks()) {
      await cb();
    }
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 10_000);

  it('automatically restarts a kernel that crashes once, and still ends up listening', async () => {
    const marker = path.join(tmpDir, 'crash-marker');
    process.env.NANOCLAW_NANOGO_BIN = fixture('fake-nanogo-crash-once.sh');
    process.env.NANOCLAW_KERNEL_CRASH_MARKER = marker;
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    try {
      for (const cb of lifecycle.getHostStartCallbacks()) {
        await cb({ db: {} as never, signal: new AbortController().signal });
      }
      // The crash + scheduled restart both happen well inside the module's
      // own socket-ready timeout, so the socket existing here proves the
      // automatic restart actually worked, not just the first attempt.
      expect(await waitUntil(() => fs.existsSync(socketPath), 5000)).toBe(true);

      for (const cb of lifecycle.getHostShutdownCallbacks()) {
        await cb();
      }
    } finally {
      delete process.env.NANOCLAW_KERNEL_CRASH_MARKER;
    }
  }, 10_000);

  it('does not throw and lets the host keep starting when nanogo is not found', async () => {
    process.env.NANOCLAW_NANOGO_BIN = path.join(tmpDir, 'does-not-exist');
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    await expect(
      lifecycle.startHostModules({ db: {} as never, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('respects NANOCLAW_KERNEL_DISABLE and never spawns anything', async () => {
    process.env.NANOCLAW_KERNEL_DISABLE = '1';
    process.env.NANOCLAW_NANOGO_BIN = fixture('fake-nanogo-normal.sh');
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    for (const cb of lifecycle.getHostStartCallbacks()) {
      await cb({ db: {} as never, signal: new AbortController().signal });
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    process.env.NANOCLAW_NANOGO_BIN = fixture('fake-nanogo-ignores-sigterm.sh');
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    for (const cb of lifecycle.getHostStartCallbacks()) {
      await cb({ db: {} as never, signal: new AbortController().signal });
    }
    expect(await waitUntil(() => fs.existsSync(socketPath), 3000)).toBe(true);

    const start = Date.now();
    for (const cb of lifecycle.getHostShutdownCallbacks()) {
      await cb();
    }
    const elapsed = Date.now() - start;
    // The fixture never removes its own socket on SIGKILL (unlike the
    // graceful-exit fixture's own trap), so the only observable proof here
    // is that stop() actually returns instead of hanging forever, and only
    // after waiting out the shutdown grace period.
    expect(elapsed).toBeGreaterThanOrEqual(4_000);
  }, 15_000);
});

describe('kernel-supervisor: serve config file', () => {
  it('writes a config file satisfying internal/config.Config.Validate() with real data/groups dirs', async () => {
    process.env.NANOCLAW_NANOGO_BIN = fixture('fake-nanogo-normal.sh');
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    for (const cb of lifecycle.getHostStartCallbacks()) {
      await cb({ db: {} as never, signal: new AbortController().signal });
    }
    const cfgPath = path.join(dataDir, 'nanogo-serve-config.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(cfg.data_dir).toBe(dataDir);
    expect(cfg.groups_dir).toBe(groupsDir);
    // Every field internal/config.Config.Validate() requires must be
    // non-empty, even though only data_dir/groups_dir are ever read by the
    // real serve kernel (see ensureServeConfig's doc comment).
    for (const field of ['user_id', 'agent_group_id', 'agent_folder', 'session_id']) {
      expect(typeof cfg[field]).toBe('string');
      expect(cfg[field].length).toBeGreaterThan(0);
    }

    for (const cb of lifecycle.getHostShutdownCallbacks()) {
      await cb();
    }
  }, 10_000);
});

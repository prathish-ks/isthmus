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
    EGRESS_LOCKDOWN: false,
  }));
  // Safe, inert default for every test that doesn't care about egress
  // lockdown specifically — the "egress-lockdown network wiring" describe
  // block below overrides this per-test.
  vi.doMock('../../egress-lockdown.js', () => ({
    EGRESS_NETWORK: 'unused-in-this-test',
    ensureEgressNetwork: vi.fn().mockReturnValue(false),
  }));
  // kernel-supervisor/index.ts now imports getGatewayProvider (ADR-033) to
  // resolve defaultDockerNetworkDeps().resolveEgressGatewayAccess. Mocked
  // here, not left to resolve the real barrel, for the same reason
  // config.js/egress-lockdown.js are: the real gateway-providers/index.js ->
  // installed.js -> onecli.ts chain constructs a real OneCLI SDK client at
  // module scope from ONECLI_URL/ONECLI_API_KEY, neither of which this
  // file's own config.js mock provides (this file is about kernel-process
  // lifecycle, not gateway wiring) — importing it for real here throws.
  vi.doMock('../../gateway-providers/index.js', () => ({
    getGatewayProvider: () => ({ kind: 'test-gateway', egressGateway: () => MOCK_EGRESS_GATEWAY_ACCESS }),
  }));
});

const MOCK_EGRESS_GATEWAY_ACCESS = {
  endpoint: 'host.docker.internal',
  target: { kind: 'runtime' as const, identity: 'mock-default-gateway' },
};

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

  it('exit 78 (EX_CONFIG) stops immediately, with no retry scheduled', async () => {
    // Real fixture, not a mocked exit code: proves kernel-supervisor's own
    // process.on('exit', ...) handler actually observes and reacts to the
    // exit code cmd/nanogo/serve.go's exitCodeForServeErr produces for
    // kernel.ErrSocketPathTooLong — go-host/cmd/nanogo/serve_test.go pins
    // that Go-side value; this pins the TS side consuming it.
    process.env.NANOCLAW_NANOGO_BIN = fixture('fake-nanogo-exit-config-error.sh');
    const { log } = await import('../../log.js');
    const lifecycle = await import('../../host-lifecycle.js');
    await import('./index.js');

    for (const cb of lifecycle.getHostStartCallbacks()) {
      await cb({ db: {} as never, signal: new AbortController().signal });
    }

    // The fixture exits immediately and never opens a socket — give the
    // exit handler a moment to run, then confirm no restart got scheduled.
    // The shortest backoff step is 1s (RESTART_BACKOFF_MS[0]); waiting
    // comfortably past that without a "Scheduling nanogo serve restart"
    // warning is what actually distinguishes "gave up correctly" from
    // "is about to retry, just hasn't yet."
    await new Promise((r) => setTimeout(r, 1_500));

    expect(fs.existsSync(socketPath)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('cannot recover from by retrying'),
      expect.objectContaining({ code: 78 }),
    );
    expect(log.warn).not.toHaveBeenCalledWith('Scheduling nanogo serve restart', expect.anything());

    for (const cb of lifecycle.getHostShutdownCallbacks()) {
      await cb();
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

describe('kernel-supervisor: egress-lockdown network wiring', () => {
  // Regression coverage for the EC-02 gap: once wake moved behind the
  // kernel, drivers/index.ts's dockerNetworkArgs(spec) stopped participating
  // in container creation at all (see docker-driver.ts's own comment on
  // `networkArgsFor`), so NANOCLAW_EGRESS_LOCKDOWN=true stopped attaching
  // any container to the isolated network — the network was still created
  // (host-sweep.ts keeps calling ensureEgressNetwork()), so it looked
  // active while doing nothing. These tests pin the fix: the kernel's own
  // process-wide `-docker-network` flag must reflect the lockdown decision.
  //
  // Most tests below pass DockerNetworkDeps directly to
  // dockerNetworkArgs/buildServeArgs/spawnKernel rather than re-mocking
  // config.js/egress-lockdown.js via vi.doMock + dynamic import per case.
  // The doMock approach was tried first and proved genuinely flaky under
  // vitest with this many sequential per-test overrides of the same two
  // specifiers in one file (reproduced directly: 60-80% failure rates
  // across repeated full-file runs, with wrong values from one test
  // leaking into another) — not a one-off, and not worth chasing further
  // as a test-infrastructure problem when the function itself was easy to
  // make injectable. Only the "falls back to the real wiring" test still
  // needs module mocking, since it specifically tests that fallback.

  afterEach(() => {
    delete process.env.NANOCLAW_KERNEL_DOCKER_NETWORK;
  });

  // A stand-in NetworkAccessIntent — the shape GatewayProviderDefinition
  // .egressGateway() returns (ADR-033), not tied to any real gateway.
  const TEST_ACCESS = { endpoint: 'host.docker.internal', target: { kind: 'runtime' as const, identity: 'test-gw' } };
  const resolveEgressGatewayAccess = () => TEST_ACCESS;

  it('passes -docker-network for the egress network when lockdown is on, and establishes it', async () => {
    const ensureEgressNetwork = vi.fn().mockReturnValue(true);
    const mod = await import('./index.js');
    const args = mod.dockerNetworkArgs({
      egressLockdown: true,
      egressNetwork: 'nanoclaw-egress',
      resolveEgressGatewayAccess,
      ensureEgressNetwork,
    });
    expect(args).toEqual(['-docker-network', 'nanoclaw-egress']);
    expect(ensureEgressNetwork).toHaveBeenCalledTimes(1);
    expect(ensureEgressNetwork).toHaveBeenCalledWith(TEST_ACCESS);
  });

  it('propagates EgressLockdownError (or any establish failure) rather than starting the kernel on open egress', async () => {
    class EgressLockdownError extends Error {}
    const ensureEgressNetwork = vi.fn().mockImplementation(() => {
      throw new EgressLockdownError('gateway container is not running');
    });
    const mod = await import('./index.js');
    expect(() =>
      mod.dockerNetworkArgs({
        egressLockdown: true,
        egressNetwork: 'nanoclaw-egress',
        resolveEgressGatewayAccess,
        ensureEgressNetwork,
      }),
    ).toThrow('gateway container is not running');
  });

  it('refuses to start when lockdown is on but the configured gateway declares no egress attachment', async () => {
    const mod = await import('./index.js');
    const ensureEgressNetwork = vi.fn();
    expect(() =>
      mod.dockerNetworkArgs({
        egressLockdown: true,
        egressNetwork: 'nanoclaw-egress',
        resolveEgressGatewayAccess: () => undefined,
        ensureEgressNetwork,
      }),
    ).toThrow(/declares no egress-lockdown attachment/);
    // Fail-fast: never even asks ensureEgressNetwork to attempt anything.
    expect(ensureEgressNetwork).not.toHaveBeenCalled();
  });

  it('spawnKernel reports failure (not a crash) when buildServeArgs throws', async () => {
    const lifecycle = await import('../../host-lifecycle.js');
    const mod = await import('./index.js');
    const deps = {
      egressLockdown: true,
      egressNetwork: 'nanoclaw-egress',
      resolveEgressGatewayAccess,
      ensureEgressNetwork: vi.fn().mockImplementation(() => {
        throw new Error('gateway unreachable');
      }),
    };
    // nanogoPath is never read on this path: buildServeArgs() throws before
    // spawn() would use it, so a placeholder (not a real fixture script)
    // correctly signals that.
    await expect(mod.spawnKernel('unused-nanogo-path', deps)).resolves.toBe(false);
    // spawnKernel's catch now calls scheduleRestart (see the next test),
    // which arms a real setTimeout — must be cleared via shutdown before
    // this test ends, or it fires ~1s later during a LATER test.
    for (const cb of lifecycle.getHostShutdownCallbacks()) {
      await cb();
    }
  });

  it('re-arms the restart loop when buildServeArgs throws, instead of permanently ending kernel supervision', async () => {
    // Regression test for the bug code review found in this fix's own first
    // draft: the catch in spawnKernel returned false without ever calling
    // spawn(), so proc.on('exit', ...) — the only other place that counts a
    // failure and calls scheduleRestart — never fired, silently ending all
    // retries after one transient failure. Asserted via the state mutation
    // directly (getConsecutiveFailuresForTests): only true if
    // scheduleRestart's own failure-counting path actually ran.
    const lifecycle = await import('../../host-lifecycle.js');
    const mod = await import('./index.js');
    const deps = {
      egressLockdown: true,
      egressNetwork: 'nanoclaw-egress',
      resolveEgressGatewayAccess,
      ensureEgressNetwork: vi.fn().mockImplementation(() => {
        throw new Error('gateway not up yet');
      }),
    };
    const before = mod.getConsecutiveFailuresForTests();
    const result = await mod.spawnKernel('unused-nanogo-path', deps);
    expect(result).toBe(false);
    expect(mod.getConsecutiveFailuresForTests()).toBe(before + 1);
    for (const cb of lifecycle.getHostShutdownCallbacks()) {
      await cb();
    }
  });

  it('refuses a conflicting NANOCLAW_KERNEL_DOCKER_NETWORK rather than silently picking one', async () => {
    process.env.NANOCLAW_KERNEL_DOCKER_NETWORK = 'some-other-network';
    const mod = await import('./index.js');
    expect(() =>
      mod.dockerNetworkArgs({
        egressLockdown: true,
        egressNetwork: 'nanoclaw-egress',
        resolveEgressGatewayAccess,
        ensureEgressNetwork: vi.fn().mockReturnValue(true),
      }),
    ).toThrow(/conflicting network/);
  });

  it('still honors NANOCLAW_KERNEL_DOCKER_NETWORK when lockdown is off (no behavior change for non-lockdown installs)', async () => {
    process.env.NANOCLAW_KERNEL_DOCKER_NETWORK = 'custom-net';
    const ensureEgressNetwork = vi.fn();
    const mod = await import('./index.js');
    const args = mod.dockerNetworkArgs({
      egressLockdown: false,
      egressNetwork: 'nanoclaw-egress',
      resolveEgressGatewayAccess,
      ensureEgressNetwork,
    });
    expect(args).toEqual(['-docker-network', 'custom-net']);
    expect(ensureEgressNetwork).not.toHaveBeenCalled();
  });

  it('passes no -docker-network flag when lockdown is off and no override is set (default bridge, unchanged)', async () => {
    const mod = await import('./index.js');
    const args = mod.dockerNetworkArgs({
      egressLockdown: false,
      egressNetwork: 'nanoclaw-egress',
      resolveEgressGatewayAccess,
      ensureEgressNetwork: vi.fn(),
    });
    expect(args).toEqual([]);
  });

  it('buildServeArgs threads dockerNetworkDeps through to dockerNetworkArgs', async () => {
    const mod = await import('./index.js');
    const args = mod.buildServeArgs({
      egressLockdown: true,
      egressNetwork: 'nanoclaw-egress',
      resolveEgressGatewayAccess,
      ensureEgressNetwork: vi.fn().mockReturnValue(true),
    });
    expect(args).toEqual(expect.arrayContaining(['-docker-network', 'nanoclaw-egress']));
  });

  it('falls back to the real EGRESS_LOCKDOWN/ensureEgressNetwork wiring when no deps are passed', async () => {
    // Verifies defaultDockerNetworkDeps() actually reads config.js/
    // egress-lockdown.js — i.e. that production callers (which never pass
    // deps) are wired to the real thing, not just that the injected-deps
    // logic is correct in isolation (the other tests in this block).
    // Deliberately does NOT call vi.doMock itself — relies solely on the
    // shared beforeEach's own registration for these two specifiers, so
    // there's only ever one doMock per specifier in play for this test.
    // A second, test-local override of the same specifiers (tried first)
    // proved flaky under vitest — reproduced directly, not a one-off — so
    // this checks the wiring by reading back what the shared mock already
    // provides instead.
    const egressLockdown = await import('../../egress-lockdown.js');
    const mod = await import('./index.js');
    const deps = mod.defaultDockerNetworkDeps();
    expect(deps.egressLockdown).toBe(false); // the shared beforeEach's own default
    expect(deps.egressNetwork).toBe('unused-in-this-test');
    expect(deps.ensureEgressNetwork).toBe(egressLockdown.ensureEgressNetwork);
    // resolveEgressGatewayAccess is a new closure, not a re-export, so this
    // checks it behaves like the real wiring (asks getGatewayProvider()) by
    // reading back the shared gateway-providers/index.js mock's own value,
    // rather than asserting reference identity.
    expect(deps.resolveEgressGatewayAccess()).toEqual(MOCK_EGRESS_GATEWAY_ACCESS);
  });
});

/**
 * Coverage for setup/install-cred-helper.ts — installs/uninstalls/inspects
 * `docker-credential-nanoclaw` and wires it into `~/.docker/config.json`.
 *
 * No network or Docker daemon involved: the "run the binary to prove it
 * works" step really does spawn the copied helper script with
 * `process.execPath` (the vitest worker's own node binary) and argv
 * `['version']`, which is a pure local computation in
 * setup/registry/credential-helper.mjs (see HELPER_VERSION / case 'version')
 * — no network, no credentials, safe to let run for real. Every filesystem
 * path (bin dir, docker config file, `~/.config/nanoclaw`) is pointed at a
 * disposable temp directory either via this module's own `options` overrides
 * or by mocking `os.homedir()`.
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

// `readAgentImagePin`'s `versions.json` is resolved relative to this module's
// own file (setup/lib/version-pins.ts: `import.meta.url`-based, NOT
// process.cwd()) — so it always reads the real checked-in
// <worktree>/versions.json regardless of any tmp cwd this test chdir's into.
// Mock the whole collaborator so resolveRegistryHost's candidates are fully
// under test control instead of leaking whatever this checkout happens to be
// pinned to.
const mockRegistryState = vi.hoisted(() => ({
  readAgentImagePin: vi.fn((): string | undefined => undefined),
  registryAuthPath: vi.fn(() => '/nonexistent/registry-auth.json'),
}));
vi.mock('./lib/registry-state.js', () => mockRegistryState);

const origCwd = process.cwd();
let tmpDir: string;
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-helper-test-')));
  homeDir = path.join(tmpDir, 'home');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  process.chdir(projectDir);
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  emitted.length = 0;
  mockRegistryState.readAgentImagePin.mockReset().mockReturnValue(undefined);
  mockRegistryState.registryAuthPath.mockReset().mockReturnValue(path.join(tmpDir, 'no-such-registry-auth.json'));
  // Defensive: never let this run's real shell environment leak a registry
  // host into resolveRegistryHost's env-var fallback candidate.
  vi.stubEnv('NANOCLAW_REGISTRY_HOST', '');
  vi.resetModules();
});

afterEach(() => {
  process.chdir(origCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function binDir(): string {
  const d = path.join(tmpDir, 'bin');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function dockerConfig(): string {
  return path.join(tmpDir, 'docker-config.json');
}

describe('renderHelper', () => {
  it('replaces an existing shebang with the given node path', async () => {
    const { renderHelper } = await import('./install-cred-helper.js');
    const out = renderHelper('#!/usr/bin/env node\nconsole.log(1);\n', '/opt/node/bin/node');
    expect(out).toBe('#!/opt/node/bin/node\nconsole.log(1);\n');
  });

  it('prepends a shebang when the source has none', async () => {
    const { renderHelper } = await import('./install-cred-helper.js');
    const out = renderHelper('console.log(1);\n', '/opt/node/bin/node');
    expect(out).toBe('#!/opt/node/bin/node\nconsole.log(1);\n');
  });
});

describe('dockerConfigPath', () => {
  it('honors an explicit override', async () => {
    const { dockerConfigPath } = await import('./install-cred-helper.js');
    expect(dockerConfigPath('/explicit/config.json')).toBe('/explicit/config.json');
  });

  it('honors DOCKER_CONFIG when set', async () => {
    vi.stubEnv('DOCKER_CONFIG', path.join(tmpDir, 'custom-docker'));
    const { dockerConfigPath } = await import('./install-cred-helper.js');
    expect(dockerConfigPath()).toBe(path.join(tmpDir, 'custom-docker', 'config.json'));
    vi.unstubAllEnvs();
  });

  it('defaults to ~/.docker/config.json', async () => {
    vi.stubEnv('DOCKER_CONFIG', '');
    const { dockerConfigPath } = await import('./install-cred-helper.js');
    expect(dockerConfigPath()).toBe(path.join(homeDir, '.docker', 'config.json'));
    vi.unstubAllEnvs();
  });
});

describe('resolveRegistryHost', () => {
  it('uses the explicit host when given, lowercased', async () => {
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost('Registry.Example.COM')).toBe('registry.example.com');
  });

  it('falls back to the recorded registry from registry-auth.json', async () => {
    const authFile = path.join(homeDir, 'registry-auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ registry: 'recorded.example.com' }));
    mockRegistryState.registryAuthPath.mockReturnValue(authFile);
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost()).toBe('recorded.example.com');
  });

  it('tolerates a missing/corrupt registry-auth.json and falls through', async () => {
    const authFile = path.join(homeDir, 'registry-auth.json');
    fs.writeFileSync(authFile, '{not json');
    mockRegistryState.registryAuthPath.mockReturnValue(authFile);
    vi.stubEnv('NANOCLAW_REGISTRY_HOST', 'env.example.com');
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost()).toBe('env.example.com');
  });

  it('falls back to the registry embedded in a pinned image reference', async () => {
    mockRegistryState.readAgentImagePin.mockReturnValue('registry.pin.example.com/nanoclaw-agent@sha256:aaaa');
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost()).toBe('registry.pin.example.com');
  });

  it('ignores a Docker-Hub-shaped pin (no dot/port/localhost in the first segment)', async () => {
    mockRegistryState.readAgentImagePin.mockReturnValue('library/nginx@sha256:bbbb');
    vi.stubEnv('NANOCLAW_REGISTRY_HOST', 'fallback.example.com');
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost()).toBe('fallback.example.com');
  });

  it('falls back to NANOCLAW_REGISTRY_HOST when nothing else answers', async () => {
    vi.stubEnv('NANOCLAW_REGISTRY_HOST', 'env-only.example.com');
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost()).toBe('env-only.example.com');
  });

  it('throws when nothing names a registry', async () => {
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(() => resolveRegistryHost()).toThrow(/No registry host to wire/);
  });

  it('throws on a hostname carrying a scheme (URL, not a hostname)', async () => {
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(() => resolveRegistryHost('https://registry.example.com')).toThrow(/Not a registry hostname/);
  });

  it('accepts a hostname with a port', async () => {
    const { resolveRegistryHost } = await import('./install-cred-helper.js');
    expect(resolveRegistryHost('localhost:5000')).toBe('localhost:5000');
  });
});

describe('installCredentialHelper', () => {
  it('installs the binary, runs it to verify, and wires the docker config', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const { installCredentialHelper, HELPER_BINARY_NAME } = await import('./install-cred-helper.js');

    const result = installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });

    expect(result.registryHost).toBe('r.example.com');
    expect(result.dockerConfigChanged).toBe(true);
    expect(fs.existsSync(path.join(bin, HELPER_BINARY_NAME))).toBe(true);

    const installed = fs.readFileSync(path.join(bin, HELPER_BINARY_NAME), 'utf-8');
    expect(installed.startsWith(`#!${process.execPath}\n`)).toBe(true);
    expect(installed).toContain('nanoclaw-docker-credential-helper');

    const config = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(config.credHelpers).toEqual({ 'r.example.com': 'nanoclaw' });

    // Re-running with the same host is a no-op on the docker config.
    const second = installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    expect(second.dockerConfigChanged).toBe(false);
  });

  it('preserves unrelated keys and other credHelpers entries already in the config', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        auths: { 'other.example.com': { auth: 'xxx' } },
        credHelpers: { 'existing.example.com': 'someother' },
      }),
    );
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });

    const config = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(config.auths).toEqual({ 'other.example.com': { auth: 'xxx' } });
    expect(config.credHelpers).toEqual({ 'existing.example.com': 'someother', 'r.example.com': 'nanoclaw' });
  });

  it('reports onPath: false and does not throw when the bin dir is not on PATH', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const originalPath = process.env.PATH;
    vi.stubEnv('PATH', '/definitely/not/it');
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    const result = installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    expect(result.onPath).toBe(false);
    vi.stubEnv('PATH', originalPath ?? '');
  });

  it('reports onPath: true when the bin dir is on PATH', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const originalPath = process.env.PATH;
    vi.stubEnv('PATH', `${bin}${path.delimiter}${originalPath ?? ''}`);
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    const result = installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    expect(result.onPath).toBe(true);
    vi.stubEnv('PATH', originalPath ?? '');
  });

  // NOTE: chooseBinDir()'s no-override fallback path (walking the hardcoded
  // BIN_DIRS = ['/usr/local/bin', ~/.local/bin] and mkdir -p'ing the last one)
  // is intentionally NOT exercised here. BIN_DIRS's first entry is the real,
  // absolute, non-overridable system path /usr/local/bin — calling
  // installCredentialHelper() without a `binDir` override actually installs
  // into it for real on whatever machine runs the test (verified the hard
  // way: it wrote a real docker-credential-nanoclaw there during development
  // of this test file, since removed). Every test below always passes an
  // explicit `binDir`, so this fallback branch stays uncovered by design.

  it('aborts before writing the binary when the existing docker config is not valid JSON', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    fs.writeFileSync(cfg, '{not valid json');
    const { installCredentialHelper, HELPER_BINARY_NAME } = await import('./install-cred-helper.js');
    expect(() =>
      installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg }),
    ).toThrow(/is not valid JSON/);
    expect(fs.existsSync(path.join(bin, HELPER_BINARY_NAME))).toBe(false);
  });

  it('rejects a docker config whose credHelpers value is not an object', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    fs.writeFileSync(cfg, JSON.stringify({ credHelpers: 'nope' }));
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    expect(() =>
      installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg }),
    ).toThrow(/credHelpers value that is not an object/);
  });

  it('rejects a docker config that is not a JSON object at all', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    fs.writeFileSync(cfg, JSON.stringify(['array', 'not', 'object']));
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    expect(() =>
      installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg }),
    ).toThrow(/is not a JSON object/);
  });

  it('tolerates a blank (whitespace-only) docker config file as empty', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    fs.writeFileSync(cfg, '   \n');
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    const result = installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    expect(result.dockerConfigChanged).toBe(true);
  });

  it('preserves the existing file mode of the docker config on rewrite', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    fs.writeFileSync(cfg, JSON.stringify({}), { mode: 0o644 });
    const { installCredentialHelper } = await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o644);
  });
});

describe('uninstallCredentialHelper', () => {
  it('removes our binary and our credHelpers entries only', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const { installCredentialHelper, uninstallCredentialHelper, HELPER_BINARY_NAME } =
      await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    // A second host also pointed at us, plus an unrelated helper entry.
    const cfgObj = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    cfgObj.credHelpers['second.example.com'] = 'nanoclaw';
    cfgObj.credHelpers['unrelated.example.com'] = 'someother-helper';
    fs.writeFileSync(cfg, JSON.stringify(cfgObj));

    const removal = uninstallCredentialHelper({ binDir: bin, dockerConfigPath: cfg });
    expect(removal.removedBinaries).toEqual([path.join(bin, HELPER_BINARY_NAME)]);
    expect(removal.removedHosts.sort()).toEqual(['r.example.com', 'second.example.com']);
    expect(removal.dockerConfigChanged).toBe(true);

    const after = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(after.credHelpers).toEqual({ 'unrelated.example.com': 'someother-helper' });
  });

  it('drops the credHelpers key entirely once it is empty', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const { installCredentialHelper, uninstallCredentialHelper } = await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    uninstallCredentialHelper({ binDir: bin, dockerConfigPath: cfg });
    const after = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
    expect(after.credHelpers).toBeUndefined();
  });

  it('leaves a binary alone (kept, not removed) when it is not ours', async () => {
    const bin = binDir();
    const { uninstallCredentialHelper, HELPER_BINARY_NAME } = await import('./install-cred-helper.js');
    const foreign = path.join(bin, HELPER_BINARY_NAME);
    fs.writeFileSync(foreign, '#!/bin/sh\necho not ours\n', { mode: 0o755 });

    const removal = uninstallCredentialHelper({ binDir: bin, dockerConfigPath: dockerConfig() });
    expect(removal.keptBinaries).toEqual([foreign]);
    expect(removal.removedBinaries).toEqual([]);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('is a no-op (not an error) when nothing is installed at all', async () => {
    const { uninstallCredentialHelper } = await import('./install-cred-helper.js');
    const removal = uninstallCredentialHelper({ binDir: binDir(), dockerConfigPath: dockerConfig() });
    expect(removal.removedBinaries).toEqual([]);
    expect(removal.removedHosts).toEqual([]);
    expect(removal.dockerConfigChanged).toBe(false);
  });

  it('leaves the docker config alone (warns) when it is unparsable, but still removes our binary', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const { installCredentialHelper, uninstallCredentialHelper, HELPER_BINARY_NAME } =
      await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    fs.writeFileSync(cfg, '{corrupt');

    const removal = uninstallCredentialHelper({ binDir: bin, dockerConfigPath: cfg });
    expect(removal.removedBinaries).toEqual([path.join(bin, HELPER_BINARY_NAME)]);
    expect(removal.dockerConfigChanged).toBe(false);
    expect(fs.readFileSync(cfg, 'utf-8')).toBe('{corrupt');
  });
});

describe('credentialHelperStatus', () => {
  it('reports not-installed with no wired hosts on a clean machine', async () => {
    const { credentialHelperStatus } = await import('./install-cred-helper.js');
    const status = credentialHelperStatus({ binDir: binDir(), dockerConfigPath: dockerConfig() });
    expect(status.installed).toBe(false);
    expect(status.helperPath).toBeUndefined();
    expect(status.wiredHosts).toEqual([]);
  });

  it('reports installed + wired hosts after a real install', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const { installCredentialHelper, credentialHelperStatus, HELPER_BINARY_NAME } =
      await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });
    const status = credentialHelperStatus({ binDir: bin, dockerConfigPath: cfg });
    expect(status.installed).toBe(true);
    expect(status.helperPath).toBe(path.join(bin, HELPER_BINARY_NAME));
    expect(status.wiredHosts).toEqual(['r.example.com']);
  });

  it('warns and returns no wired hosts when the docker config cannot be read', async () => {
    const cfg = dockerConfig();
    fs.writeFileSync(cfg, '{corrupt');
    const { credentialHelperStatus } = await import('./install-cred-helper.js');
    const status = credentialHelperStatus({ binDir: binDir(), dockerConfigPath: cfg });
    expect(status.wiredHosts).toEqual([]);
  });
});

describe('run() — CLI surface', () => {
  it('--status emits INSTALLED false with (none) hosts on a clean machine', async () => {
    const cfg = dockerConfig();
    const { run } = await import('./install-cred-helper.js');
    await run(['--status', '--bin-dir', binDir(), '--docker-config', cfg]);
    expect(emitted.at(-1)).toMatchObject({ step: 'CRED_HELPER', INSTALLED: false, HOSTS: '(none)', STATUS: 'success' });
  });

  it('installs (default mode) and reports HINT when the bin dir is not on PATH', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    vi.stubEnv('PATH', '/definitely/not/it');
    const { run } = await import('./install-cred-helper.js');
    await run(['--registry-host', 'r.example.com', '--bin-dir', bin, '--docker-config', cfg]);
    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ STATUS: 'success', HOST: 'r.example.com', ON_PATH: false });
    expect(status.HINT).toContain('Add');
    vi.unstubAllEnvs();
  });

  it('install mode omits HINT when the bin dir is already on PATH', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const originalPath = process.env.PATH;
    vi.stubEnv('PATH', `${bin}${path.delimiter}${originalPath ?? ''}`);
    const { run } = await import('./install-cred-helper.js');
    await run(['--registry-host', 'r.example.com', '--bin-dir', bin, '--docker-config', cfg]);
    const status = emitted.at(-1)!;
    expect(status.HINT).toBeUndefined();
    vi.stubEnv('PATH', originalPath ?? '');
  });

  it('--uninstall reports removed binaries/hosts and CONFIG_EDITED', async () => {
    const bin = binDir();
    const cfg = dockerConfig();
    const { installCredentialHelper, run } = await import('./install-cred-helper.js');
    installCredentialHelper({ registryHost: 'r.example.com', binDir: bin, dockerConfigPath: cfg });

    await run(['--uninstall', '--bin-dir', bin, '--docker-config', cfg]);
    const status = emitted.at(-1)!;
    expect(status).toMatchObject({ STATUS: 'success', HOSTS: 'r.example.com', CONFIG_EDITED: true });
    expect(String(status.REMOVED)).toContain('docker-credential-nanoclaw');
  });

  it('--uninstall reports (none) and CONFIG_EDITED false when nothing was installed', async () => {
    const { run } = await import('./install-cred-helper.js');
    await run(['--uninstall', '--bin-dir', binDir(), '--docker-config', dockerConfig()]);
    expect(emitted.at(-1)).toMatchObject({ REMOVED: '(none)', HOSTS: '(none)', CONFIG_EDITED: false });
  });

  it('--uninstall reports KEPT for a foreign binary at the same path', async () => {
    const bin = binDir();
    const { run } = await import('./install-cred-helper.js');
    const foreignPath = path.join(bin, 'docker-credential-nanoclaw');
    fs.writeFileSync(foreignPath, '#!/bin/sh\n', { mode: 0o755 });
    await run(['--uninstall', '--bin-dir', bin, '--docker-config', dockerConfig()]);
    expect(String(emitted.at(-1)!.KEPT)).toContain(foreignPath);
  });
});

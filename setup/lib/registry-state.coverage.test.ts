/**
 * Coverage for registry-state.ts beyond the sibling registry-state.test.ts
 * (which only covers resolvePinForPlatform/pinnedPlatforms + the pull.sh
 * cross-check). readEnvFile/upsertEnvVar/removeEnvVar are exercised for
 * real against a temp cwd (they're pure relative-.env readers/writers, no
 * network or Docker) rather than mocked, matching this module's own point
 * that they're the single place the key is parsed. child_process, the
 * version-pins reader and the container-image-name resolver are mocked so
 * no real docker/versions.json dependency leaks in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  pinValue: undefined as unknown,
  pinThrows: false,
  containerImage: 'nanoclaw-agent-v2-test:latest',
}));

vi.mock('child_process', () => ({ spawnSync: h.spawnSync }));
vi.mock('./version-pins.js', () => ({
  readVersionPinValue: (component: string) => {
    if (h.pinThrows) throw new Error(`no pin for ${component}`);
    return h.pinValue;
  },
}));
vi.mock('../../src/install-slug.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/install-slug.js')>();
  return { ...actual, getDefaultContainerImage: () => h.containerImage };
});

const originalCwd = process.cwd();
const originalHome = process.env.HOME;
let projectRoot: string;
let homeDir: string;

beforeEach(async () => {
  vi.resetModules();
  h.spawnSync.mockReset();
  h.pinValue = undefined;
  h.pinThrows = false;
  h.containerImage = 'nanoclaw-agent-v2-test:latest';
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-state-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-state-home-'));
  process.chdir(projectRoot);
  process.env.HOME = homeDir;
  delete process.env.NANOCLAW_HARDENED_IMAGE;
  delete process.env.NANOCLAW_AGENT_IMAGE_REF;
  delete process.env.NANOCLAW_REGISTRY_API;
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

async function mod(): Promise<typeof import('./registry-state.js')> {
  return import('./registry-state.js');
}

describe('image source (.env NANOCLAW_HARDENED_IMAGE)', () => {
  it('defaults to local + undecided with no .env and no env var', async () => {
    const { readImageSource, imageSourceDecided } = await mod();
    expect(readImageSource()).toBe('local');
    expect(imageSourceDecided()).toBe(false);
  });

  it('writeImageSource("hardened") persists "true" and flips both readers', async () => {
    const { readImageSource, imageSourceDecided, writeImageSource } = await mod();
    writeImageSource('hardened');
    expect(readImageSource()).toBe('hardened');
    expect(imageSourceDecided()).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8')).toContain('NANOCLAW_HARDENED_IMAGE=true');
  });

  it('writeImageSource("local") writes an explicit "false" — decided, but still local', async () => {
    const { readImageSource, imageSourceDecided, writeImageSource } = await mod();
    writeImageSource('local');
    expect(readImageSource()).toBe('local');
    expect(imageSourceDecided()).toBe(true); // explicit "no", distinct from never-asked
  });

  it('clearImageSource puts the question back (undecided again)', async () => {
    const { imageSourceDecided, writeImageSource, clearImageSource } = await mod();
    writeImageSource('hardened');
    expect(imageSourceDecided()).toBe(true);
    clearImageSource();
    expect(imageSourceDecided()).toBe(false);
  });

  it('trims + lowercases whatever is on disk', async () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'NANOCLAW_HARDENED_IMAGE=TRUE \n');
    const { readImageSource } = await mod();
    expect(readImageSource()).toBe('hardened');
  });

  it('process.env wins over .env', async () => {
    fs.writeFileSync(path.join(projectRoot, '.env'), 'NANOCLAW_HARDENED_IMAGE=true\n');
    process.env.NANOCLAW_HARDENED_IMAGE = 'false';
    const { readImageSource } = await mod();
    expect(readImageSource()).toBe('local');
  });
});

describe('readAgentImagePin', () => {
  it('env override wins outright, pin never consulted', async () => {
    process.env.NANOCLAW_AGENT_IMAGE_REF = 'registry.example.com/repo@sha256:override';
    h.pinValue = 'should-not-be-used';
    const { readAgentImagePin } = await mod();
    expect(readAgentImagePin()).toBe('registry.example.com/repo@sha256:override');
  });

  it('falls through to the pin when the env override is blank', async () => {
    process.env.NANOCLAW_AGENT_IMAGE_REF = '   ';
    h.pinValue = 'repo@sha256:fromversions';
    const { readAgentImagePin } = await mod();
    expect(readAgentImagePin()).toBe('repo@sha256:fromversions');
  });

  it('a string pin is trimmed; an all-whitespace pin reads as unpinned', async () => {
    h.pinValue = '  repo@sha256:padded  ';
    const { readAgentImagePin: p1 } = await mod();
    expect(p1()).toBe('repo@sha256:padded');
    vi.resetModules();
    h.pinValue = '   ';
    const { readAgentImagePin: p2 } = await mod();
    expect(p2()).toBeUndefined();
  });

  it('an object pin resolves via the docker daemon platform', async () => {
    h.pinValue = { 'linux/arm64': 'repo@sha256:arm', 'linux/amd64': 'repo@sha256:amd' };
    h.spawnSync.mockReturnValue({ status: 0, stdout: 'arm64\n' });
    const { readAgentImagePin } = await mod();
    expect(readAgentImagePin()).toBe('repo@sha256:arm');
  });

  it('a readVersionPinValue throw (no pin at all) is swallowed to undefined', async () => {
    h.pinThrows = true;
    const { readAgentImagePin } = await mod();
    expect(readAgentImagePin()).toBeUndefined();
  });
});

describe('unsupportedPlatformPin', () => {
  it('undefined when unpinned (no platforms declared)', async () => {
    h.pinValue = 'repo@sha256:single';
    const { unsupportedPlatformPin } = await mod();
    expect(unsupportedPlatformPin()).toBeUndefined();
  });

  it('undefined when the current platform is covered', async () => {
    h.pinValue = { 'linux/amd64': 'repo@sha256:amd' };
    h.spawnSync.mockReturnValue({ status: 0, stdout: 'amd64\n' });
    const { unsupportedPlatformPin } = await mod();
    expect(unsupportedPlatformPin()).toBeUndefined();
  });

  it('reports platform + available list when the pin exists but not for this machine', async () => {
    h.pinValue = { 'linux/arm64': 'repo@sha256:arm' };
    h.spawnSync.mockReturnValue({ status: 0, stdout: 'amd64\n' });
    const { unsupportedPlatformPin } = await mod();
    expect(unsupportedPlatformPin()).toEqual({ platform: 'linux/amd64', available: ['linux/arm64'] });
  });

  it('undefined when readVersionPinValue throws', async () => {
    h.pinThrows = true;
    const { unsupportedPlatformPin } = await mod();
    expect(unsupportedPlatformPin()).toBeUndefined();
  });
});

describe('dockerPlatform', () => {
  it('reads the daemon arch and caches it (spawnSync called once across two calls)', async () => {
    h.spawnSync.mockReturnValue({ status: 0, stdout: 'arm64\n' });
    const { dockerPlatform } = await mod();
    expect(dockerPlatform()).toBe('linux/arm64');
    expect(dockerPlatform()).toBe('linux/arm64');
    expect(h.spawnSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to the node arch (x64 -> amd64) when the daemon call fails', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    const { dockerPlatform } = await mod();
    const expected = process.arch === 'x64' ? 'amd64' : process.arch;
    expect(dockerPlatform()).toBe(`linux/${expected}`);
  });

  it('maps node\'s "x64" arch name to docker\'s "amd64"', async () => {
    const origArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
    try {
      h.spawnSync.mockReturnValue({ status: 1, stdout: '' });
      const { dockerPlatform } = await mod();
      expect(dockerPlatform()).toBe('linux/amd64');
    } finally {
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    }
  });

  it('passes other arch names through unchanged', async () => {
    const origArch = process.arch;
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
    try {
      h.spawnSync.mockReturnValue({ status: 1, stdout: '' });
      const { dockerPlatform } = await mod();
      expect(dockerPlatform()).toBe('linux/arm64');
    } finally {
      Object.defineProperty(process, 'arch', { value: origArch, configurable: true });
    }
  });
});

describe('readAgentImageDigest / readRegistryHost', () => {
  it('undefined for both when unpinned', async () => {
    const { readAgentImageDigest, readRegistryHost } = await mod();
    expect(readAgentImageDigest()).toBeUndefined();
    expect(readRegistryHost()).toBeUndefined();
  });

  it('splits the digest off a repo@sha256 ref', async () => {
    h.pinValue = 'registry.example.com/repo@sha256:deadbeef';
    const { readAgentImageDigest } = await mod();
    expect(readAgentImageDigest()).toBe('sha256:deadbeef');
  });

  it('undefined for a bare tag ref with no "@" at all', async () => {
    h.pinValue = 'registry.example.com/repo:latest';
    const { readAgentImageDigest } = await mod();
    expect(readAgentImageDigest()).toBeUndefined();
  });

  it('recognizes a dotted host as a registry host', async () => {
    h.pinValue = 'registry.example.com/repo@sha256:deadbeef';
    const { readRegistryHost } = await mod();
    expect(readRegistryHost()).toBe('registry.example.com');
  });

  it('recognizes localhost:port as a registry host', async () => {
    h.pinValue = 'localhost:5000/repo@sha256:deadbeef';
    const { readRegistryHost } = await mod();
    expect(readRegistryHost()).toBe('localhost:5000');
  });

  it('a bare Docker Hub namespace (no dot/colon/localhost) is not a registry host', async () => {
    h.pinValue = 'myorg/repo@sha256:deadbeef';
    const { readRegistryHost } = await mod();
    expect(readRegistryHost()).toBeUndefined();
  });

  it('a ref with no "/" at all has no registry host', async () => {
    h.pinValue = 'repo@sha256:deadbeef';
    const { readRegistryHost } = await mod();
    expect(readRegistryHost()).toBeUndefined();
  });
});

describe('inspectAgentImage', () => {
  it('reports "unknown" when spawnSync itself errors (docker not runnable)', async () => {
    h.spawnSync.mockReturnValue({ error: new Error('ENOENT'), status: null, stdout: '' });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj')).toEqual({ ref: h.containerImage, labels: {}, source: 'unknown' });
  });

  it('reports "missing" on a non-zero exit (no such image)', async () => {
    h.spawnSync.mockReturnValue({ status: 1, stdout: '' });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').source).toBe('missing');
  });

  it('reports "unknown" when docker answers with unparseable JSON', async () => {
    h.spawnSync.mockReturnValue({ status: 0, stdout: 'not json' });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').source).toBe('unknown');
  });

  it('reports "unknown" when docker answers with an empty array', async () => {
    h.spawnSync.mockReturnValue({ status: 0, stdout: '[]' });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').source).toBe('unknown');
  });

  it('reports "unknown" when docker answers with valid JSON that is not an array', async () => {
    h.spawnSync.mockReturnValue({ status: 0, stdout: '{"Id":"sha256:img"}' });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').source).toBe('unknown');
  });

  it('local build: no label, no RepoDigests -> source local, empty labels', async () => {
    h.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ Id: 'sha256:img', Config: { Labels: null } }]),
    });
    const { inspectAgentImage } = await mod();
    const result = inspectAgentImage('/proj');
    expect(result).toEqual({
      ref: h.containerImage,
      id: 'sha256:img',
      registryDigest: undefined,
      labels: {},
      source: 'local',
    });
  });

  it('an explicit dev.nanoclaw.image-source label wins outright', async () => {
    h.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ Id: 'sha256:img', Config: { Labels: { 'dev.nanoclaw.image-source': 'derived' } } }]),
    });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').source).toBe('derived');
  });

  it('a hardened label wins even without any RepoDigests', async () => {
    h.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([{ Id: 'sha256:img', Config: { Labels: { 'dev.nanoclaw.image-source': 'hardened' } } }]),
    });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').source).toBe('hardened');
  });

  it('no label: prefers the RepoDigest matching the pinned repo over [0]', async () => {
    process.env.NANOCLAW_AGENT_IMAGE_REF = 'registry.example.com/repo@sha256:pinned';
    h.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        {
          Id: 'sha256:img',
          Config: { Labels: {} },
          RepoDigests: ['other.example.com/repo@sha256:wrong', 'registry.example.com/repo@sha256:pinned'],
        },
      ]),
    });
    const { inspectAgentImage } = await mod();
    const result = inspectAgentImage('/proj');
    expect(result.registryDigest).toBe('sha256:pinned');
    expect(result.source).toBe('hardened'); // registryDigest present, no label -> hardened
  });

  it('no label, no pin match: falls back to the first RepoDigest', async () => {
    h.spawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        { Id: 'sha256:img', Config: { Labels: {} }, RepoDigests: ['registry.example.com/repo@sha256:first'] },
      ]),
    });
    const { inspectAgentImage } = await mod();
    expect(inspectAgentImage('/proj').registryDigest).toBe('sha256:first');
  });
});

describe('loginScriptAvailable', () => {
  it('true when setup/registry-login.sh exists under the given project root', async () => {
    fs.mkdirSync(path.join(projectRoot, 'setup'));
    fs.writeFileSync(path.join(projectRoot, 'setup/registry-login.sh'), '#!/bin/bash\n');
    const { loginScriptAvailable } = await mod();
    expect(loginScriptAvailable(projectRoot)).toBe(true);
  });

  it('false when it does not exist', async () => {
    const { loginScriptAvailable } = await mod();
    expect(loginScriptAvailable(projectRoot)).toBe(false);
  });
});

describe('registryAccountPath / registryAuthPath', () => {
  it('live under ~/.config/nanoclaw', async () => {
    const { registryAccountPath, registryAuthPath } = await mod();
    expect(registryAccountPath()).toBe(path.join(homeDir, '.config', 'nanoclaw', 'account.json'));
    expect(registryAuthPath()).toBe(path.join(homeDir, '.config', 'nanoclaw', 'registry-auth.json'));
  });
});

describe('readRegistryAccount', () => {
  it('undefined when the file does not exist', async () => {
    const { readRegistryAccount } = await mod();
    expect(readRegistryAccount()).toBeUndefined();
  });

  it('undefined when the file is malformed JSON', async () => {
    const { registryAccountPath } = await mod();
    fs.mkdirSync(path.dirname(registryAccountPath()), { recursive: true });
    fs.writeFileSync(registryAccountPath(), '{not json');
    const { readRegistryAccount } = await mod();
    expect(readRegistryAccount()).toBeUndefined();
  });

  it('undefined when the parsed value is not an object (or is null)', async () => {
    const { registryAccountPath } = await mod();
    fs.mkdirSync(path.dirname(registryAccountPath()), { recursive: true });
    fs.writeFileSync(registryAccountPath(), '42');
    let { readRegistryAccount } = await mod();
    expect(readRegistryAccount()).toBeUndefined();
    fs.writeFileSync(registryAccountPath(), 'null');
    vi.resetModules();
    ({ readRegistryAccount } = await mod());
    expect(readRegistryAccount()).toBeUndefined();
  });

  it('undefined when the token is missing or empty', async () => {
    const { registryAccountPath } = await mod();
    fs.mkdirSync(path.dirname(registryAccountPath()), { recursive: true });
    fs.writeFileSync(registryAccountPath(), JSON.stringify({ token: '' }));
    const { readRegistryAccount } = await mod();
    expect(readRegistryAccount()).toBeUndefined();
  });

  it('returns the parsed account when a non-empty token is present', async () => {
    const { registryAccountPath } = await mod();
    fs.mkdirSync(path.dirname(registryAccountPath()), { recursive: true });
    const account = { token: 'tok-123', api: 'https://broker.example', account_id: 'acct1' };
    fs.writeFileSync(registryAccountPath(), JSON.stringify(account));
    const { readRegistryAccount } = await mod();
    expect(readRegistryAccount()).toEqual(account);
  });
});

describe('clearRegistryAccount', () => {
  it('removes both files and reports which existed; no-op when neither does', async () => {
    const { registryAccountPath, registryAuthPath, clearRegistryAccount } = await mod();
    expect(clearRegistryAccount()).toEqual([]);
    fs.mkdirSync(path.dirname(registryAccountPath()), { recursive: true });
    fs.writeFileSync(registryAccountPath(), '{}');
    fs.writeFileSync(registryAuthPath(), '{}');
    const removed = clearRegistryAccount();
    expect(removed.sort()).toEqual([registryAccountPath(), registryAuthPath()].sort());
    expect(fs.existsSync(registryAccountPath())).toBe(false);
    expect(fs.existsSync(registryAuthPath())).toBe(false);
  });
});

describe('readBrokerUrl', () => {
  it('defaults to DEFAULT_BROKER_URL with no override and no account', async () => {
    const { readBrokerUrl, DEFAULT_BROKER_URL } = await mod();
    expect(readBrokerUrl()).toBe(DEFAULT_BROKER_URL);
  });

  it("uses the account's own broker when there is no override", async () => {
    const { readBrokerUrl } = await mod();
    expect(readBrokerUrl({ token: 't', api: 'https://acct-broker.example/' })).toBe('https://acct-broker.example');
  });

  it('an env override wins over the account broker', async () => {
    process.env.NANOCLAW_REGISTRY_API = 'https://override.example//';
    const { readBrokerUrl } = await mod();
    expect(readBrokerUrl({ token: 't', api: 'https://acct-broker.example' })).toBe('https://override.example');
  });

  it('strips trailing slashes', async () => {
    const { readBrokerUrl, DEFAULT_BROKER_URL } = await mod();
    expect(readBrokerUrl({ token: 't', api: 'https://acct-broker.example///' })).toBe('https://acct-broker.example');
    expect(readBrokerUrl()).toBe(DEFAULT_BROKER_URL);
  });
});

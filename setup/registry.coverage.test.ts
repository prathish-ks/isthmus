/**
 * Coverage for setup/registry.ts — the `registry` step that reports on,
 * refreshes, opts out of, or logs out of the pulled-image path.
 *
 * Every collaborator is mocked at the module boundary: `./lib/registry-state.js`
 * (all the actual file/docker reads), `./install-cred-helper.js`
 * (credentialHelperStatus/uninstallCredentialHelper), `./registry-reconcile.js`
 * (lazily imported only on the refresh path), `child_process` (the
 * `container/pull.sh` spawn), and the global `fetch` (the broker revoke
 * call). `process.exit` is trapped as a thrown sentinel, matching the
 * convention used elsewhere in this bundle. `console.log` is captured so the
 * human-readable `say()` lines can be asserted alongside the machine-readable
 * `emitStatus` block.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown> & { step: string }>);
vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    emitted.push({ step, ...fields });
  }),
}));

type RegistryAccount = {
  token: string;
  api?: string;
  account_id?: string;
  email?: string;
  entitlements?: string[];
};
type AgentImageInspection = {
  ref: string;
  id?: string;
  registryDigest?: string;
  labels: Record<string, string>;
  source: 'local' | 'hardened' | 'derived' | 'missing' | 'unknown';
};

const mockState = vi.hoisted(() => ({
  readImageSource: vi.fn((): 'local' | 'hardened' => 'local'),
  writeImageSource: vi.fn(),
  readAgentImagePin: vi.fn((): string | undefined => undefined),
  unsupportedPlatformPin: vi.fn((): { platform: string; available: string[] } | undefined => undefined),
  readAgentImageDigest: vi.fn((): string | undefined => undefined),
  inspectAgentImage: vi.fn(
    (): AgentImageInspection => ({ ref: 'nanoclaw-agent-v2-abc:latest', labels: {}, source: 'missing' }),
  ),
  readRegistryAccount: vi.fn((): RegistryAccount | undefined => undefined),
  readBrokerUrl: vi.fn((_account?: RegistryAccount) => 'https://registry.nanoclaw.dev'),
  readRegistryHost: vi.fn((): string | undefined => undefined),
  clearRegistryAccount: vi.fn((): string[] => []),
  AGENT_IMAGE_PIN: 'agent-image',
  AGENT_IMAGE_REF_ENV_KEY: 'NANOCLAW_AGENT_IMAGE_REF',
  HARDENED_IMAGE_ENV_KEY: 'NANOCLAW_HARDENED_IMAGE',
}));
vi.mock('./lib/registry-state.js', () => mockState);

const mockCredHelper = vi.hoisted(() => ({
  credentialHelperStatus: vi.fn(() => ({ installed: false, wiredHosts: [] as string[], dockerConfigPath: '/x' })),
  uninstallCredentialHelper: vi.fn(() => ({
    removedBinaries: [] as string[],
    keptBinaries: [] as string[],
    removedHosts: [] as string[],
    dockerConfigPath: '/x',
    dockerConfigChanged: false,
  })),
}));
vi.mock('./install-cred-helper.js', () => mockCredHelper);

const mockReconcile = vi.hoisted(() => ({
  reconcileDerivedImages: vi.fn(async () => ({ cleared: [], removed: [], foreign: [] })),
}));
vi.mock('./registry-reconcile.js', () => mockReconcile);

const spawnState = vi.hoisted(() => ({
  pullStatus: 0 as number | null,
}));
vi.mock('child_process', () => ({
  spawnSync: vi.fn(() => ({ status: spawnState.pullStatus, stdout: '', stderr: '' })),
}));

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}
const origExit = process.exit;

let logLines: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  emitted.length = 0;
  logLines = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logLines.push(String(line ?? ''));
  });

  mockState.readImageSource.mockReset().mockReturnValue('local');
  mockState.writeImageSource.mockReset();
  mockState.readAgentImagePin.mockReset().mockReturnValue(undefined);
  mockState.unsupportedPlatformPin.mockReset().mockReturnValue(undefined);
  mockState.readAgentImageDigest.mockReset().mockReturnValue(undefined);
  mockState.inspectAgentImage
    .mockReset()
    .mockReturnValue({ ref: 'nanoclaw-agent-v2-abc:latest', labels: {}, source: 'missing' });
  mockState.readRegistryAccount.mockReset().mockReturnValue(undefined);
  mockState.readBrokerUrl.mockReset().mockReturnValue('https://registry.nanoclaw.dev');
  mockState.readRegistryHost.mockReset().mockReturnValue(undefined);
  mockState.clearRegistryAccount.mockReset().mockReturnValue([]);

  mockCredHelper.credentialHelperStatus.mockReset().mockReturnValue({
    installed: false,
    wiredHosts: [],
    dockerConfigPath: '/x',
  });
  mockCredHelper.uninstallCredentialHelper.mockReset().mockReturnValue({
    removedBinaries: [],
    keptBinaries: [],
    removedHosts: [],
    dockerConfigPath: '/x',
    dockerConfigChanged: false,
  });

  mockReconcile.reconcileDerivedImages.mockReset().mockResolvedValue({ cleared: [], removed: [], foreign: [] });
  spawnState.pullStatus = 0;
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  logSpy.mockRestore();
  vi.unstubAllGlobals();
});

async function runRegistry(args: string[]): Promise<{ exits: number[] }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  const { run } = await import('./registry.js');
  try {
    await run(args);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return { exits };
}

describe('registry — argument parsing', () => {
  it('rejects an unknown flag', async () => {
    const { run } = await import('./registry.js');
    await expect(run(['--bogus'])).rejects.toThrow(/Unknown flag: --bogus/);
  });

  it('rejects combining two different mode flags', async () => {
    const { run } = await import('./registry.js');
    await expect(run(['--refresh', '--opt-out'])).rejects.toThrow(/Pick one action/);
  });

  it('allows repeating the same mode flag', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    const { exits } = await runRegistry(['--refresh', '--refresh']);
    // Reaches the refresh handler (not a parse error) — proven by MODE below.
    expect(emitted.at(-1)).toMatchObject({ MODE: 'refresh' });
    expect(exits).toEqual([]);
  });

  it('defaults to status mode with no flags', async () => {
    await runRegistry([]);
    expect(emitted.at(-1)).toMatchObject({ MODE: 'status' });
  });

  it('--non-interactive silences the prose but not the status block', async () => {
    await runRegistry(['--status', '--non-interactive']);
    expect(logLines).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ MODE: 'status', STATUS: 'success' });
  });
});

describe('registry — status', () => {
  it('reports "not signed in" with no pin and no wrong-platform pin: points at build.sh', async () => {
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('Not signed in');
    expect(logLines.join('\n')).toContain('no agent-image pin in versions.json');
    expect(emitted.at(-1)).toMatchObject({ ACCOUNT: 'none', STATUS: 'success' });
  });

  it('omits the "no pin" note when a pin exists', async () => {
    mockState.readAgentImagePin.mockReturnValue('registry.example.com/img@sha256:aaa');
    await runRegistry(['--status']);
    expect(logLines.join('\n')).not.toContain('nothing for it to fetch');
    expect(emitted.at(-1)).toMatchObject({ IMAGE_REF: 'registry.example.com/img@sha256:aaa' });
  });

  it('omits the "no pin" note when there is a wrong-platform pin', async () => {
    mockState.unsupportedPlatformPin.mockReturnValue({ platform: 'linux/arm64', available: ['linux/amd64'] });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).not.toContain('nothing for it to fetch');
    expect(logLines.join('\n')).toContain('no reference for linux/arm64');
    expect(logLines.join('\n')).toContain('it pins: linux/amd64');
  });

  it('signed in but still building locally: points at --force or the env var', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 't', email: 'a@b.com' });
    mockState.readImageSource.mockReturnValue('local');
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('still set to build its own image');
    expect(emitted.at(-1)).toMatchObject({ ACCOUNT: 'a@b.com' });
  });

  it('signed in + hardened but helper not installed: points at --force', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 't', account_id: 'acct_1' });
    mockState.readImageSource.mockReturnValue('hardened');
    mockCredHelper.credentialHelperStatus.mockReturnValue({ installed: false, wiredHosts: [], dockerConfigPath: '/x' });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('docker has no credential helper');
    expect(emitted.at(-1)).toMatchObject({ ACCOUNT: 'acct_1', CRED_HELPER: false });
  });

  it('signed in + hardened + helper installed and wired: no extra guidance line, shows Perks', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 't', email: 'a@b.com', entitlements: ['perk1', 'perk2'] });
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.readRegistryHost.mockReturnValue('reg.example.com');
    mockCredHelper.credentialHelperStatus.mockReturnValue({
      installed: true,
      wiredHosts: ['reg.example.com'],
      dockerConfigPath: '/x',
    });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).not.toContain('docker has no credential helper');
    expect(logLines.join('\n')).not.toContain('still set to build');
    expect(logLines.join('\n')).toContain('Perks');
    expect(logLines.join('\n')).toContain('perk1, perk2');
  });

  it('reports pin mismatch (PIN_MATCH false) with a --refresh hint', async () => {
    mockState.readAgentImageDigest.mockReturnValue('sha256:aaa');
    mockState.inspectAgentImage.mockReturnValue({
      ref: 'x:latest',
      labels: {},
      source: 'derived',
      registryDigest: 'sha256:bbb',
    });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('run --refresh');
    expect(emitted.at(-1)).toMatchObject({ PIN_MATCH: 'false' });
  });

  it('reports pin match true when digests agree', async () => {
    mockState.readAgentImageDigest.mockReturnValue('sha256:aaa');
    mockState.inspectAgentImage.mockReturnValue({
      ref: 'x:latest',
      labels: {},
      source: 'hardened',
      registryDigest: 'sha256:aaa',
    });
    await runRegistry(['--status']);
    expect(emitted.at(-1)).toMatchObject({ PIN_MATCH: 'true' });
  });

  it('reports pin match "unknown" when either side is missing', async () => {
    // No pinned digest, no local registryDigest -> unknown.
    await runRegistry(['--status']);
    expect(emitted.at(-1)).toMatchObject({ PIN_MATCH: 'unknown' });
  });

  it('hardened + no pin (and no wrong-platform pin): points at the env var / versions.json', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('nothing says which image');
    expect(logLines.join('\n')).toContain('NANOCLAW_AGENT_IMAGE_REF');
  });

  it('hardened + pinned host + helper not wired to it: warns about unauthenticated pulls', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.readAgentImagePin.mockReturnValue('reg.example.com/img@sha256:aaa');
    mockState.readRegistryHost.mockReturnValue('reg.example.com');
    mockCredHelper.credentialHelperStatus.mockReturnValue({ installed: true, wiredHosts: [], dockerConfigPath: '/x' });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('Nothing supplies docker with credentials for reg.example.com');
  });

  it('hardened + pinned host + helper installed and wired to it: no warning', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.readAgentImagePin.mockReturnValue('reg.example.com/img@sha256:aaa');
    mockState.readRegistryHost.mockReturnValue('reg.example.com');
    mockCredHelper.credentialHelperStatus.mockReturnValue({
      installed: true,
      wiredHosts: ['reg.example.com'],
      dockerConfigPath: '/x',
    });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).not.toContain('Nothing supplies docker with credentials');
  });

  it('labels the account by account_id when there is no email', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 't', account_id: 'acct_only' });
    await runRegistry(['--status']);
    expect(emitted.at(-1)).toMatchObject({ ACCOUNT: 'acct_only' });
  });

  it('labels the account "signed-in" when neither email nor account_id is present', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 't' });
    await runRegistry(['--status']);
    expect(emitted.at(-1)).toMatchObject({ ACCOUNT: 'signed-in' });
  });

  it('helperLabel: installed with no wired hosts reads "installed, wired to nothing"', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 't', email: 'a@b.com' });
    mockState.readImageSource.mockReturnValue('hardened');
    mockCredHelper.credentialHelperStatus.mockReturnValue({ installed: true, wiredHosts: [], dockerConfigPath: '/x' });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('installed, wired to nothing');
  });

  it('helperLabel: not installed but a stale host is wired reads "... but the helper binary is missing"', async () => {
    mockCredHelper.credentialHelperStatus.mockReturnValue({
      installed: false,
      wiredHosts: ['stale.example.com'],
      dockerConfigPath: '/x',
    });
    await runRegistry(['--status']);
    expect(logLines.join('\n')).toContain('stale.example.com — but the helper binary is missing');
  });
});

describe('registry — refresh', () => {
  it('refuses (and exits 1) when the install is not set to pull (source !== hardened)', async () => {
    mockState.readImageSource.mockReturnValue('local');
    const { exits } = await runRegistry(['--refresh']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ MODE: 'refresh', STATUS: 'failed', ERROR: 'not_hardened' });
    expect(logLines.join('\n')).toContain('builds its agent image here');
  });

  it('pulls, reconciles, and reports CHANGED when the digest moved', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.readAgentImagePin.mockReturnValue('reg.example.com/img@sha256:new');
    mockState.inspectAgentImage
      .mockReturnValueOnce({ ref: 'x:latest', labels: {}, source: 'hardened', registryDigest: 'sha256:old' })
      .mockReturnValueOnce({ ref: 'x:latest', labels: {}, source: 'hardened', registryDigest: 'sha256:new' });
    mockReconcile.reconcileDerivedImages.mockResolvedValue({ cleared: ['ag-1'], removed: [], foreign: [] });

    const { exits } = await runRegistry(['--refresh']);
    expect(exits).toEqual([]);
    expect(logLines.join('\n')).toContain('Now running sha256:new');
    expect(logLines.join('\n')).toContain('Cleared 1 agent-group image pin');
    expect(emitted.at(-1)).toMatchObject({ MODE: 'refresh', STATUS: 'success', CHANGED: 'true', CLEARED: 1 });
  });

  it('reports "Already up to date" when the digest did not change', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.inspectAgentImage.mockReturnValue({
      ref: 'x:latest',
      labels: {},
      source: 'hardened',
      registryDigest: 'sha256:same',
    });
    const { exits } = await runRegistry(['--refresh']);
    expect(exits).toEqual([]);
    expect(logLines.join('\n')).toContain('Already up to date.');
    expect(emitted.at(-1)).toMatchObject({ CHANGED: 'false' });
  });

  it('reports image_ref_not_configured on pull exit 2', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    spawnState.pullStatus = 2;
    const { exits } = await runRegistry(['--refresh']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'image_ref_not_configured' });
  });

  it('reports image_pull_failed on any other non-zero pull exit', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    spawnState.pullStatus = 1;
    const { exits } = await runRegistry(['--refresh']);
    expect(exits).toEqual([1]);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'image_pull_failed' });
  });

  it('continues (non-fatally) when reconcileDerivedImages rejects', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockReconcile.reconcileDerivedImages.mockRejectedValue(new Error('db exploded'));
    const { exits } = await runRegistry(['--refresh']);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success', CLEARED: 0 });
  });
});

describe('registry — opt-out', () => {
  it('switches from hardened to local and mentions --logout when signed in', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.readRegistryAccount.mockReturnValue({ token: 't' });
    await runRegistry(['--opt-out']);
    expect(mockState.writeImageSource).toHaveBeenCalledWith('local');
    expect(logLines.join('\n')).toContain('now builds its own agent image');
    expect(logLines.join('\n')).toContain('remove it with --logout');
    expect(emitted.at(-1)).toMatchObject({ MODE: 'opt-out', CHANGED: 'true' });
  });

  it('switching from hardened while not signed in omits the --logout mention', async () => {
    mockState.readImageSource.mockReturnValue('hardened');
    mockState.readRegistryAccount.mockReturnValue(undefined);
    await runRegistry(['--opt-out']);
    expect(logLines.join('\n')).not.toContain('--logout');
  });

  it('is a no-op message when already building locally', async () => {
    mockState.readImageSource.mockReturnValue('local');
    await runRegistry(['--opt-out']);
    expect(logLines.join('\n')).toContain('Already building locally');
    expect(emitted.at(-1)).toMatchObject({ CHANGED: 'false' });
  });
});

describe('registry — logout', () => {
  it('says "nothing to revoke" when not signed in', async () => {
    mockState.readRegistryAccount.mockReturnValue(undefined);
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).toContain('Not signed in — nothing to revoke');
    expect(emitted.at(-1)).toMatchObject({ MODE: 'logout', REVOKE: 'skipped' });
  });

  it('revokes successfully against the broker (fetch ok)', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok', api: 'https://broker.example.com' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true }) as Response),
    );
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).toContain('Session revoked.');
    expect(emitted.at(-1)).toMatchObject({ REVOKE: 'revoked' });
  });

  it('treats a 401/404 from the broker as already-gone, not a failure', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 404, ok: false }) as Response),
    );
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).toContain('already invalid');
    expect(emitted.at(-1)).toMatchObject({ REVOKE: 'gone' });
  });

  it('reports a real broker failure (non-ok, non-401/404) and still removes locally', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 500, ok: false }) as Response),
    );
    mockState.clearRegistryAccount.mockReturnValue(['/home/.config/nanoclaw/registry-auth.json']);
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).toContain("Couldn't reach");
    expect(logLines.join('\n')).toContain('Credential removed.');
    expect(emitted.at(-1)).toMatchObject({ REVOKE: 'failed', CREDENTIAL_REMOVED: 'true' });
  });

  it('treats a network error (fetch throws) as a revoke failure too', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await runRegistry(['--logout']);
    expect(emitted.at(-1)).toMatchObject({ REVOKE: 'failed' });
  });

  it('mentions removed credential-helper hosts', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true }) as Response),
    );
    mockCredHelper.uninstallCredentialHelper.mockReturnValue({
      removedBinaries: ['/bin/docker-credential-nanoclaw'],
      keptBinaries: [],
      removedHosts: ['reg.example.com'],
      dockerConfigPath: '/x',
      dockerConfigChanged: true,
    });
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).toContain('Docker no longer asks us for reg.example.com');
    expect(emitted.at(-1)).toMatchObject({ CRED_HELPER_HOSTS: 'reg.example.com' });
  });

  it('warns that the install still pulls but has no credentials, when source is still hardened', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true }) as Response),
    );
    mockState.readImageSource.mockReturnValue('hardened');
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).toContain('no longer has');
    expect(logLines.join('\n')).toContain('--opt-out');
  });

  it('says nothing extra about pulling when the install already builds locally', async () => {
    mockState.readRegistryAccount.mockReturnValue({ token: 'tok' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, ok: true }) as Response),
    );
    mockState.readImageSource.mockReturnValue('local');
    await runRegistry(['--logout']);
    expect(logLines.join('\n')).not.toContain('Sign in again by re-running setup');
  });
});

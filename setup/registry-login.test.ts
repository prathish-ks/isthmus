/**
 * The sign-in driver's idempotence decision: given a credential already on
 * disk, does this run reuse it, re-authenticate, or refuse to answer?
 *
 * That decision is the whole contract callers have with this driver — they
 * read an exit code and nothing else — and it is reachable without any of the
 * browser or enrollment machinery, so it is tested on its own here. Every test
 * runs against a temporary HOME with a stubbed `fetch`: no request leaves the
 * process, and the real credential in the developer's config directory is
 * never opened.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, string | number | boolean>>);

vi.mock('./status.js', () => ({
  emitStatus: vi.fn((_step: string, fields: Record<string, string | number | boolean>) => {
    emitted.push(fields);
  }),
}));
// Writes `.env` in the checkout, which a test must never do.
vi.mock('./lib/registry-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/registry-state.js')>()),
  writeImageSource: vi.fn(),
}));
// Installs a binary and edits ~/.docker/config.json.
vi.mock('./install-cred-helper.js', () => ({
  installCredentialHelper: vi.fn(() => ({ helperPath: '/dev/null/helper', onPath: true })),
}));

/** Nothing listens here, and nothing is meant to: every fetch is stubbed. */
const TARGET = 'https://registry.example.invalid';
const OTHER = 'https://registry.sandbox.example.invalid';

const homes: string[] = [];
let originalHome: string | undefined;

interface StoredCredential {
  api?: string;
  account_id?: string;
  token?: string;
}

/** A temporary HOME holding `account.json` exactly as written. */
function homeWith(credential: StoredCredential | undefined): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-login-'));
  homes.push(home);
  if (credential) {
    const dir = path.join(home, '.config', 'nanoclaw');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify(credential));
  }
  process.env.HOME = home;
  return home;
}

function storedToken(home: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(home, '.config', 'nanoclaw', 'account.json'), 'utf-8');
    return (JSON.parse(raw) as { token?: string }).token;
  } catch {
    return undefined;
  }
}

/** Run the driver with CONFIG_DIR resolved against the current HOME. */
async function runLogin(argv: string[]): Promise<number> {
  vi.resetModules();
  const { run } = await import('./registry-login.js');
  process.exitCode = undefined;
  await run(argv);
  const code = process.exitCode ?? 0;
  process.exitCode = undefined;
  return Number(code);
}

beforeEach(() => {
  originalHome ??= process.env.HOME;
  emitted.length = 0;
  vi.clearAllMocks();
  // Anything the environment already carries would steer the driver past the
  // branch under test.
  for (const key of ['NANOCLAW_REGISTRY_TOKEN', 'NANOCLAW_REGISTRY_ENROLL_CODE', 'NANOCLAW_REGISTRY_API']) {
    vi.stubEnv(key, '');
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalHome !== undefined) process.env.HOME = originalHome;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

/** The account service is there and answers; the credential is good. */
function stubProbeOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ account_id: 'acct_live', email: 'someone@example.invalid' }),
    })),
  );
}

/** Nothing answers — the state `probeSession` also reports for a 404 or a proxy error. */
function stubProbeUnreachable(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError('fetch failed');
    }),
  );
}

const stale: StoredCredential = { api: TARGET, account_id: 'acct_stale', token: 'nct_stale' };

describe('a stored credential the service cannot be asked about', () => {
  it('--require-verified: refuses to call it a sign-in, and keeps the file', async () => {
    const home = homeWith(stale);
    stubProbeUnreachable();

    await expect(runLogin(['--non-interactive', '--require-verified', '--api', TARGET])).resolves.toBe(2);

    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', REASON: 'unverified' });
    // Refusing to vouch for the credential is not a reason to destroy it: the
    // operator may be offline, and the next run can still verify it.
    expect(storedToken(home)).toBe('nct_stale');
  });

  it('without the flag: keeps it and exits 0, because the image pull can live with that', async () => {
    const home = homeWith(stale);
    stubProbeUnreachable();

    await expect(runLogin(['--non-interactive', '--api', TARGET])).resolves.toBe(0);

    expect(emitted.at(-1)).toMatchObject({ REASON: 'already-signed-in-unverified' });
    expect(storedToken(home)).toBe('nct_stale');
  });

  it('--require-verified covers the record with no api field, which the issuer check cannot', async () => {
    // `readAccountCredential` fills a missing `api` by resolving the base the
    // same way this run does, so such a record compares equal to the target
    // whenever no `--api` overrides it — which is every wizard run. The
    // mismatch branch below can therefore never fire on a credential written
    // before that field existed; verification is what catches it.
    homeWith({ account_id: 'acct_old', token: 'nct_from_an_older_login' });
    vi.stubEnv('NANOCLAW_REGISTRY_API', TARGET);
    stubProbeUnreachable();

    await expect(runLogin(['--non-interactive', '--require-verified'])).resolves.toBe(2);
    expect(emitted.at(-1)).toMatchObject({ REASON: 'unverified' });
  });

  it('verified against the service: still a sign-in, flag or no flag', async () => {
    homeWith(stale);
    stubProbeOk();

    await expect(runLogin(['--non-interactive', '--require-verified', '--api', TARGET])).resolves.toBe(0);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', REASON: 'already-signed-in' });
  });
});

describe('a stored credential issued by a different service', () => {
  it('is never probed, and does not stand in for a sign-in to the target', async () => {
    const home = homeWith({ ...stale, api: OTHER });
    const fetchMock = vi.fn(async () => ({ status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);

    // Non-interactive with nothing in the environment: the re-authentication
    // the mismatch calls for cannot happen here, so the run is a skip.
    await expect(runLogin(['--non-interactive', '--api', TARGET])).resolves.toBe(2);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', REASON: 'non-interactive' });
    expect(storedToken(home)).toBe('nct_stale');
  });
});

// Characterization test, added ahead of the v2.4.0-promotion Workstream C10
// refactor that extracts this exact error into a shared `notABroker()`
// helper (reused by the new `startDeviceFlow` export). Interactive mode
// reaches `probeBroker` before any prompt, so this needs no stdin/readline
// stubbing — the throw happens first, only a forced TTY to get past
// parseArgs's `Boolean(process.stdin.isTTY)` default. Written and run
// against the pre-refactor code to prove the wording this test pins is what's
// actually there today, not a guess.
describe('probing a URL that answers but is not a NanoClaw registry (interactive)', () => {
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('throws a LoginError naming the API and the reason, before any prompt', async () => {
    homeWith(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, text: async () => '<html>Not Found</html>' })));

    await expect(runLogin(['--api', TARGET])).rejects.toMatchObject({
      name: 'LoginError',
      message: `No NanoClaw registry at ${TARGET} (HTTP 404 with no NanoClaw registry response).`,
    });
  });
});

// New exports (v2.4.0 promotion, Workstream C10): `setup/portal.ts`'s own
// sign-in path needs the device flow split into two steps instead of
// `deviceLogin`'s one blocking call. Tested directly, not through `run()` —
// these are their own public contract now, the same reasoning
// `onecli.test.ts` uses for `contributionFromArgs`.
describe('startDeviceFlow / finishDeviceFlow', () => {
  const DEVICE_ENDPOINT = 'https://idp.example.invalid/device';
  const TOKEN_ENDPOINT = 'https://idp.example.invalid/token';

  beforeEach(() => {
    // The env-based clientId path in probeBroker — bypasses needing to also
    // mock the /v1/auth-config broker-probe response for these tests, which
    // are about the device-flow steps themselves, not broker discovery
    // (already covered by the "not a NanoClaw registry" suite above and by
    // startDeviceFlow's own not-a-broker/no-idp cases below).
    vi.stubEnv('NANOCLAW_WORKOS_CLIENT_ID', 'client_test');
    vi.stubEnv('NANOCLAW_WORKOS_DEVICE_ENDPOINT', DEVICE_ENDPOINT);
    vi.stubEnv('NANOCLAW_WORKOS_TOKEN_ENDPOINT', TOKEN_ENDPOINT);
  });

  it('startDeviceFlow returns the device authorization without printing or opening anything', async () => {
    homeWith(undefined);
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(DEVICE_ENDPOINT);
      return {
        status: 200,
        text: async () =>
          JSON.stringify({
            device_code: 'devcode-1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://idp.example.invalid/activate',
            expires_in: 300,
            interval: 1,
          }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.resetModules();
    const { startDeviceFlow } = await import('./registry-login.js');
    const flow = await startDeviceFlow(TARGET);

    expect(flow).toMatchObject({
      api: TARGET,
      idp: { clientId: 'client_test', deviceEndpoint: DEVICE_ENDPOINT, tokenEndpoint: TOKEN_ENDPOINT },
      device: { deviceCode: 'devcode-1', userCode: 'ABCD-1234' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('startDeviceFlow refuses a URL that answers but is not a NanoClaw registry, worded exactly as run() words it', async () => {
    // No env clientId this time, so probeBroker actually probes the broker.
    vi.stubEnv('NANOCLAW_WORKOS_CLIENT_ID', '');
    homeWith(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 404, text: async () => '<html>Not Found</html>' })));

    vi.resetModules();
    const { startDeviceFlow } = await import('./registry-login.js');
    await expect(startDeviceFlow(TARGET)).rejects.toMatchObject({
      name: 'LoginError',
      message: `No NanoClaw registry at ${TARGET} (HTTP 404 with no NanoClaw registry response).`,
    });
  });

  it('startDeviceFlow refuses a real registry with no identity provider configured', async () => {
    vi.stubEnv('NANOCLAW_WORKOS_CLIENT_ID', '');
    homeWith(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 503, text: async () => JSON.stringify({ device_flow_available: false }) })),
    );

    vi.resetModules();
    const { startDeviceFlow } = await import('./registry-login.js');
    await expect(startDeviceFlow(TARGET)).rejects.toMatchObject({
      name: 'LoginError',
      message: 'Browser authentication is not configured for this registry.',
    });
  });

  it('finishDeviceFlow polls until approved, enrolls, and persists the credential — portal.ts never touches account.json directly', async () => {
    const home = homeWith(undefined);
    let pollCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === TOKEN_ENDPOINT) {
        pollCount++;
        if (pollCount === 1) {
          return { status: 400, text: async () => JSON.stringify({ error: 'authorization_pending' }) };
        }
        return { status: 200, text: async () => JSON.stringify({ access_token: 'idp-token-1' }) };
      }
      if (url === `${TARGET}/v1/enroll`) {
        return {
          status: 201,
          text: async () =>
            JSON.stringify({ account_id: 'acct_new', token: 'nct_new', email: 'someone@example.invalid' }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    vi.resetModules();
    const { finishDeviceFlow } = await import('./registry-login.js');
    const credential = await finishDeviceFlow({
      api: TARGET,
      idp: { clientId: 'client_test', deviceEndpoint: DEVICE_ENDPOINT, tokenEndpoint: TOKEN_ENDPOINT },
      device: {
        deviceCode: 'devcode-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://idp.example.invalid/activate',
        expiresInS: 300,
        intervalS: 1,
      },
    });

    expect(credential).toMatchObject({ api: TARGET, account_id: 'acct_new', token: 'nct_new' });
    expect(storedToken(home)).toBe('nct_new');
    expect(pollCount).toBe(2);
  });

  it('finishDeviceFlow surfaces a declined sign-in as a LoginError', async () => {
    homeWith(undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === TOKEN_ENDPOINT) return { status: 400, text: async () => JSON.stringify({ error: 'access_denied' }) };
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    vi.resetModules();
    const { finishDeviceFlow } = await import('./registry-login.js');
    await expect(
      finishDeviceFlow({
        api: TARGET,
        idp: { clientId: 'client_test', deviceEndpoint: DEVICE_ENDPOINT, tokenEndpoint: TOKEN_ENDPOINT },
        device: {
          deviceCode: 'devcode-1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://idp.example.invalid/activate',
          expiresInS: 300,
          intervalS: 1,
        },
      }),
    ).rejects.toMatchObject({ name: 'LoginError', message: 'The sign-in was declined in the browser.' });
  });
});

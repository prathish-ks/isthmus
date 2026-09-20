import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn<(bin: string, args: string[], opts: unknown) => string>(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('./log.js', () => ({ log: mocks.log }));
vi.mock('./container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker-test' }));

const NETWORK = 'egress-net-test';
const GATEWAY = 'onecli-gw-test';

/**
 * `EGRESS_LOCKDOWN` is a module-level const read from config at import, so each
 * scenario re-imports the module against a freshly mocked config.
 */
async function load(lockdown: boolean) {
  vi.resetModules();
  vi.doMock('./config.js', () => ({
    EGRESS_LOCKDOWN: lockdown,
    EGRESS_NETWORK: NETWORK,
    ONECLI_GATEWAY_CONTAINER: GATEWAY,
  }));
  return import('./egress-lockdown.js');
}

/** Script the docker CLI by sub-command. `inspectMembers` is what `network inspect --format` prints. */
function scriptDocker(script: {
  inspect?: boolean;
  create?: boolean;
  connect?: boolean;
  /** Members reported per successive `network inspect --format` call. */
  members?: string[];
}) {
  const members = [...(script.members ?? [])];
  mocks.execFileSync.mockImplementation((_bin, args) => {
    const [, verb] = args;
    if (verb === 'inspect' && args.includes('--format')) {
      if (members.length === 0) throw new Error('no such network');
      return members.length > 1 ? members.shift()! : members[0];
    }
    if (verb === 'inspect') {
      if (script.inspect === false) throw new Error('no such network');
      return '';
    }
    if (verb === 'create') {
      if (script.create === false) throw new Error('create failed');
      return '';
    }
    if (verb === 'connect') {
      if (script.connect === false) throw new Error('connect failed');
      return '';
    }
    throw new Error(`unexpected docker verb ${verb}`);
  });
}

function verbs(): string[] {
  return mocks.execFileSync.mock.calls.map((c) => c[1][1]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execFileSync.mockReset();
});

describe('ensureEgressNetwork', () => {
  it('is a no-op returning false when lockdown is off — never shells out', async () => {
    const { ensureEgressNetwork } = await load(false);
    expect(ensureEgressNetwork()).toBe(false);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('returns true when the network exists and the gateway is already attached', async () => {
    const { ensureEgressNetwork } = await load(true);
    scriptDocker({ inspect: true, members: [`other ${GATEWAY} `] });

    expect(ensureEgressNetwork()).toBe(true);
    expect(verbs()).toEqual(['inspect', 'inspect']);
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(1, 'docker-test', ['network', 'inspect', NETWORK], {
      stdio: 'pipe',
      timeout: 15000,
    });
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      'docker-test',
      ['network', 'inspect', NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    // Already attached: nothing to connect, nothing to announce.
    expect(mocks.log.info).not.toHaveBeenCalled();
  });

  it('creates the internal network when missing, then attaches the gateway with the host alias', async () => {
    const { ensureEgressNetwork } = await load(true);
    // First format-inspect: nobody attached; after connect: gateway present.
    scriptDocker({ inspect: false, create: true, connect: true, members: ['', `${GATEWAY} `] });

    expect(ensureEgressNetwork()).toBe(true);
    expect(verbs()).toEqual(['inspect', 'create', 'inspect', 'connect', 'inspect']);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'docker-test',
      ['network', 'create', '--internal', NETWORK],
      expect.anything(),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'docker-test',
      ['network', 'connect', '--alias', 'host.docker.internal', NETWORK, GATEWAY],
      expect.anything(),
    );
    expect(mocks.log.info).toHaveBeenCalledWith('Egress lockdown: OneCLI gateway attached', {
      network: NETWORK,
      gateway: GATEWAY,
    });
  });

  it('throws EgressLockdownError when the network can neither be inspected nor created', async () => {
    const { ensureEgressNetwork, EgressLockdownError } = await load(true);
    scriptDocker({ inspect: false, create: false });

    let thrown: unknown;
    try {
      ensureEgressNetwork();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(EgressLockdownError);
    expect((thrown as Error).name).toBe('EgressLockdownError');
    expect((thrown as Error).message).toContain(`the "${NETWORK}" internal network could not be created`);
    expect((thrown as Error).message).toContain('NANOCLAW_EGRESS_LOCKDOWN=true');
    expect((thrown as Error).message).toContain(`"${GATEWAY}"`);
    expect((thrown as Error).message).toContain('NANOCLAW_EGRESS_LOCKDOWN=false to opt out');
    // Fail-fast: never tries to attach to a network it could not establish.
    expect(verbs()).toEqual(['inspect', 'create']);
  });

  it('throws when the gateway container cannot be connected', async () => {
    const { ensureEgressNetwork, EgressLockdownError } = await load(true);
    scriptDocker({ inspect: true, connect: false, members: [''] });

    expect(() => ensureEgressNetwork()).toThrow(EgressLockdownError);
    expect(() => ensureEgressNetwork()).toThrow(
      `the OneCLI gateway "${GATEWAY}" could not be attached to "${NETWORK}"`,
    );
    expect(mocks.log.info).not.toHaveBeenCalled();
  });

  it('throws when connect "succeeds" but the gateway still is not a member (no silent open egress)', async () => {
    const { ensureEgressNetwork, EgressLockdownError } = await load(true);
    scriptDocker({ inspect: true, connect: true, members: ['someone-else '] });

    expect(() => ensureEgressNetwork()).toThrow(EgressLockdownError);
    expect(verbs()).toEqual(['inspect', 'inspect', 'connect', 'inspect']);
  });

  it('treats an inspect failure while checking membership as "not attached"', async () => {
    const { ensureEgressNetwork } = await load(true);
    // members: [] → the format-inspect throws every time.
    scriptDocker({ inspect: true, connect: true, members: [] });

    expect(() => ensureEgressNetwork()).toThrow(/could not be attached/);
  });

  it('does not match the gateway name as a substring of another member', async () => {
    const { ensureEgressNetwork } = await load(true);
    scriptDocker({ inspect: true, connect: false, members: [`${GATEWAY}-shadow `] });
    expect(() => ensureEgressNetwork()).toThrow(/could not be attached/);
  });
});

describe('egressNetworkArgs / re-exports', () => {
  it('places a container on the locked-down network by name', async () => {
    const { egressNetworkArgs, EGRESS_NETWORK } = await load(true);
    expect(egressNetworkArgs()).toEqual(['--network', NETWORK]);
    expect(EGRESS_NETWORK).toBe(NETWORK);
  });
});

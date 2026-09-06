/**
 * Docker driver — behavioral tests.
 *
 * These replace the source-text assertions that used to live in
 * `container-runner.test.ts` and `container-runtime.test.ts`. Those read the
 * module as a string and regexed it, so a byte-identical move broke them while
 * a behavior change could slip past. Everything here drives a real spec through
 * the real realization path against an injected fake CLI and asserts on the
 * commands the driver actually issued.
 *
 * EC-02 (Phase 9, ADR-016) moved `docker create`/`docker start` (wake) and
 * `docker stop`/`docker rm` (kill) behind `internal/kernel`. This driver no
 * longer shells those directly — it delegates to an injected `KernelClient`
 * (a `FakeKernelClient` here, the same test-injection pattern `FakeCli`
 * already established) and this file's assertions moved with it: "spec
 * realization" now asserts on the `WireSession`/`WireRunAs`/`WireResources`
 * the driver handed the kernel client, not on a `docker create` argv.
 * `listSessions`/`watchSessions`/`reapResidue` stay TS-native per ADR-016 and
 * their tests are unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KernelError } from '../kernel/client.js';
import { FakeKernelClient } from '../kernel/fake-client.js';
import type { GuardContext } from '../kernel/protocol.js';

import { DockerSessionDriver, dockerEventToSessionEvent, ensureDockerRunning } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { withSessionEvents } from './session-events.js';
import { FIXTURE_POLICY, fixtureSpec } from './spec-fixture.js';
import { LABELS, type SessionEvent } from './types.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// The driver re-checks mount sources exist; fixture paths are not real files
// on the test host. A vi.fn so single tests can flip it to "missing".
vi.mock('fs', () => ({ default: { existsSync: vi.fn(() => true) } }));

import fs from 'fs';

import { log } from '../log.js';

// `FakeKernelClient` (the kernel-side counterpart to `FakeCli`) now lives in
// `kernel/fake-client.ts`, shared with `conformance.test.ts` — see that
// module's doc comment.

let cli: FakeCli;
let kernelClient: FakeKernelClient;

function driver(): DockerSessionDriver {
  return new DockerSessionDriver({ ...FIXTURE_POLICY, cli, kernelClient });
}

beforeEach(() => {
  vi.clearAllMocks();
  cli = new FakeCli('docker');
  cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
  kernelClient = new FakeKernelClient();
});

describe('spec realization (delegated to the kernel)', () => {
  it('hands the kernel the agent container with its image, entrypoint split and canonical labels', async () => {
    await driver().prepare(fixtureSpec());
    expect(kernelClient.wakeCalls).toHaveLength(1);
    const { spec } = kernelClient.wakeCalls[0];
    const agent = spec.containers.find((c) => c.role === 'agent')!;

    expect(spec.key).toEqual({ installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' });
    // Lineage labels from the spec and from the egress contribution both
    // land on the wire spec unmodified — the kernel derives the four
    // canonical adoption labels itself (naming.go's LabelsForKey).
    expect(spec.labels).toMatchObject({
      'nanoclaw-container-name': 'nanoclaw-v2-agent-one-1700000000000',
      'nanoclaw-group-folder': 'agent-one',
    });
    expect(agent.labels).toEqual({ 'session-channel': 'channel-abc' });
    expect(agent.image).toBe('nanoclaw-agent:spike-p0');
    expect(agent.command).toEqual(['bash', '-c']);
    expect(agent.args).toEqual(['exec bun run /app/src/index.ts']);
  });

  it('never calls docker create directly — the kernel is the only path to it', async () => {
    await driver().prepare(fixtureSpec());
    expect(cli.callMatching(/^create /)).toBeUndefined();
  });

  it('passes resources and runAs through to the kernel client, translated to the wire shape', async () => {
    await driver().prepare(fixtureSpec({ resources: { cpus: '2', memoryMb: 8192, shmSizeMb: 1024, pidsLimit: 2048 } }));
    const { spec } = kernelClient.wakeCalls[0];
    expect(spec.resources).toEqual({ cpus: '2', memoryMb: 8192, shmSizeMb: 1024, pidsLimit: 2048 });
    expect(spec.runAs).toEqual({ uid: 501, gid: 1000 });
  });

  it('mounts read-only where the spec says ro, and read-write otherwise', async () => {
    await driver().prepare(fixtureSpec());
    const { spec } = kernelClient.wakeCalls[0];
    const agent = spec.containers.find((c) => c.role === 'agent')!;

    const workspace = agent.mounts.find((m) => m.containerPath === '/workspace')!;
    expect(workspace).toMatchObject({ hostPath: '/install/data/v2-sessions/g1/s1', mode: 'rw' });
    const src = agent.mounts.find((m) => m.containerPath === '/app/src')!;
    expect(src).toMatchObject({ hostPath: '/install/container/agent-runner/src', mode: 'ro' });
  });

  it('carries exactly one value per env key, and never a credential', async () => {
    const spec = fixtureSpec();
    spec.containers[0].env = { TZ: 'UTC', HTTPS_PROXY: 'http://127.0.0.1:15001' };
    await driver().prepare(spec);
    const agent = kernelClient.wakeCalls[0].spec.containers.find((c) => c.role === 'agent')!;

    expect(agent.env).toEqual({ TZ: 'UTC', HTTPS_PROXY: 'http://127.0.0.1:15001' });
  });

  it('carries composed env and contributed env as separate lanes — the kernel applies last-wins ordering', async () => {
    // EC-02 moves the actual `-e ... -e ...` argv assembly (and its last-wins
    // ordering) into `internal/kernel`'s exec.go, ported field-for-field
    // (envArgs(agent.Env) then envArgs(agent.ContributedEnv)). This driver's
    // job is only to carry both lanes through to the kernel intact and
    // separate — never to merge them itself, which would silently drop the
    // provenance the contract's override rule depends on.
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { HTTPS_PROXY: 'http://gateway-must-win:15001' };
    await driver().prepare(spec);
    const agent = kernelClient.wakeCalls[0].spec.containers.find((c) => c.role === 'agent')!;

    expect(agent.env.HTTPS_PROXY).toBe('http://127.0.0.1:15001');
    expect(agent.contributedEnv).toEqual({ HTTPS_PROXY: 'http://gateway-must-win:15001' });
  });

  it('refuses to invent a missing mount source — Docker would mount a fresh empty directory', async () => {
    vi.mocked(fs.existsSync).mockReturnValueOnce(false);
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'spec-invalid', retryable: false });
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });

  it('returns a handle named from what the kernel actually returned, not a local prediction', async () => {
    kernelClient.wakeResult = { containerId: 'real-id', containerName: 'ncl-kernel-derived-name' };
    const handle = await driver().prepare(fixtureSpec());
    expect(handle.name).toBe('ncl-kernel-derived-name');
  });
});

describe('spec validation (still local — validateSpec runs before the kernel is ever called)', () => {
  it('rejects identity material on the agent container', async () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'identity-material',
      hostPath: '/install/data/session-materials/channel-abc-XXXX/session-key.pem',
      containerPath: '/run/session/session-key.pem',
      mode: 'ro',
      groupScope: 'g1',
    });

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });

  it('rejects a group-state mount that escapes the group subtree', async () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'group-state',
      hostPath: '/install/data/v2-sessions/g2/s9',
      containerPath: '/workspace/other',
      mode: 'rw',
      groupScope: 'g1',
    });

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });

  it('rejects an install-surface mount outside the enumerated surface roots', async () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      class: 'install-surface',
      hostPath: '/install/data/v2.db',
      containerPath: '/app/v2.db',
      mode: 'ro',
      groupScope: 'g1',
    });

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });

  it('rejects a secret-shaped env key', async () => {
    const spec = fixtureSpec();
    spec.containers[0].env.ANTHROPIC_API_KEY = 'sk-live';

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'denied-by-policy' });
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });

  it('rejects a spec with no agent container', async () => {
    const spec = fixtureSpec();
    spec.containers = spec.containers.filter((c) => c.role !== 'agent');

    await expect(driver().prepare(spec)).rejects.toMatchObject({ kind: 'spec-invalid' });
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });
});

describe('failure normalization (kernel-mediated wake)', () => {
  const cases: Array<[string, string]> = [
    ['manifest unknown', 'image-unavailable'],
    ['Cannot connect to the Docker daemon at unix:///var/run/docker.sock', 'runtime-unavailable'],
    ['no space left on device', 'resources-exhausted'],
    ['something nobody predicted', 'unknown'],
  ];

  for (const [message, kind] of cases) {
    it(`maps an exec-failed kernel error containing "${message}" to ${kind}`, async () => {
      kernelClient.wakeError = new KernelError({ code: 'exec-failed', detail: `docker create: ${message}` });
      await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind });
    });
  }

  it('maps a spec-invalid kernel denial to spec-invalid', async () => {
    kernelClient.wakeError = new KernelError({ code: 'spec-invalid', detail: 'session has no agent-role container' });
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'spec-invalid', retryable: false });
  });

  it('maps a denied kernel decision to denied-by-policy', async () => {
    kernelClient.wakeError = new KernelError({ code: 'denied', detail: 'mount escapes policy root' });
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'denied-by-policy' });
  });

  it('maps an unreachable kernel process (plain Error, not KernelError) to runtime-unavailable', async () => {
    kernelClient.wakeError = new Error('connect ENOENT /data/nanogo-kernel.sock');
    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({
      kind: 'runtime-unavailable',
      retryable: true,
    });
  });

  it('never lets the raw kernel error message cross the seam for an unrecognized failure', async () => {
    kernelClient.wakeError = new KernelError({
      code: 'exec-failed',
      detail: '/secrets/session-key.pem: permission denied',
    });
    await expect(driver().prepare(fixtureSpec())).rejects.toThrow(/^session realization failed: unknown$/);
  });

  it('leaves nothing locally allocated when the kernel rejects wake — prepare never ran its own create/rm', async () => {
    kernelClient.wakeError = new KernelError({ code: 'exec-failed', detail: 'boom' });
    await expect(driver().prepare(fixtureSpec())).rejects.toThrow();
    // Create is gone from this driver entirely now; a failed kernel-mediated
    // wake needs no local cleanup because this driver never allocated
    // anything locally to begin with (the kernel's own Wake is atomic).
    expect(cli.callMatching(/^create /)).toBeUndefined();
    expect(cli.callMatching(/^rm /)).toBeUndefined();
  });
});

describe('lifecycle', () => {
  /** The hub delivers a tick after the runtime's event: it re-reads truth first. */
  async function settled(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('supervises via attach --no-stdin (the kernel already started it) and the hub reports the exit code once', async () => {
    const handle = await withSessionEvents(driver()).prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();

    const started = cli.started.at(-1)!;
    expect(started.args).toEqual(['attach', '--no-stdin', 'ncl-spike-s1']);

    started.proc.emitExit(3);
    started.proc.emitExit(3);
    await settled();

    expect(terminal).toHaveBeenCalledExactlyOnceWith({ kind: 'started-then-died', retryable: false, exitCode: 3 });
  });

  it('surfaces the stderr tail at warn when the container exits non-zero', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();

    const proc = cli.started.at(-1)!.proc;
    proc.emitStderr('Unknown provider: mock. Registered: claude');
    proc.emitExit(1);

    expect(log.warn).toHaveBeenCalledWith(
      'Container exited non-zero',
      expect.objectContaining({ stderrTail: ['Unknown provider: mock. Registered: claude'] }),
    );
  });

  it('does not report a terminal event for a stop the host asked for', async () => {
    const handle = await withSessionEvents(driver()).prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    await handle.start();

    await handle.stop('host-shutdown');
    cli.started.at(-1)!.proc.emitExit(137);
    await settled();

    expect(terminal).not.toHaveBeenCalled();
  });

  it('kills via the kernel client, using the session id (identity the kernel resolves itself)', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    await handle.stop('sweep-kill');

    expect(kernelClient.killCalls).toEqual([{ sessionId: 's1', reason: 'sweep-kill', guard: undefined }]);
    // The graceful stop-then-remove is now the kernel's own job — this
    // driver issues no local `stop`/`rm` on the happy path.
    expect(cli.callMatching(/^stop /)).toBeUndefined();
    expect(cli.callMatching(/^rm /)).toBeUndefined();
  });

  it('threads a CLIRestartGuardContext through to the kernel kill when the caller supplies one', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    const guard: GuardContext = { cliRestart: { actorKind: 'agent', agentGroupId: 'g1', args: { id: 'g1' } } };

    await handle.stop('restarted via ncl', guard);

    expect(kernelClient.killCalls[0]!.guard).toEqual(guard);
  });

  it('falls back to a direct stop/rm when the kernel has no record of the session (kernel-registry-restart resilience)', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    kernelClient.killError = new KernelError({
      code: 'unknown-session',
      detail: 'no running session "s1" known to this kernel',
    });

    await handle.stop('sweep-kill');

    expect(cli.joined()).toContain('stop -t 1 ncl-spike-s1');
    expect(cli.joined()).toContain('rm --force ncl-spike-s1');
    expect(log.warn).toHaveBeenCalledWith(
      'Kernel has no record of this session (likely a kernel restart) — falling back to direct stop/rm',
      expect.objectContaining({ containerName: 'ncl-spike-s1' }),
    );
  });

  it('does NOT fall back locally on a real kernel denial — a denied kill must propagate, never be bypassed', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    kernelClient.killError = new KernelError({
      code: 'denied',
      detail: 'replay carried an invalid or mismatched grant',
    });

    await expect(handle.stop('restarted via ncl')).rejects.toThrow(/denied/);
    expect(cli.callMatching(/^stop /)).toBeUndefined();
    expect(cli.callMatching(/^rm /)).toBeUndefined();
  });

  it('kills the attach process when the kernel kill fails (non-unknown-session), so supervision cannot hang', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    kernelClient.killError = new KernelError({ code: 'exec-failed', detail: 'docker stop: daemon gone' });

    await expect(handle.stop('sweep-kill')).rejects.toThrow();

    expect(cli.started.at(-1)!.proc.killed).toBe(true);
  });

  it('start is idempotent', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();
    await handle.start();
    expect(cli.started).toHaveLength(1);
  });

  it('does not conclude status while the attach channel is alive and unresolved', async () => {
    const handle = await driver().prepare(fixtureSpec());
    await handle.start();

    expect((await handle.status()).phase).toBe('running');

    cli.started.at(-1)!.proc.emitExit(137);
    expect(await handle.status()).toEqual({
      phase: 'failed',
      failure: { kind: 'started-then-died', retryable: false, exitCode: 137 },
    });
  });
});

describe('idempotency and adoption', () => {
  it('returns the existing session rather than creating a second one', async () => {
    cli.responses = [{ match: /^inspect /, output: 'spike|g1|s1\n' }];

    const handle = await driver().prepare(fixtureSpec());

    expect(handle.name).toBe('ncl-spike-s1');
    expect(kernelClient.wakeCalls).toHaveLength(0);
  });

  it('refuses a name collision with a container that is not this session', async () => {
    // The name is key-derived, but a foreign container can wear it — another
    // install whose truncated identity collides, or an operator's hand-made
    // container. Adopting by name would attach the session to a runtime it
    // does not own.
    cli.responses = [{ match: /^inspect /, output: 'other-install|g9|s1\n' }];

    await expect(driver().prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'unknown', retryable: false });
    expect(kernelClient.wakeCalls).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      'Container name collision: existing container is not this session',
      expect.objectContaining({ containerName: 'ncl-spike-s1' }),
    );
  });

  it('scopes the predicted container name by install, truncating-then-hashing over-length identities', async () => {
    // Two peer installs holding the same session id must never alias one
    // runtime object; distinct keys sharing a truncated prefix must not
    // either. The prediction below is used only for the idempotency
    // pre-check (`#existingSession`) — it must match `internal/kernel`'s own
    // `ContainerName` port exactly, which this fixed algorithm guarantees.
    const longA = fixtureSpec({ key: { installSlug: 'x'.repeat(60), agentGroupId: 'g1', sessionId: 'same' } });
    const longB = fixtureSpec({ key: { installSlug: 'x'.repeat(61), agentGroupId: 'g1', sessionId: 'same' } });
    await driver().prepare(longA);
    const first = cli.callMatching(/^inspect /)!.args.at(-1)!;
    cli = new FakeCli('docker');
    cli.responses = [{ match: /^inspect /, throws: new Error('No such object') }];
    kernelClient = new FakeKernelClient();
    await driver().prepare(longB);
    const second = cli.callMatching(/^inspect /)!.args.at(-1)!;

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(52); // 'ncl-' + 48
    expect(second.length).toBeLessThanOrEqual(52);
  });

  it('rebuilds handles from labels alone, filtered to this install and the agent role', async () => {
    cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\nncl-spike-s2|running|g2|s2\n' }];

    const snapshots = await driver().listSessions('spike');

    const psArgs = cli.callMatching(/^ps -a/)!.args.join(' ');
    expect(psArgs).toContain(`label=${LABELS.install}=spike`);
    expect(psArgs).toContain(`label=${LABELS.role}=agent`);
    expect(snapshots.map((s) => s.handle.key)).toEqual([
      { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
      { installSlug: 'spike', agentGroupId: 'g2', sessionId: 's2' },
    ]);
  });

  it('phases the listing itself: exited is a corpse, created is not', async () => {
    cli.responses = [
      {
        match: /^ps -a/,
        output: 'ncl-spike-s1|exited|g1|s1\nncl-spike-s2|created|g2|s2\nncl-spike-s3|running|g3|s3\n',
      },
    ];

    const snapshots = await driver().listSessions('spike');

    expect(snapshots.map((s) => [s.handle.key.sessionId, s.phase])).toEqual([
      ['s1', 'terminal'],
      ['s2', 'starting'],
      ['s3', 'running'],
    ]);
  });

  it('stops pre-seam containers, which carry the install label but no session label', async () => {
    cli.responses = [{ match: /^ps --filter/, output: 'nanoclaw-v2-agent-one-1700000000000|\nncl-spike-s1|s1\n' }];

    await driver().reapResidue('spike');

    expect(cli.joined()).toContain('rm --force nanoclaw-v2-agent-one-1700000000000');
    expect(cli.joined().some((c) => c === 'rm --force ncl-spike-s1')).toBe(false);
  });

  it('reaps install-owned networks whose containers are gone', async () => {
    cli.responses = [{ match: /^network ls/, output: 'nc-spike-a-session\nnc-spike-a-uplink\n' }];

    await driver().reapResidue('spike');

    expect(cli.joined()).toContain('network rm nc-spike-a-session');
    expect(cli.joined()).toContain('network rm nc-spike-a-uplink');
    expect(log.info).toHaveBeenCalledWith('Removed orphaned networks', expect.objectContaining({ count: 2 }));
  });

  it('refuses a network name it did not shape', async () => {
    cli.responses = [{ match: /^network ls/, output: 'network$(id)\n' }];

    await driver().reapResidue('spike');

    expect(cli.joined().some((c) => c.startsWith('network rm'))).toBe(false);
  });
});

describe('watchSessions', () => {
  function dieEvent(sessionId: string, action = 'die'): string {
    return JSON.stringify({
      status: action,
      Type: 'container',
      Action: action,
      Actor: {
        ID: 'abc123',
        Attributes: {
          name: `ncl-${sessionId}`,
          [LABELS.install]: 'spike',
          [LABELS.group]: 'g1',
          [LABELS.session]: sessionId,
          [LABELS.role]: 'agent',
        },
      },
    });
  }

  it('is ONE lazy driver-level `docker events` subscription per install, shared by every subscriber', async () => {
    const d = driver();
    expect(cli.started.filter((s) => s.args[0] === 'events')).toHaveLength(0); // lazy

    const seen: SessionEvent[] = [];
    d.watchSessions('spike', (e) => seen.push(e));
    d.watchSessions('spike', () => {});

    const events = cli.started.filter((s) => s.args[0] === 'events');
    expect(events).toHaveLength(1);
    const argv = events[0].args.join(' ');
    expect(argv).toContain(`label=${LABELS.install}=spike`);
    expect(argv).toContain(`label=${LABELS.role}=agent`);
  });

  it('emits terminal hints keyed from the labels the event carries', async () => {
    const d = driver();
    const seen: SessionEvent[] = [];
    d.watchSessions('spike', (e) => seen.push(e));

    const proc = cli.started.find((s) => s.args[0] === 'events')!.proc;
    proc.emitStdout(`${dieEvent('s1')}\n${dieEvent('s2', 'start')}\n`);

    expect(seen).toEqual([
      { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' },
      { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's2' }, kind: 'phase' },
    ]);
  });

  it('stop() unsubscribes one listener without tearing down the shared stream', async () => {
    const d = driver();
    const seen: SessionEvent[] = [];
    const kept: SessionEvent[] = [];
    const watch = d.watchSessions('spike', (e) => seen.push(e));
    d.watchSessions('spike', (e) => kept.push(e));

    watch.stop();
    cli.started.find((s) => s.args[0] === 'events')!.proc.emitStdout(`${dieEvent('s1')}\n`);

    expect(seen).toHaveLength(0);
    expect(kept).toHaveLength(1);
  });

  it('reconnects with bounded backoff when the subscription process dies', async () => {
    vi.useFakeTimers();
    try {
      const d = driver();
      const seen: SessionEvent[] = [];
      d.watchSessions('spike', (e) => seen.push(e));

      cli.started.find((s) => s.args[0] === 'events')!.proc.emitExit(1);
      await vi.advanceTimersByTimeAsync(1_000);

      const procs = cli.started.filter((s) => s.args[0] === 'events');
      expect(procs).toHaveLength(2);
      procs.at(-1)!.proc.emitStdout(`${dieEvent('s1')}\n`);
      expect(seen).toEqual([{ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the gap on reconnect: corpses and vanished known keys get synthetic terminal hints', async () => {
    vi.useFakeTimers();
    try {
      const d = driver();
      cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\nncl-spike-s2|running|g1|s2\n' }];
      await d.listSessions('spike');

      const seen: SessionEvent[] = [];
      d.watchSessions('spike', (e) => seen.push(e));
      expect(seen).toEqual([]);

      cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s2|exited|g1|s2\n' }];
      cli.started.find((s) => s.args[0] === 'events')!.proc.emitExit(1);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(seen).toEqual([
        { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's2' }, kind: 'terminal' },
        { key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' }, kind: 'terminal' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hints nothing when the daemon is still down at reconnect — no false terminals', async () => {
    vi.useFakeTimers();
    try {
      const d = driver();
      cli.responses = [{ match: /^ps -a/, output: 'ncl-spike-s1|running|g1|s1\n' }];
      await d.listSessions('spike');
      const seen: SessionEvent[] = [];
      d.watchSessions('spike', (e) => seen.push(e));

      cli.responses = [{ match: /^ps -a/, throws: new Error('Cannot connect to the Docker daemon') }];
      cli.started.find((s) => s.args[0] === 'events')!.proc.emitExit(1);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(seen).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dockerEventToSessionEvent', () => {
  it('drops label-less documents and unknown actions — hints may drop', () => {
    expect(dockerEventToSessionEvent({ Action: 'die', Actor: { Attributes: { name: 'x' } } }, 'spike')).toBeNull();
    expect(
      dockerEventToSessionEvent(
        { Action: 'exec_create: bash', Actor: { Attributes: { [LABELS.group]: 'g1', [LABELS.session]: 's1' } } },
        'spike',
      ),
    ).toBeNull();
    expect(dockerEventToSessionEvent('not an object', 'spike')).toBeNull();
  });
});

describe('ensureDockerRunning', () => {
  it('passes when the daemon answers', () => {
    expect(() => ensureDockerRunning(cli)).not.toThrow();
    expect(cli.joined()).toContain('info');
  });

  it('throws a fatal startup error when it does not', () => {
    cli.responses = [{ match: /^info$/, throws: new Error('Cannot connect to the Docker daemon') }];
    expect(() => ensureDockerRunning(cli)).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

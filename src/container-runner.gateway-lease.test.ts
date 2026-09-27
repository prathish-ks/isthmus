/**
 * Gateway session lease lifecycle through the real spawn path (v2.4.0
 * promotion, Workstream C7/C8 integration).
 *
 * `spawnContainer` used to hand `sessions.ensure()` a throwaway
 * `AbortController` — see the git history on that call site's own comment —
 * because no registered gateway used `release`/`onUnavailable` yet. Iron
 * Proxy (Workstream C8) is exactly that gateway now, so this file proves
 * the wiring against a stub with the same shape (`release` +
 * `onUnavailable`), through the real `wakeContainer` → `spawnContainer`
 * path `container-runner.claims.test.ts` already exercises for claims —
 * same `RecordingKernel`/`setUpSeamRealDriver` setup, a custom gateway
 * installed in place of `setUpSeamRealDriver`'s own no-op stub.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-gateway-lease-smoke-${process.pid}` }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

import {
  getActiveContainerCount,
  getContainerStartedAtMs,
  isContainerRunning,
  killContainer,
  wakeContainer,
} from './container-runner.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { getSessionClaim, registerHostInstance, tryClaimSession } from './db/coordination.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from './db/index.js';
import type { FakeCli } from './drivers/fake-cli.js';
import { setUpSeamRealDriver, tearDownSeamRealDriver } from './drivers/seam-real-setup.js';
import {
  resetGatewayProvider,
  type GatewayProviderDefinition,
  type GatewaySessionRelease,
} from './gateway-providers/index.js';
import { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { RecordingKernel } from './kernel/fake-server.js';

const AGENT_GROUP_ID = 'ag-gateway-lease';
const SESSION_ID = 'sess-gateway-lease';

function now(): string {
  return new Date().toISOString();
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function testSession() {
  return {
    id: SESSION_ID,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: now(),
    created_at: now(),
  };
}

let fakeCli: FakeCli;
let kernel: RecordingKernel;
let releaseCalls: GatewaySessionRelease[];
let onUnavailableReport: ((reason: string) => void) | undefined;
let abortedReasons: unknown[];

/** Same shape Iron Proxy's real lease declares: `release` and `onUnavailable`. */
function installLeaseCapableGateway(): void {
  releaseCalls = [];
  onUnavailableReport = undefined;
  abortedReasons = [];
  const gateway: GatewayProviderDefinition = {
    kind: 'lease-capable-stub',
    agentSkills: [],
    sessions: {
      ensure: async (_input, signal) => {
        signal.addEventListener('abort', () => abortedReasons.push(signal.reason));
        return {
          contribution: { env: {}, mounts: [], networkAccess: { endpoint: '', target: { kind: 'host' } } },
          release: async (event) => {
            releaseCalls.push(event);
          },
          onUnavailable: (report) => {
            onUnavailableReport = report;
          },
        };
      },
    },
    approvals: { subscribe: async () => {} },
  };
  resetGatewayProvider(gateway);
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Gateway Lease Test',
    folder: 'gateway-lease-test',
    agent_provider: null,
    created_at: now(),
  });
  await createSession(testSession());
  await ensureContainerConfig(AGENT_GROUP_ID);

  fakeCli = setUpSeamRealDriver();
  installLeaseCapableGateway();
  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'), {
    allowed: true,
    containerId: 'gateway-lease-smoke-container-id',
    containerName: 'gateway-lease-smoke-kernel-chose-this',
  });
  await kernel.listen();

  await startHostInstanceLease({ renewIntervalMs: 60_000 });
});

afterEach(async () => {
  if (isContainerRunning(SESSION_ID)) {
    killContainer(SESSION_ID, 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning(SESSION_ID)).toBe(false));
  }
  await stopHostInstanceLease();
  tearDownSeamRealDriver();
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('normal termination', () => {
  it('releases the gateway lease exactly once when the session is killed', async () => {
    expect(await wakeContainer(testSession())).toBe(true);
    expect(isContainerRunning(SESSION_ID)).toBe(true);
    expect(getActiveContainerCount()).toBe(1);
    expect(getContainerStartedAtMs(SESSION_ID)).toBeGreaterThan(0);
    expect(releaseCalls).toHaveLength(0);

    killContainer(SESSION_ID, 'operator requested');
    await vi.waitFor(() => expect(isContainerRunning(SESSION_ID)).toBe(false));

    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toMatchObject({ kind: 'session-ended' });
    expect(abortedReasons).toHaveLength(1);
  });
});

describe('gateway unavailability', () => {
  it('onUnavailable tears the running session down exactly once', async () => {
    expect(await wakeContainer(testSession())).toBe(true);
    expect(isContainerRunning(SESSION_ID)).toBe(true);
    expect(onUnavailableReport).toBeTypeOf('function');

    onUnavailableReport!('proxy connection lost');
    // A second report must not double-teardown — killContainer and
    // finishAndResolve are both idempotent past the first terminal event.
    onUnavailableReport!('proxy connection lost');

    await vi.waitFor(() => expect(isContainerRunning(SESSION_ID)).toBe(false));
    expect(releaseCalls).toHaveLength(1);
    expect(abortedReasons).toHaveLength(1);
  });
});

describe('failure before the runtime is registered', () => {
  it('releases the lease immediately when the session claim is lost to another host', async () => {
    await registerHostInstance({
      instanceId: 'peer-host-1',
      installId: 'other-install',
      now: now(),
      leaseExpiresAt: iso(120_000),
    });
    await tryClaimSession({
      sessionId: SESSION_ID,
      instanceId: 'peer-host-1',
      expectedIncarnation: 0,
      containerRef: 'peer-container',
      now: now(),
    });

    const result = await wakeContainer(testSession());

    expect(result).toBe(false);
    expect(isContainerRunning(SESSION_ID)).toBe(false);
    // The claim-refusal throw happens after `sessions.ensure()` (the lease
    // is established before the claim is even attempted) but before any
    // driver/kernel call, and before a runtime is ever registered.
    expect(fakeCli.calls).toHaveLength(0);
    expect(kernel.received).toHaveLength(0);
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0]).toMatchObject({ kind: 'session-ended' });
    const claim = await getSessionClaim(SESSION_ID);
    expect(claim?.claimed_by).toBe('peer-host-1');
  });

  it('releases the lease when driver.prepare fails', async () => {
    // Close the fake kernel before waking: the dial fails, driver.prepare
    // rejects with runtime-unavailable — same scenario
    // container-runner.claims.test.ts's own claim-release test uses.
    await kernel.close();

    const result = await wakeContainer(testSession());

    expect(result).toBe(false);
    expect(isContainerRunning(SESSION_ID)).toBe(false);
    expect(releaseCalls).toHaveLength(1);
    const claim = await getSessionClaim(SESSION_ID);
    expect(claim?.claimed_by).toBeNull();
  });
});

describe('a gateway with no release/onUnavailable capability (OneCLI today)', () => {
  it('spawns and tears down normally with nothing to release', async () => {
    const gateway: GatewayProviderDefinition = {
      kind: 'none',
      agentSkills: [],
      sessions: {
        ensure: async () => ({
          contribution: { env: {}, mounts: [], networkAccess: { endpoint: '', target: { kind: 'host' } } },
        }),
      },
      approvals: { subscribe: async () => {} },
    };
    resetGatewayProvider(gateway);

    expect(await wakeContainer(testSession())).toBe(true);
    killContainer(SESSION_ID, 'test-teardown');
    await vi.waitFor(() => expect(isContainerRunning(SESSION_ID)).toBe(false));
    // Nothing to assert beyond "did not throw" — this lease declared
    // neither capability, matching OneCLI's own lease today.
    expect(getHostInstanceId()).toBeTruthy();
  });
});

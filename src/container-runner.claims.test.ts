/**
 * Session-claim wiring through the real spawn/adoption path (v2.4.0
 * promotion, Workstream C9 — ADR-030). Unlike upstream's own
 * `container-runner.claims.test.ts`, this tree has not ported the fuller
 * gateway-session-lifecycle wrapping (lease release/onUnavailable watching
 * on every teardown — see `container-runner.ts`'s own comment on the
 * throwaway `AbortController` in `spawnContainer`), so this file tests what
 * this port actually does: claim-before-spawn, refusal when a live peer
 * host holds the claim, takeover of a claim whose holder is no longer live,
 * and release on a failed `driver.prepare`. `adoptRunningSessions`'s own
 * claim-fencing (same `claimSessionRun` call, gating adoption instead of
 * spawn) is implemented but not covered here — exercising it needs a
 * session the driver's real `listSessions()` actually reports as running,
 * which needs either a real container or mocking `drivers/index.js`
 * directly (a different test setup than this file's real-driver style);
 * left as a gap rather than a test that doesn't exercise what it claims to.
 *
 * A real `RecordingKernel` (the same one `cli-channel-kernel-smoke.test.ts`
 * uses) stands in for `internal/kernel`, so the "claim succeeds" cases can
 * observe a real `driver.prepare()` success — without it every spawn fails
 * with `runtime-unavailable` before ever reaching the claim assertions that
 * matter.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-claims-smoke-${process.pid}` }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { getSessionClaim, registerHostInstance, tryClaimSession } from './db/coordination.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from './db/index.js';
import type { FakeCli } from './drivers/fake-cli.js';
import { setUpSeamRealDriver, tearDownSeamRealDriver } from './drivers/seam-real-setup.js';
import { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { RecordingKernel } from './kernel/fake-server.js';

const AGENT_GROUP_ID = 'ag-claims';
const SESSION_ID = 'sess-claims';

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

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Claims Test',
    folder: 'claims-test',
    agent_provider: null,
    created_at: now(),
  });
  await createSession(testSession());
  await ensureContainerConfig(AGENT_GROUP_ID);

  fakeCli = setUpSeamRealDriver();
  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'), {
    allowed: true,
    containerId: 'claims-smoke-container-id',
    containerName: 'claims-smoke-kernel-chose-this',
  });
  await kernel.listen();

  await startHostInstanceLease({ renewIntervalMs: 60_000 });
});

afterEach(async () => {
  if (isContainerRunning(SESSION_ID)) {
    killContainer(SESSION_ID, 'test-teardown');
    // killContainer is fire-and-forget; without this, activeContainers can
    // still hold the entry when the next test's beforeEach runs, and
    // wakeContainer's already-running short-circuit silently no-ops that
    // test's own spawn attempt.
    await vi.waitFor(() => expect(isContainerRunning(SESSION_ID)).toBe(false));
  }
  await stopHostInstanceLease();
  tearDownSeamRealDriver();
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('wakeContainer claim refusal', () => {
  it('refuses to spawn when a live peer host already holds the claim, without ever touching the kernel', async () => {
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
    // The claim-refusal throw happens before driver.prepare — neither the
    // fake CLI nor the fake kernel sees a single request.
    expect(fakeCli.calls).toHaveLength(0);
    expect(kernel.received).toHaveLength(0);
    const claim = await getSessionClaim(SESSION_ID);
    expect(claim?.claimed_by).toBe('peer-host-1');
  });

  it('claims and spawns normally when no conflicting claim exists', async () => {
    const result = await wakeContainer(testSession());

    expect(result).toBe(true);
    expect(isContainerRunning(SESSION_ID)).toBe(true);
    expect(kernel.requestsFor('container.wake')).toHaveLength(1);
    const claim = await getSessionClaim(SESSION_ID);
    expect(claim?.claimed_by).toBe(getHostInstanceId());
    expect(claim?.incarnation).toBe(1);
  });

  it('takes over a claim whose holder is no longer live (stopped or lease-expired)', async () => {
    await registerHostInstance({
      instanceId: 'dead-host-1',
      installId: 'other-install',
      now: now(),
      leaseExpiresAt: iso(-1_000), // already expired
    });
    await tryClaimSession({
      sessionId: SESSION_ID,
      instanceId: 'dead-host-1',
      expectedIncarnation: 0,
      containerRef: 'dead-container',
      now: now(),
    });

    const result = await wakeContainer(testSession());

    expect(result).toBe(true);
    const claim = await getSessionClaim(SESSION_ID);
    expect(claim?.claimed_by).toBe(getHostInstanceId());
    expect(claim?.incarnation).toBe(2);
  });

  it('releases the claim when driver.prepare fails, leaving the session takeover-able', async () => {
    // Close the fake kernel before waking: the dial fails, driver.prepare
    // rejects with runtime-unavailable, and the claim taken moments earlier
    // must not be left stuck.
    await kernel.close();

    const result = await wakeContainer(testSession());

    expect(result).toBe(false);
    expect(isContainerRunning(SESSION_ID)).toBe(false);
    const claim = await getSessionClaim(SESSION_ID);
    expect(claim?.claimed_by).toBeNull();
  });
});

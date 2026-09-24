/**
 * The sweep's due-message wake → real `wakeContainer` → real kernel socket
 * — the seam `host-sweep.coverage.test.ts`/`host-sweep-grace.test.ts` don't
 * span.
 *
 * Both existing sweep test files mock `container-runner.js`'s
 * `wakeContainer` entirely (`host-sweep-grace.test.ts`'s own header says
 * so: "mocking only the container runner"). Real, valuable coverage of the
 * sweep's decision logic (due-message detection, stuck-claim SLA, grace
 * periods) — but nothing proves the sweep's wake call actually reaches a
 * real kernel, the way `cli-channel-kernel-smoke.test.ts` (ADR-022) proves
 * for the router's own wake path. This file closes that composition gap,
 * leaving the existing decision-logic tests untouched.
 *
 * What is real here: `startHostSweep`'s real tick, the real central DB, a
 * real on-disk session mailbox with a genuinely due message
 * (`initSessionFolder` + `writeSessionMessage`, the same setup
 * `host-sweep-grace.test.ts` uses), the real `DockerSessionDriver`, the
 * real `KernelClient`, and a real Unix-socket NDJSON round trip. What is
 * deliberately NOT real, and why: same as every other seam-real test this
 * session added (ADR-022) — the kernel is a fake NDJSON server and the
 * docker CLI is a `FakeCli`.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-host-sweep-smoke-${process.pid}` }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

import { closeDb, createAgentGroup, ensureContainerConfig, initTestDb, runMigrations } from './db/index.js';
import { createSession } from './db/sessions.js';
import { setUpSeamRealDriver, tearDownSeamRealDriver } from './drivers/seam-real-setup.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { RecordingKernel, eventually } from './kernel/fake-server.js';
import { initSessionFolder, writeSessionMessage } from './session-manager.js';

const AGENT_GROUP_ID = 'ag-host-sweep-smoke';
const FOLDER = 'host-sweep-smoke';
const SESSION_ID = 'sess-host-sweep-smoke';

// Mirrors SWEEP_INTERVAL_MS in host-sweep.ts — identifies the sweep's own
// self-reschedule among other setTimeout calls (e.g. eventually's polling).
const SWEEP_INTERVAL_MS = 60_000;

/**
 * sweep()'s self-reschedule (`setTimeout(() => void sweep(), SWEEP_INTERVAL_MS)`)
 * only runs at the very END of a full tick — after sweepSession, and
 * therefore after its awaited maintainSessionMailbox/handleRecurrence
 * continuation, have both resolved. Waiting for the wake alone (as an
 * earlier version of this test did) races that continuation against
 * afterEach's closeDb(): observed empirically as a stray "Database not
 * initialized" thrown from inside sweepSession's own try/catch when run
 * alongside other test files. Capturing the reschedule instead of guessing
 * a delay is the same technique host-sweep-grace.test.ts already
 * established for exactly this reason.
 */
const sweepTickCallbacks: Array<() => void> = [];
let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

async function waitForFullSweepTick(): Promise<void> {
  await eventually(
    'the sweep tick to fully complete (self-reschedule captured)',
    () => sweepTickCallbacks.length === 1,
  );
}

let kernel: RecordingKernel;

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  sweepTickCallbacks.length = 0;
  const realSetTimeout = global.setTimeout;
  setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === SWEEP_INTERVAL_MS) {
      sweepTickCallbacks.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);

  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Host Sweep Smoke',
    folder: FOLDER,
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(AGENT_GROUP_ID);
  await createSession({
    id: SESSION_ID,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(AGENT_GROUP_ID, SESSION_ID);
  // A genuinely due message — the exact condition sweepSession's
  // `dueCount > 0 && !isContainerRunning(session.id)` checks for.
  await writeSessionMessage(AGENT_GROUP_ID, SESSION_ID, {
    id: 'm-1',
    kind: 'chat',
    timestamp: now(),
    content: '{"text":"hi"}',
  });

  setUpSeamRealDriver();

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'), {
    allowed: true,
    containerId: 'host-sweep-smoke-container-id',
    containerName: 'ncl-host-sweep-smoke-kernel-chose-this',
  });
  await kernel.listen();
});

afterEach(async () => {
  stopHostSweep();
  setTimeoutSpy.mockRestore();
  tearDownSeamRealDriver();
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a sweep tick with a due message reaches the kernel over a real socket', () => {
  it('wakes the session through a real wakeContainer call', async () => {
    startHostSweep();

    await eventually(
      'the kernel to receive a container.wake for the due session',
      () => kernel.requestsFor('container.wake').length === 1,
    );
    const wake = kernel.requestsFor('container.wake')[0];
    expect(wake.payload.session?.key).toMatchObject({
      agentGroupId: AGENT_GROUP_ID,
      sessionId: SESSION_ID,
    });

    // Wait for the REST of sweepSession's continuation (maintainSessionMailbox
    // -> handleRecurrence, still running after the wake) to fully settle
    // before this test returns and afterEach tears the DB down underneath
    // it — see waitForFullSweepTick's own comment for the race this closes.
    await waitForFullSweepTick();
  });
});

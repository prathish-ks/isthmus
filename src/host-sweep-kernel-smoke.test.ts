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
import net from 'net';
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
import { DockerSessionDriver } from './drivers/docker-driver.js';
import { FakeCli } from './drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver, withSessionEvents } from './drivers/index.js';
import { resetGatewayProvider, type GatewayProvider } from './gateway-providers/index.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { KERNEL_PROTOCOL_VERSION } from './kernel/protocol.js';
import type { CapabilityRequestPayload, KernelEnvelope } from './kernel/protocol.js';
import { initSessionFolder, writeSessionMessage } from './session-manager.js';

const AGENT_GROUP_ID = 'ag-host-sweep-smoke';
const FOLDER = 'host-sweep-smoke';
const SESSION_ID = 'sess-host-sweep-smoke';

class RecordingKernel {
  readonly received: Array<KernelEnvelope<CapabilityRequestPayload>> = [];
  readonly #server: net.Server;

  constructor(readonly socket: string) {
    this.#server = net.createServer((conn) => {
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const envelope = JSON.parse(buffer.slice(0, idx)) as KernelEnvelope<CapabilityRequestPayload>;
        this.received.push(envelope);
        conn.write(
          JSON.stringify({
            version: KERNEL_PROTOCOL_VERSION,
            requestId: envelope.requestId,
            ok: true,
            payload: {
              allowed: true,
              containerId: 'host-sweep-smoke-container-id',
              containerName: 'ncl-host-sweep-smoke-kernel-chose-this',
            },
          }) + '\n',
        );
        conn.end();
      });
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(this.socket, resolve));
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
  wakes(): Array<KernelEnvelope<CapabilityRequestPayload>> {
    return this.received.filter((e) => e.payload.capability === 'container.wake');
  }
}

async function eventually(what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

let kernel: RecordingKernel;

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
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
  await writeSessionMessage(AGENT_GROUP_ID, SESSION_ID, { id: 'm-1', kind: 'chat', timestamp: now(), content: '{"text":"hi"}' });

  const noGateway: GatewayProvider = { kind: 'none', contribute: async () => ({ env: {}, mounts: [] }) };
  resetGatewayProvider(noGateway);

  const fakeCli = new FakeCli('docker');
  fakeCli.responses = [{ match: /^inspect /, throws: 'Error: No such object' }];
  resetSessionDriver(withSessionEvents(new DockerSessionDriver({ ...mountPolicy(), cli: fakeCli })));

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'));
  await kernel.listen();
});

afterEach(async () => {
  stopHostSweep();
  resetSessionDriver(null);
  resetGatewayProvider(null);
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a sweep tick with a due message reaches the kernel over a real socket', () => {
  it('wakes the session through a real wakeContainer call', async () => {
    startHostSweep();

    await eventually('the kernel to receive a container.wake for the due session', () => kernel.wakes().length === 1);
    const wake = kernel.wakes()[0];
    expect(wake.payload.session?.key).toMatchObject({
      agentGroupId: AGENT_GROUP_ID,
      sessionId: SESSION_ID,
    });
  });
});

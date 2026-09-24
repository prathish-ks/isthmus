/**
 * `create_agent`'s success notify → real `wakeContainer` → real kernel
 * socket — the seam `create-agent.test.ts` doesn't span.
 *
 * `create-agent.test.ts` proves the REAL wrapped delivery action for
 * *authorization* (owner/global groups create directly; confined groups
 * hold for admin approval) — its own header says so explicitly. It mocks
 * `container-runner.js`'s `wakeContainer` entirely, so nothing proves that
 * `performCreateAgent`'s "Agent created" notify actually reaches a real
 * wake, the way `cli-channel-kernel-smoke.test.ts` (ADR-022) proves for the
 * router's wake path. This file closes that specific gap, without touching
 * the existing authorization tests' careful mocking of DB/filesystem
 * collaborators.
 *
 * What is real here: `createAgent`, the real central DB (agent_groups,
 * container_configs, destinations, sessions), the real filesystem
 * scaffold (`initGroupFilesystem`), `writeDestinations`, the real
 * `DockerSessionDriver`, the real `KernelClient`, and a real Unix-socket
 * NDJSON round trip.
 *
 * What is deliberately NOT real, and why: the kernel is a fake NDJSON
 * server and the docker CLI is a `FakeCli` — same reasons as every other
 * seam-real test this session added (ADR-022's discipline): this test
 * asserts the host builds and sends a well-formed `container.wake` request
 * for the SOURCE session (the only container `create_agent`'s own notify
 * ever wakes — the newly created agent group's container spawns lazily on
 * its own first message, never here), not whether `internal/kernel` admits
 * it.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-create-agent-smoke-${process.pid}` }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  ensureContainerConfig,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { FakeCli } from '../../drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver, withSessionEvents } from '../../drivers/index.js';
import { resetGatewayProvider, type GatewayProvider } from '../../gateway-providers/index.js';
import { KERNEL_PROTOCOL_VERSION } from '../../kernel/protocol.js';
import type { CapabilityRequestPayload, KernelEnvelope } from '../../kernel/protocol.js';
import type { Session } from '../../types.js';
import { createAgent } from './create-agent.js';

const SOURCE_AGENT_GROUP_ID = 'ag-create-agent-smoke-source';
const SOURCE_FOLDER = 'create-agent-smoke-source';
const MESSAGING_GROUP_ID = 'mg-create-agent-smoke';
const SOURCE_SESSION_ID = 'sess-create-agent-smoke-source';

/** Same recording-kernel shape as every other seam-real test added this session. */
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
              containerId: 'create-agent-smoke-container-id',
              containerName: 'ncl-create-agent-smoke-kernel-chose-this',
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
    id: SOURCE_AGENT_GROUP_ID,
    name: 'Create Agent Smoke Source',
    folder: SOURCE_FOLDER,
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(SOURCE_AGENT_GROUP_ID);
  await createMessagingGroup({
    id: MESSAGING_GROUP_ID,
    channel_type: 'cli',
    platform_id: 'local',
    name: 'Terminal',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createSession({
    id: SOURCE_SESSION_ID,
    agent_group_id: SOURCE_AGENT_GROUP_ID,
    messaging_group_id: MESSAGING_GROUP_ID,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: now(),
  } as Session);

  const noGateway: GatewayProvider = { kind: 'none', contribute: async () => ({ env: {}, mounts: [] }) };
  resetGatewayProvider(noGateway);

  const fakeCli = new FakeCli('docker');
  fakeCli.responses = [{ match: /^inspect /, throws: 'Error: No such object' }];
  resetSessionDriver(withSessionEvents(new DockerSessionDriver({ ...mountPolicy(), cli: fakeCli })));

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'));
  await kernel.listen();
});

afterEach(async () => {
  resetSessionDriver(null);
  resetGatewayProvider(null);
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a successful create_agent reaches the kernel over a real socket', () => {
  it('wakes the SOURCE session (never the new agent group) through a real wakeContainer call', async () => {
    const sourceSession: Session = {
      id: SOURCE_SESSION_ID,
      agent_group_id: SOURCE_AGENT_GROUP_ID,
      messaging_group_id: MESSAGING_GROUP_ID,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: now(),
    } as Session;

    await createAgent({ name: 'Scout', instructions: 'Find things.' }, sourceSession);

    await eventually(
      'the kernel to receive a container.wake for the source session',
      () => kernel.wakes().length === 1,
    );
    const wake = kernel.wakes()[0];
    expect(wake.payload.session?.key).toMatchObject({
      agentGroupId: SOURCE_AGENT_GROUP_ID,
      sessionId: SOURCE_SESSION_ID,
    });
  });
});

/**
 * `a2a.send`'s cross-session route → real `wakeContainer` → real kernel
 * socket — the seam `agent-route.test.ts` doesn't span.
 *
 * `agent-route.test.ts` proves the guard decision (destination ACL, target
 * existence, self-send, the message-policy hold) — `wakeContainer` is
 * mocked there entirely. This file closes the composition gap: does an
 * approved/self-send route actually reach a real wake for the resolved
 * target session, the way `cli-channel-kernel-smoke.test.ts` (ADR-022)
 * proves for the router's own wake path.
 *
 * Self-send (source agent group === target agent group) is used
 * deliberately — `routeAgentMessage`'s own comment says self-sends are
 * "always allowed", so this exercises the real composition
 * (`performAgentRoute` → `resolveTargetSession` → `wakeContainer`) without
 * needing destination-ACL or agent_message_policies rows the guard
 * decision itself already has dedicated (mocked) coverage for.
 *
 * What is real here: `routeAgentMessage`, the real central DB, the real
 * `DockerSessionDriver`, the real `KernelClient`, and a real Unix-socket
 * NDJSON round trip. What is deliberately NOT real, and why: same as every
 * other seam-real test this session added (ADR-022) — the kernel is a fake
 * NDJSON server and the docker CLI is a `FakeCli`; this proves the host
 * sends a well-formed `container.wake` request, not whether
 * `internal/kernel` admits it.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-agent-route-smoke-${process.pid}` }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

import { closeDb, createAgentGroup, ensureContainerConfig, initTestDb, runMigrations } from '../../db/index.js';
import { createDestination } from './db/agent-destinations.js';
import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { FakeCli } from '../../drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver, withSessionEvents } from '../../drivers/index.js';
import { resetGatewayProvider, type GatewayProvider } from '../../gateway-providers/index.js';
import { KERNEL_PROTOCOL_VERSION } from '../../kernel/protocol.js';
import type { CapabilityRequestPayload, KernelEnvelope } from '../../kernel/protocol.js';
import type { Session } from '../../types.js';
import { routeAgentMessage, type RoutableAgentMessage } from './agent-route.js';

const AGENT_GROUP_ID = 'ag-agent-route-smoke';
const FOLDER = 'agent-route-smoke';
const SESSION_ID = 'sess-agent-route-smoke';

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
              containerId: 'agent-route-smoke-container-id',
              containerName: 'ncl-agent-route-smoke-kernel-chose-this',
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
    name: 'Agent Route Smoke',
    folder: FOLDER,
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(AGENT_GROUP_ID);
  // Self-send still goes through the destination-ACL check first in
  // guard.ts's a2aSend decide fn before the self-send allow short-circuits
  // — a self-destination row is what a real create_agent-derived "self"
  // destination would look like, and its absence would otherwise deny
  // before self-send is ever consulted.
  await createDestination({
    agent_group_id: AGENT_GROUP_ID,
    local_name: 'self',
    target_type: 'agent',
    target_id: AGENT_GROUP_ID,
    created_at: now(),
  });

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

describe('a self-send a2a route reaches the kernel over a real socket', () => {
  it('resolves the target session and wakes it through a real wakeContainer call', async () => {
    const session: Session = {
      id: SESSION_ID,
      agent_group_id: AGENT_GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: null,
      created_at: now(),
    } as Session;

    const msg: RoutableAgentMessage = {
      id: 'a2a-smoke-1',
      platform_id: AGENT_GROUP_ID, // self-send: target === source
      content: JSON.stringify({ text: 'smoke: hello self' }),
      in_reply_to: null,
    };

    await routeAgentMessage(msg, session);

    await eventually(
      'the kernel to receive a container.wake for the resolved target session',
      () => kernel.wakes().length === 1,
    );
    const wake = kernel.wakes()[0];
    expect(wake.payload.session?.key.agentGroupId).toBe(AGENT_GROUP_ID);
  });
});

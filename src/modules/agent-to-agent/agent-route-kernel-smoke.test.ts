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
 * deliberately — `guard.ts`'s `a2aSend` decide fn short-circuits the
 * destination-ACL check entirely for a self-send (`!isSelf && ...`), so
 * this exercises the real composition (`performAgentRoute` →
 * `resolveTargetSession` → `wakeContainer`) without needing a destination
 * or agent_message_policies row the guard decision itself already has
 * dedicated (mocked) coverage for. Worth being precise about what this
 * scenario represents in production, since it's easy to overstate: nothing
 * in `create_agent`'s own destination-creation code
 * (`create-agent.ts`'s two `createDestination` calls are both cross-group,
 * creator→child and child→parent) ever produces a self-targeting
 * destination, so a genuine self-send is reachable only via a manually
 * operator-created destination (`ncl destinations add`), not any automated
 * agent flow — this is a real, guard-allowed path, just not a routine one.
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
import { setUpSeamRealDriver, tearDownSeamRealDriver } from '../../drivers/seam-real-setup.js';
import { RecordingKernel, eventually } from '../../kernel/fake-server.js';
import type { Session } from '../../types.js';
import { routeAgentMessage, type RoutableAgentMessage } from './agent-route.js';

const AGENT_GROUP_ID = 'ag-agent-route-smoke';
const FOLDER = 'agent-route-smoke';
const SESSION_ID = 'sess-agent-route-smoke';

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

  setUpSeamRealDriver();

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'), {
    allowed: true,
    containerId: 'agent-route-smoke-container-id',
    containerName: 'ncl-agent-route-smoke-kernel-chose-this',
  });
  await kernel.listen();
});

afterEach(async () => {
  tearDownSeamRealDriver();
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
      () => kernel.requestsFor('container.wake').length === 1,
    );
    const wake = kernel.requestsFor('container.wake')[0];
    expect(wake.payload.session?.key.agentGroupId).toBe(AGENT_GROUP_ID);
  });
});

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
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { updateContainerConfigScalars } from '../../db/container-configs.js';
import { runGuarded } from '../../delivery-guard.js';
import { setUpSeamRealDriver, tearDownSeamRealDriver } from '../../drivers/seam-real-setup.js';
import { RecordingKernel, eventually } from '../../kernel/fake-server.js';
import type { Session } from '../../types.js';
import { agentsCreate } from './guard.js';
import { createAgent, requestCreateAgentHold, validateCreateAgent } from './create-agent.js';

const SOURCE_AGENT_GROUP_ID = 'ag-create-agent-smoke-source';
const SOURCE_FOLDER = 'create-agent-smoke-source';
const MESSAGING_GROUP_ID = 'mg-create-agent-smoke';
const SOURCE_SESSION_ID = 'sess-create-agent-smoke-source';

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

  setUpSeamRealDriver();

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'), {
    allowed: true,
    containerId: 'create-agent-smoke-container-id',
    containerName: 'ncl-create-agent-smoke-kernel-chose-this',
  });
  await kernel.listen();
});

afterEach(async () => {
  tearDownSeamRealDriver();
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function sourceSession(): Session {
  return {
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
}

/**
 * Drives the exact same guard spec `modules/agent-to-agent/index.ts`
 * registers create_agent with (`agentsCreate`, `validateCreateAgent`,
 * `requestCreateAgentHold`) — not a hand-rolled equivalent — so "reaches
 * the kernel" is proven through the real authorization layer
 * `performCreateAgent`'s own doc comment says is mandatory, closing the
 * gap an earlier version of this test had: calling `createAgent` directly
 * bypasses guard entirely, so it couldn't distinguish "wiring works" from
 * "wiring works AND an unauthorized session can trigger it too."
 */
function createAgentGuarded(content: Record<string, unknown>, session: Session): Promise<void> {
  return runGuarded(
    'agents.create',
    { guardAction: agentsCreate, precheck: validateCreateAgent, requestHold: requestCreateAgentHold },
    (c, s) => createAgent(c, s),
    content,
    session,
    null,
  );
}

describe('a successful create_agent reaches the kernel over a real socket', () => {
  it('wakes the SOURCE session (never the new agent group) through a real wakeContainer call, for a trusted global-scope group', async () => {
    // agentsCreate's decide fn ALLOWs directly only for cli_scope: 'global'
    // (guard.ts) — the trusted-owner case. Set explicitly rather than
    // relying on ensureContainerConfig's default, which is 'group'
    // (confined) — see the HOLD case below for that one.
    await updateContainerConfigScalars(SOURCE_AGENT_GROUP_ID, { cli_scope: 'global' });

    await createAgentGuarded({ name: 'Scout', instructions: 'Find things.' }, sourceSession());

    await eventually(
      'the kernel to receive a container.wake for the source session',
      () => kernel.requestsFor('container.wake').length === 1,
    );
    const wake = kernel.requestsFor('container.wake')[0];
    expect(wake.payload.session?.key).toMatchObject({
      agentGroupId: SOURCE_AGENT_GROUP_ID,
      sessionId: SOURCE_SESSION_ID,
    });
    expect(await getAgentGroupByFolder('scout')).toBeTruthy();
  });
});

describe('an unauthorized create_agent never reaches the kernel', () => {
  it('holds for a confined (default group-scope) session and never creates the agent group', async () => {
    // cli_scope defaults to 'group' (ensureContainerConfig's own default,
    // left untouched here) — the realistic prompt-injection-victim shape
    // guard.ts's own comment names. agentsCreate HOLDs this, never ALLOWs
    // it directly. The privileged effect this guard exists to gate
    // (createAgentGroup's central-DB write, reached only from inside the
    // ALLOW branch) is the assertion that actually matters here — not
    // "was the kernel called", since a HOLD's own admin-notification path
    // has side effects of its own that aren't what this test is about.
    await createAgentGuarded({ name: 'Blocked Sub-Agent', instructions: null }, sourceSession());

    expect(await getAgentGroupByFolder('blocked-sub-agent')).toBeUndefined();
  });
});

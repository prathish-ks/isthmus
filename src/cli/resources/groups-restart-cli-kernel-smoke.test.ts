/**
 * `ncl groups restart --rebuild` (agent caller, approved replay) → real
 * kernel socket — the seam the 2026-09-24 wiring audit found unproven.
 *
 * `groups-restart-rebuild.test.ts` proves the imageBuild-capability gate;
 * `groups-plugin-guard.test.ts` proves plugin-owned config protection.
 * Both mock `container-runner.js` entirely. Nothing proves that an agent's
 * approved `restart --rebuild` replay actually reaches
 * `internal/kernel` for real — for either of the two capabilities this one
 * command touches, which this file asserts have DIFFERENT guard shapes on
 * the wire, exactly as `groups.ts`'s own comments document:
 *
 *   - `container.build_image` (the rebuild): sent with NO guard. ADR-016's
 *     accepted gap — `handleBuildImage` only ever consults
 *     `checkSelfModGuard`, so a `GuardContext` here would do nothing at the
 *     kernel; this command relies solely on TypeScript's own dispatch()-level
 *     guard (already fully enforced before the handler runs).
 *   - `container.kill` (the restart itself): sent WITH a `cliRestart`
 *     `GuardContext` carrying the approval that satisfied this command's
 *     hold, for the kernel's own independent re-verification (ADR-015).
 *
 * What is real here: `dispatch()`, the CLI guard/hold/grant machinery
 * (`guard()`, `grantSatisfies`, a real `pending_approvals` row), the real
 * `DockerSessionDriver`, the real `KernelClient`, and a real Unix-socket
 * NDJSON round trip for both capabilities.
 *
 * What is deliberately NOT real, and why: the kernel is a fake NDJSON
 * server and the docker CLI is a `FakeCli` — same reasons as
 * `cli-channel-kernel-smoke.test.ts` (ADR-022): this test asserts the host
 * builds and sends well-formed requests and honours the kernel's answer,
 * not whether `internal/kernel` admits them (a Go-side, live-Docker
 * question — see `adversarial_live_docker_test.go`/`build_image_live_docker_test.go`).
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-restart-cli-kernel-smoke-${process.pid}` }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

import { createPendingApproval, closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { wakeContainer } from '../../container-runner.js';
import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { FakeCli } from '../../drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver, withSessionEvents } from '../../drivers/index.js';
import { resetGatewayProvider, type GatewayProvider } from '../../gateway-providers/index.js';
import { KERNEL_PROTOCOL_VERSION } from '../../kernel/protocol.js';
import type { CapabilityRequestPayload, KernelEnvelope } from '../../kernel/protocol.js';
import type { PendingApproval, Session } from '../../types.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands (including restart).
import './groups.js';

const AGENT_GROUP_ID = 'ag-restart-smoke';
const GROUP_FOLDER = 'restart-smoke';
const MESSAGING_GROUP_ID = 'mg-restart-smoke';
const SESSION_ID = 'sess-restart-smoke';

/** Same recording-kernel shape as cli-channel-kernel-smoke.test.ts / apply-install-packages.smoke.test.ts. */
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
              containerId: 'restart-smoke-container-id',
              containerName: 'ncl-restart-smoke-kernel-chose-this',
              imageId: 'sha256:restart-smoke-fake-image-id',
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
  requestsFor(capability: string): Array<KernelEnvelope<CapabilityRequestPayload>> {
    return this.received.filter((e) => e.payload.capability === capability);
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
let fakeCli: FakeCli;

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Restart Smoke',
    folder: GROUP_FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(AGENT_GROUP_ID);
  // buildAgentGroupImage refuses with "No packages to install" otherwise —
  // this test's concern is the wire protocol, not self-mod's own package
  // bookkeeping (apply.test.ts already covers that).
  await updateContainerConfigJson(AGENT_GROUP_ID, 'packages_apt', ['ripgrep']);

  const noGateway: GatewayProvider = { kind: 'none', contribute: async () => ({ env: {}, mounts: [] }) };
  resetGatewayProvider(noGateway);

  fakeCli = new FakeCli('docker');
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

function session(): Session {
  return {
    id: SESSION_ID,
    agent_group_id: AGENT_GROUP_ID,
    messaging_group_id: MESSAGING_GROUP_ID,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  } as Session;
}

/**
 * Inserts a real, live `pending_approvals` row and returns it as the
 * `opts.grant` `dispatch()` expects — `guard()`'s `grantSatisfies` (see
 * `src/guard/guard.ts`) re-queries this row by id, so a grant object alone
 * (without the row actually existing) fails closed. Shape matches exactly
 * what `requestApproval` writes for a held CLI command
 * (`cli/dispatch.ts`'s hold branch): `action: 'cli_command'`, payload
 * carrying `frame.command` for `grantCoversRequest` to bind against
 * (`cli/guard.ts`).
 */
async function approvedRestartGrant(args: Record<string, unknown>): Promise<PendingApproval> {
  const approval: PendingApproval = {
    approval_id: 'appr-restart-smoke-1',
    session_id: null,
    request_id: 'req-restart-smoke-1',
    action: 'cli_command',
    payload: JSON.stringify({ frame: { id: 'req-restart-smoke-1', command: 'groups-restart', args } }),
    created_at: new Date().toISOString(),
    agent_group_id: AGENT_GROUP_ID,
    channel_type: null,
    platform_id: null,
    instance: null,
    platform_message_id: null,
    expires_at: null,
    status: 'approved',
    title: 'CLI: groups-restart',
    question: 'Agent wants to run `ncl groups-restart`',
    options_json: '[]',
    approver_user_id: null,
  };
  await createPendingApproval(approval);
  return approval;
}

describe('an approved restart --rebuild replay reaches the kernel over a real socket', () => {
  it('sends container.build_image with NO guard and container.kill WITH the cliRestart GuardContext', async () => {
    // Populate the in-memory activeContainers registry killContainer reads
    // from — a real wake through the real driver, exactly as
    // cli-channel-kernel-smoke.test.ts does for the router path, just
    // invoked directly here rather than via routeInbound.
    const woke = await wakeContainer(session());
    expect(woke).toBe(true);
    await eventually('the kernel to receive the wake', () => kernel.requestsFor('container.wake').length === 1);

    const args = { id: AGENT_GROUP_ID, rebuild: true };
    const grant = await approvedRestartGrant(args);

    const resp = await dispatch(
      { id: 'req-restart-smoke-1', command: 'groups-restart', args },
      { caller: 'agent', sessionId: SESSION_ID, agentGroupId: AGENT_GROUP_ID, messagingGroupId: MESSAGING_GROUP_ID },
      { grant },
    );

    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.data).toMatchObject({ restarted: 1, rebuilt: true });

    await eventually(
      'the kernel to receive the build_image request',
      () => kernel.requestsFor('container.build_image').length === 1,
    );
    const build = kernel.requestsFor('container.build_image')[0];
    expect(build.payload.agentGroupId).toBe(AGENT_GROUP_ID);
    // ADR-016's accepted gap, asserted explicitly so a future change that
    // silently starts (or silently stops) threading a guard here is a test
    // failure either way, not a silent drift from what groups.ts documents.
    expect(build.payload.guard).toBeUndefined();

    await eventually('the kernel to receive the kill request', () => kernel.requestsFor('container.kill').length === 1);
    const kill = kernel.requestsFor('container.kill')[0];
    expect(kill.payload.sessionId).toBe(SESSION_ID);
    expect(kill.payload.guard).toEqual({
      cliRestart: {
        actorKind: 'agent',
        agentGroupId: AGENT_GROUP_ID,
        args: { id: AGENT_GROUP_ID, agent_group_id: AGENT_GROUP_ID, group: AGENT_GROUP_ID },
        grant: { approvalId: 'appr-restart-smoke-1', action: 'cli_command' },
      },
    });
  });

  it('never reaches the kernel at all when the grant does not cover this request', async () => {
    const woke = await wakeContainer(session());
    expect(woke).toBe(true);
    await eventually('the kernel to receive the wake', () => kernel.requestsFor('container.wake').length === 1);

    // Approved for a DIFFERENT command than the one being replayed —
    // grantCoversRequest (cli/guard.ts) must refuse this, the same
    // approve-then-reuse-elsewhere binding
    // agent-to-agent/guard.coverage.test.ts already proves for a2a grants.
    const mismatchedGrant: PendingApproval = {
      approval_id: 'appr-restart-smoke-2',
      session_id: null,
      request_id: 'req-x',
      action: 'cli_command',
      payload: JSON.stringify({ frame: { id: 'req-x', command: 'groups-delete', args: { id: AGENT_GROUP_ID } } }),
      created_at: new Date().toISOString(),
      agent_group_id: AGENT_GROUP_ID,
      channel_type: null,
      platform_id: null,
      instance: null,
      platform_message_id: null,
      expires_at: null,
      status: 'approved',
      title: 'CLI: groups-delete',
      question: 'Agent wants to run `ncl groups-delete`',
      options_json: '[]',
      approver_user_id: null,
    };
    await createPendingApproval(mismatchedGrant);

    const resp = await dispatch(
      { id: 'req-restart-smoke-2', command: 'groups-restart', args: { id: AGENT_GROUP_ID, rebuild: true } },
      { caller: 'agent', sessionId: SESSION_ID, agentGroupId: AGENT_GROUP_ID, messagingGroupId: MESSAGING_GROUP_ID },
      { grant: mismatchedGrant },
    );

    expect(resp.ok).toBe(false);
    expect(kernel.requestsFor('container.build_image')).toHaveLength(0);
    expect(kernel.requestsFor('container.kill')).toHaveLength(0);
  });
});

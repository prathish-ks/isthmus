/**
 * `install_packages` approval → real kernel socket — the seam nothing else
 * in this repo spans for `container.build_image`.
 *
 * `apply.test.ts`'s `applyInstallPackages` suite already runs
 * `buildAgentGroupImage` for real (not mocked) against a fake, in-process
 * `KernelClientLike` injected via `setKernelClientForTests` — that proves
 * the business logic (config updates, dockerfile construction, the guard
 * shape, the rebuild-then-respawn sequence). It does NOT prove the host
 * actually speaks `internal/kernel`'s wire protocol correctly for this
 * specific capability: a real `KernelClient`, a real Unix socket, a real
 * NDJSON envelope out and back. This test does that part, the same way
 * `cli-channel-kernel-smoke.test.ts` (ADR-022) does it for `container.wake`.
 *
 * Before this file and the `apply.test.ts` additions alongside it,
 * `applyInstallPackages`/`buildAgentGroupImage` had the exact ADR-024 shape:
 * a real, guard-gated, production-reachable function that nothing exercised
 * against anything real on either side of the TS/Go boundary — see
 * docs/traceability.md's "End-to-end wiring / seam coverage" table and
 * go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md for the
 * precedent this closes.
 *
 * What is real here: `applyInstallPackages`, `buildAgentGroupImage`, the
 * container-config DB round trip, the real `KernelClient`, and a real
 * Unix-socket NDJSON round trip carrying a `container.build_image` request.
 *
 * What is deliberately NOT real, and why:
 *   - the kernel itself is a fake NDJSON server (same shape as
 *     `cli-channel-kernel-smoke.test.ts`'s `RecordingKernel`). This test
 *     asserts the *host* builds and sends a well-formed `build_image`
 *     envelope and honours the kernel's answer; whether `internal/kernel`
 *     ADMITS this request (re-verifies the self-mod grant, actually shells
 *     `docker build`) is a Go-side question — see
 *     `go-host/internal/kernel/adversarial_live_docker_test.go`'s
 *     `TestLive_BuildImage_*` cases for that half.
 *   - `killContainer`/`wakeContainer` stay mocked: this test's job is the
 *     build_image wire protocol specifically, not container lifecycle
 *     supervision, which `cli-channel-kernel-smoke.test.ts` already covers
 *     for the driver's docker-CLI leg.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-install-packages-smoke-${process.pid}` }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});
vi.mock('../../container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../container-runner.js')>('../../container-runner.js');
  return { ...actual, killContainer: vi.fn(), wakeContainer: vi.fn() };
});
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));

import { closeDb, createAgentGroup, ensureContainerConfig, initTestDb, runMigrations } from '../../db/index.js';
import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import type {
  DriverCapabilities,
  SessionDriver,
  SessionEvent,
  SessionHandle,
  SessionSnapshot,
  SessionSpec,
  SessionWatch,
} from '../../drivers/types.js';
import { FakeCli } from '../../drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver } from '../../drivers/index.js';
import { KERNEL_PROTOCOL_VERSION } from '../../kernel/protocol.js';
import type { CapabilityRequestPayload, KernelEnvelope } from '../../kernel/protocol.js';
import type { PendingApproval, Session } from '../../types.js';
import { applyInstallPackages } from './apply.js';

/** Minimal SessionDriver whose only meaningful method is capabilities(). */
class NoImageBuildDriver implements SessionDriver {
  readonly kind = 'no-image-build-fake';
  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }
  async prepare(_spec: SessionSpec): Promise<SessionHandle> {
    throw new Error('unreachable in this test — imageBuild:false must stop applyInstallPackages before prepare()');
  }
  async listSessions(_installSlug: string): Promise<SessionSnapshot[]> {
    return [];
  }
  watchSessions(_installSlug: string, _onEvent: (event: SessionEvent) => void): SessionWatch {
    return { stop: () => {} };
  }
}

const AGENT_GROUP_ID = 'ag-install-smoke';
const GROUP_FOLDER = 'install-smoke';
const session = { id: 'session-smoke', agent_group_id: AGENT_GROUP_ID } as Session;

/** Same shape as cli-channel-kernel-smoke.test.ts's RecordingKernel, scoped to build_image. */
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
            payload: { allowed: true, imageId: 'sha256:smoke-fake-image-id' },
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
  buildImageRequests(): Array<KernelEnvelope<CapabilityRequestPayload>> {
    return this.received.filter((e) => e.payload.capability === 'container.build_image');
  }
}

let kernel: RecordingKernel;

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Install Smoke',
    folder: GROUP_FOLDER,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(AGENT_GROUP_ID);

  resetSessionDriver(new DockerSessionDriver({ ...mountPolicy(), cli: new FakeCli('docker') }));

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'));
  await kernel.listen();
});

afterEach(async () => {
  resetSessionDriver(null);
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function fakeApproval(): PendingApproval {
  return {
    approval_id: 'appr-smoke-1',
    session_id: session.id,
    request_id: 'req-smoke-1',
    action: 'install_packages',
    payload: '{}',
    created_at: new Date().toISOString(),
    agent_group_id: AGENT_GROUP_ID,
    channel_type: null,
    platform_id: null,
    instance: null,
    platform_message_id: null,
    expires_at: null,
    status: 'approved',
    title: 'Install packages',
    question: 'Install packages?',
    options_json: '[]',
    approver_user_id: null,
  };
}

describe('an approved install_packages replay reaches the kernel over a real socket', () => {
  it('sends a well-formed container.build_image envelope carrying the SelfModGuardContext', async () => {
    await applyInstallPackages({ apt: ['ripgrep'] }, session, fakeApproval());

    expect(kernel.buildImageRequests()).toHaveLength(1);
    const envelope = kernel.buildImageRequests()[0];

    expect(envelope.version).toBe(KERNEL_PROTOCOL_VERSION);
    expect(envelope.op).toBe('capability.request');
    expect(envelope.payload.capability).toBe('container.build_image');
    expect(envelope.payload.agentGroupId).toBe(AGENT_GROUP_ID);
    expect(envelope.payload.groupFolder).toBe(GROUP_FOLDER);
    expect(envelope.payload.dockerfile).toContain('apt-get install -y ripgrep');

    // The exact property LAW-07's annotation and ADR-015 care about: the
    // approval that satisfied the TypeScript-side hold crosses the wire so
    // the kernel can independently re-verify it, rather than the host's
    // decision being trusted advisorially.
    expect(envelope.payload.guard).toEqual({
      selfMod: {
        actorKind: 'agent',
        action: 'self_mod.install_packages',
        grant: { approvalId: 'appr-smoke-1', action: 'install_packages' },
      },
    });
  });

  it('never reaches the kernel when the driver reports no image-build capability', async () => {
    // A driver whose capabilities().imageBuild is false — the backstop
    // buildAgentGroupImage's own comment names ("any future caller that
    // forgets" to gate on it) — must refuse before the wire, not after.
    resetSessionDriver(new NoImageBuildDriver());

    await applyInstallPackages({ apt: ['ripgrep'] }, session, fakeApproval());

    expect(kernel.buildImageRequests()).toHaveLength(0);
  });
});

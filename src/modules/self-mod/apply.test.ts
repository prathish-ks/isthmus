import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GuardContext } from '../../drivers/types.js';
import type { KernelClientLike, KernelWakeResult } from '../../kernel/client.js';
import type { PendingApproval, Session } from '../../types.js';

// `killContainer`/`wakeContainer` stay mocked — this file's job is
// self-mod's business logic (config updates, guard construction, the
// rebuild-then-respawn sequence), not container lifecycle, which the
// seam-real `apply-install-packages.smoke.test.ts` already covers with a
// real kernel socket. `buildAgentGroupImage` itself is deliberately left
// REAL here (via `vi.importActual`): it was previously mocked alongside the
// other two, which is exactly why it had zero test coverage of its own
// (go-host/docs/ADR-024's "wiring gap" shape, found in the 2026-09-24
// wiring audit — see docs/traceability.md's seam-coverage table).
// `setKernelClientForTests` (the module's own declared seam for this, also
// found orphaned by that audit) is what makes running the real function
// possible without a live Docker daemon or a real kernel socket.
vi.mock('../../container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../container-runner.js')>('../../container-runner.js');
  return { ...actual, killContainer: vi.fn(), wakeContainer: vi.fn() };
});
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn() }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-self-mod-apply' };
});

import {
  closeDb,
  createAgentGroup,
  ensureContainerConfig,
  getContainerConfig,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { killContainer, setKernelClientForTests } from '../../container-runner.js';
import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { FakeCli } from '../../drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver } from '../../drivers/index.js';
import { writeSessionMessage } from '../../session-manager.js';
import { applyAddMcpServer, applyInstallPackages } from './apply.js';

const TEST_DIR = '/tmp/nanoclaw-test-self-mod-apply';
const session = { id: 'session-1', agent_group_id: 'ag-1' } as Session;

/**
 * Records every `buildImage` call it's given rather than talking to a real
 * kernel — `wake`/`kill` throw if reached, since nothing in this file's
 * scenarios should ever call them (that would mean `applyInstallPackages`
 * is bypassing `killContainer`/`wakeContainer` and calling the kernel
 * client directly, which would itself be a bug worth catching).
 */
class RecordingKernelClient implements KernelClientLike {
  readonly buildImageCalls: Array<Parameters<KernelClientLike['buildImage']>[0]> = [];
  buildImageResult: string | Error = 'fake-image-id';

  async wake(): Promise<KernelWakeResult> {
    throw new Error('unexpected: RecordingKernelClient.wake should not be reached from applyInstallPackages');
  }
  async kill(): Promise<void> {
    throw new Error('unexpected: RecordingKernelClient.kill should not be reached from applyInstallPackages');
  }
  async buildImage(params: Parameters<KernelClientLike['buildImage']>[0]): Promise<string> {
    this.buildImageCalls.push(params);
    if (this.buildImageResult instanceof Error) throw this.buildImageResult;
    return this.buildImageResult;
  }
}

function fakeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approval_id: 'appr-1',
    session_id: session.id,
    request_id: 'req-1',
    action: 'install_packages',
    payload: '{}',
    created_at: new Date().toISOString(),
    agent_group_id: session.agent_group_id,
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
    ...overrides,
  };
}

let kernelClient: RecordingKernelClient;

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');

  // `buildAgentGroupImage` is real in this file (see the container-runner.js
  // mock above); it needs a driver whose capabilities().imageBuild is true
  // (DockerSessionDriver always reports true — no fake capabilities object
  // needed) and a kernel client that doesn't dial a real socket.
  resetSessionDriver(new DockerSessionDriver({ ...mountPolicy(), cli: new FakeCli('docker') }));
  kernelClient = new RecordingKernelClient();
  setKernelClientForTests(kernelClient);

  // `killContainer`/`wakeContainer`/`writeSessionMessage` are module-level
  // `vi.fn()`s that persist across every test in this file (this project's
  // vitest config sets no clearMocks/restoreMocks) — clear call history so
  // a "not called" assertion in one test can't be satisfied by a previous
  // test's leftover calls.
  vi.mocked(killContainer).mockClear();
  vi.mocked(writeSessionMessage).mockClear();
});

afterEach(async () => {
  resetSessionDriver(null);
  setKernelClientForTests(null);
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('applyAddMcpServer', () => {
  it('persists approved HTTPS MCP config', async () => {
    await applyAddMcpServer({ name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' }, session);

    expect(JSON.parse((await getContainerConfig('ag-1'))!.mcp_servers)).toEqual({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
    });
  });

  it('refuses to overwrite a plugin-owned server even after approval', async () => {
    await updateContainerConfigJson('ag-1', 'mcp_servers', {
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });

    await applyAddMcpServer({ name: 'docs', type: 'http', url: 'https://evil.example.com/mcp' }, session);

    expect(JSON.parse((await getContainerConfig('ag-1'))!.mcp_servers)).toEqual({
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });
  });
});

describe('applyInstallPackages', () => {
  it('persists the packages, builds the image via the real kernel client, and rebuilds', async () => {
    await applyInstallPackages({ apt: ['curl'], npm: ['left-pad'] }, session, fakeApproval());

    expect(JSON.parse((await getContainerConfig('ag-1'))!.packages_apt)).toEqual(['curl']);
    expect(JSON.parse((await getContainerConfig('ag-1'))!.packages_npm)).toEqual(['left-pad']);

    expect(kernelClient.buildImageCalls).toHaveLength(1);
    const built = kernelClient.buildImageCalls[0];
    expect(built.agentGroupId).toBe('ag-1');
    expect(built.imageTag).toMatch(/:ag-1$/);
    expect(built.dockerfile).toContain('apt-get install -y curl');
    expect(built.dockerfile).toContain('pnpm install -g left-pad');

    // Rebuild note is written before the kill+respawn, and the container is
    // actually killed with a respawn callback — the two effects
    // `applyInstallPackages`'s own doc comment promises for a successful build.
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledWith(
      'ag-1',
      'session-1',
      expect.objectContaining({ content: expect.stringContaining('Packages installed') }),
    );
    expect(vi.mocked(killContainer)).toHaveBeenCalledExactlyOnceWith(
      'session-1',
      'rebuild applied',
      expect.any(Function),
    );
  });

  it('constructs a SelfModGuardContext carrying the approval id/action, for kernel-side re-verification', async () => {
    await applyInstallPackages(
      { apt: ['curl'] },
      session,
      fakeApproval({ approval_id: 'appr-42', action: 'install_packages' }),
    );

    const guard = kernelClient.buildImageCalls[0].guard as GuardContext;
    expect(guard).toEqual({
      selfMod: {
        actorKind: 'agent',
        action: 'self_mod.install_packages',
        grant: { approvalId: 'appr-42', action: 'install_packages' },
      },
    });
  });

  it('passes no guard when applied without an approval row', async () => {
    await applyInstallPackages({ apt: ['curl'] }, session, null);

    expect(kernelClient.buildImageCalls[0].guard).toBeUndefined();
  });

  it('notifies the agent and does NOT kill the container when the kernel build fails', async () => {
    kernelClient.buildImageResult = new Error('kernel: denied: self-mod grant expired');

    await applyInstallPackages({ apt: ['curl'] }, session, fakeApproval());

    // Packages are still recorded — only the rebuild failed, per the
    // function's own doc comment ("Packages added to config... but rebuild
    // failed").
    expect(JSON.parse((await getContainerConfig('ag-1'))!.packages_apt)).toEqual(['curl']);

    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledWith(
      'ag-1',
      'session-1',
      expect.objectContaining({ content: expect.stringContaining('rebuild failed') }),
    );
    expect(vi.mocked(killContainer)).not.toHaveBeenCalled();
  });

  it('never reaches the kernel and notifies (not throws) when payload is empty', async () => {
    // `applyInstallPackages` never rethrows a build failure — it's a
    // guarded delivery handler body, not something with a caller waiting
    // on its rejection; every failure path ends in `notifyAgent`, per its
    // own doc comment. `buildAgentGroupImage`'s "No packages to install"
    // guard fires before it ever calls the kernel.
    await expect(applyInstallPackages({}, session, fakeApproval())).resolves.toBeUndefined();

    expect(kernelClient.buildImageCalls).toHaveLength(0);
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledWith(
      'ag-1',
      'session-1',
      expect.objectContaining({ content: expect.stringContaining('No packages to install') }),
    );
    expect(vi.mocked(killContainer)).not.toHaveBeenCalled();
  });
});

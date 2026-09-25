/**
 * Workstream C14, step 4: does `buildMounts`/`resolveProviderContribution`
 * actually compose a correct mount set from a registered provider host
 * contract — not just leave Claude's legacy path alone (that's
 * `mount-composition.test.ts`, `provider-surfaces.test.ts`, and every other
 * `buildMounts('claude', ...)` caller, all of which still pass byte-for-byte
 * unmodified after this rewrite).
 *
 * End-to-end in the same style as `mount-composition.test.ts`: a real group
 * filesystem, the real `buildMounts`/`resolveProviderContribution`, the real
 * `mountPolicy()`/`validateSpec` — so this proves the composed spec is
 * actually kernel-admissible, not just structurally plausible.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-provider-host-contract-mounts-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-provider-host-contract-mounts-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-provider-host-contract-mounts-test/groups',
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DATA_DIR as REAL_DATA_DIR, INSTALL_SLUG } from './config.js';
import { buildMounts, resolveProviderContribution, toMountSpecs } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { mountPolicy } from './drivers/index.js';
import { GROUP_FOLDER_LABEL, validateSpec, type SessionSpec } from './drivers/types.js';
import { registerProviderContainerConfig } from './providers/provider-container-registry.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  registerProviderHostContract,
  resetProviderHostContractForTesting,
} from './provider-contracts/registry.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

const PROVIDER = 'contract-mount-test-provider';
const LEGACY_ADAPTER_PROVIDER = 'contract-legacy-adapter-required-provider';

const legacyFn = vi.fn().mockResolvedValue({
  mounts: [{ hostPath: '/should-not-appear', containerPath: '/should-not-appear', readonly: true }],
  env: { FROM_LEGACY_OVERLAY: 'yes' },
});
// Registered once — provider registries are module-global and reject
// duplicate registrations, so this can't live inside beforeEach.
registerProviderContainerConfig(PROVIDER, legacyFn, {});

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}
function session(id: string, agentGroupId: string, provider: string = PROVIDER): Session {
  return { id, agent_group_id: agentGroupId, agent_provider: provider } as Session;
}
function containerConfig(): ContainerConfig {
  return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: [] } as unknown as ContainerConfig;
}

function registerTestContract(): void {
  registerProviderHostContract(PROVIDER, {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: { fileName: 'CONTRACT.md', containerPath: '/workspace/agent/CONTRACT.md', mountClass: 'group-state' },
    stateVolumes: [
      {
        id: 'home',
        directory: '.contract-home',
        containerPath: '/home/node/.contract',
        scope: 'group',
        mode: 'rw',
        mountClass: 'group-state',
      },
      {
        id: 'extra',
        directory: '.contract-extra',
        containerPath: '/home/node/.contract-extra',
        scope: 'group',
        mode: 'ro',
        mountClass: 'allowlisted-extra',
      },
    ],
    skillBackings: [
      {
        id: 'skills',
        location: { kind: 'state-volume', volumeId: 'home', subdirectory: '' },
        skillsSubdirectory: 'skills',
        conflictDiagnostics: 'silent',
        templateCopies: 'in-place',
      },
    ],
    skillViews: [{ backingId: 'skills', containerPath: '/home/node/.contract/skills', mode: 'ro', mountClass: 'group-state' }],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  legacyFn.mockResolvedValue({
    mounts: [{ hostPath: '/should-not-appear', containerPath: '/should-not-appear', readonly: true }],
    env: { FROM_LEGACY_OVERLAY: 'yes' },
  });
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  registerTestContract();
});

afterEach(async () => {
  resetProviderHostContractForTesting(PROVIDER);
  resetProviderHostContractForTesting(LEGACY_ADAPTER_PROVIDER);
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function seed(id: string, folder: string): Promise<AgentGroup> {
  const ag = group(id, folder);
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  return ag;
}

function specFrom(agentGroup: AgentGroup, mounts: Awaited<ReturnType<typeof buildMounts>>): SessionSpec {
  return {
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: 'sess' },
    labels: { [GROUP_FOLDER_LABEL]: agentGroup.folder },
    containers: [
      { role: 'agent', image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, agentGroup.id) },
    ],
    network: 'shared-private',
    hardening: 'standard',
    resources: {},
    runtimeTier: 'container',
    stopGraceSeconds: 1,
  };
}

describe('provider host contract mount composition (Workstream C14, step 4)', () => {
  it('composes the project document via the contract and mounts it at the declared path/class', async () => {
    const ag = await seed('ag-contract-doc', 'contract-doc-group');
    const sess = session('s1', ag.id);

    const { provider, contribution, surfaces } = await resolveProviderContribution(sess, ag, containerConfig());
    expect(provider).toBe(PROVIDER);
    const mounts = await buildMounts(ag, sess, containerConfig(), provider, contribution, surfaces);

    const doc = mounts.find((m) => m.containerPath === '/workspace/agent/CONTRACT.md');
    expect(doc).toMatchObject({ readonly: true, mountClass: 'group-state' });
    expect(fs.existsSync(doc!.hostPath)).toBe(true);
    expect(fs.readFileSync(doc!.hostPath, 'utf-8')).toContain('Composed at spawn');
  });

  it('mounts a group-state volume immediately and an allowlisted-extra volume late', async () => {
    const ag = await seed('ag-contract-vol', 'contract-vol-group');
    const sess = session('s1', ag.id);

    const { provider, contribution, surfaces } = await resolveProviderContribution(sess, ag, containerConfig());
    const mounts = await buildMounts(ag, sess, containerConfig(), provider, contribution, surfaces);

    const home = mounts.find((m) => m.containerPath === '/home/node/.contract');
    expect(home).toMatchObject({ readonly: false, mountClass: 'group-state' });
    const extra = mounts.find((m) => m.containerPath === '/home/node/.contract-extra');
    expect(extra).toMatchObject({ readonly: true, mountClass: 'allowlisted-extra' });

    // Late means after the install-surface (agent-runner src/skills) mounts,
    // not interleaved with the group-state ones — the real spawn order.
    const agentRunnerIdx = mounts.findIndex((m) => m.containerPath === '/app/src');
    const extraIdx = mounts.findIndex((m) => m.containerPath === '/home/node/.contract-extra');
    const homeIdx = mounts.findIndex((m) => m.containerPath === '/home/node/.contract');
    expect(homeIdx).toBeLessThan(agentRunnerIdx);
    expect(extraIdx).toBeGreaterThan(agentRunnerIdx);
  });

  it('resolves a skill view through the realized skill-backing path', async () => {
    const ag = await seed('ag-contract-skill', 'contract-skill-group');
    const sess = session('s1', ag.id);

    const { provider, contribution, surfaces } = await resolveProviderContribution(sess, ag, containerConfig());
    const mounts = await buildMounts(ag, sess, containerConfig(), provider, contribution, surfaces);

    const view = mounts.find((m) => m.containerPath === '/home/node/.contract/skills');
    expect(view).toMatchObject({ readonly: true, mountClass: 'group-state' });
    // The view mounts wherever its backing resolves to — here a state-volume
    // backing with an empty subdirectory, so the backing root IS the state
    // volume's own directory (its own '/skills' subdir is a separate detail
    // realize.ts creates but this mount doesn't target directly).
    expect(view!.hostPath).toBe(path.join(REAL_DATA_DIR, 'v2-sessions', ag.id, '.contract-home'));
    expect(fs.existsSync(path.join(view!.hostPath, 'skills'))).toBe(true);
  });

  it("drops the legacy provider's mounts once a contract exists, but keeps its env", async () => {
    const ag = await seed('ag-contract-legacy', 'contract-legacy-group');
    const sess = session('s1', ag.id);

    const { provider, contribution, surfaces } = await resolveProviderContribution(sess, ag, containerConfig());
    expect(contribution.env).toEqual({ FROM_LEGACY_OVERLAY: 'yes' });
    const mounts = await buildMounts(ag, sess, containerConfig(), provider, contribution, surfaces);

    expect(mounts.some((m) => m.containerPath === '/should-not-appear')).toBe(false);
  });

  it('composes a spec that passes real mount-policy admission end to end', async () => {
    const ag = await seed('ag-contract-policy', 'contract-policy-group');
    const sess = session('s1', ag.id);

    const { provider, contribution, surfaces } = await resolveProviderContribution(sess, ag, containerConfig());
    const mounts = await buildMounts(ag, sess, containerConfig(), provider, contribution, surfaces);
    const spec = specFrom(ag, mounts);

    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
  });

  it("throws when a contract declares legacyHostAdapter: 'required' with no legacy fn registered", async () => {
    registerProviderHostContract(LEGACY_ADAPTER_PROVIDER, {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      legacyHostAdapter: 'required',
    });
    const ag = await seed('ag-contract-adapter', 'contract-adapter-group');
    const sess = session('s1', ag.id, LEGACY_ADAPTER_PROVIDER);

    await expect(resolveProviderContribution(sess, ag, containerConfig())).rejects.toThrow(
      /host contract requires a legacy host adapter/,
    );
  });
});

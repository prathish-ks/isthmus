/**
 * `validateAdditionalMounts` (the operator-facing allowlist check) on the
 * REAL spawn-composition path — the seam gap the 2026-09-24 wiring audit
 * found alongside `mount-composition.test.ts`'s own headline case.
 *
 * `mount-composition.test.ts` proves `buildMounts`' structural mount
 * classing survives `validateSpec` end to end, but its shared
 * `containerConfig` fixture pins `additionalMounts: []` — every composition-
 * level test in this codebase does (`container-runner.test.ts` too). The
 * allowlist check itself (`validateAdditionalMounts`,
 * `modules/mount-security/index.ts`) is real and genuinely wired at
 * `container-runner.ts`'s `buildMounts` — confirmed by reading the call
 * site — but until this file, nothing had ever pushed a non-empty
 * `additionalMounts` array, allowlisted or not, through the real
 * `buildMounts` composition to confirm the check still fires there rather
 * than only in `mount-security/index.coverage.test.ts`'s isolated,
 * function-level calls. That is exactly the shape of gap ADR-024 found for
 * `dockerNetworkArgs`: a real, wired check, unit-tested directly, never
 * proven to fire on the actual end-to-end path.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ testDir: '', allowlistPath: '' }));

vi.mock('./project-doc-compose.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./project-doc-compose.js')>()),
  composeGroupProjectDoc: vi.fn(),
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('./config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return path.join(mockState.testDir, 'data');
    },
    get GROUPS_DIR() {
      return path.join(mockState.testDir, 'data', 'groups');
    },
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

import { buildMounts, toMountSpecs } from './container-runner.js';
import type { ContainerConfig } from './container-config.js';
import type { AgentGroup, Session } from './types.js';

const GROUP_ID = 'ag-additional-mounts';
const FOLDER = 'additional-mounts';
const SESSION_ID = 'sess-additional-mounts';

const agentGroup = { id: GROUP_ID, name: 'Additional Mounts', folder: FOLDER } as AgentGroup;
const session = { id: SESSION_ID, agent_group_id: GROUP_ID, agent_provider: null } as Session;

let tmpDir: string;
let groupDir: string;
let sessionDir: string;
let claudeShared: string;
let allowedHostDir: string;
let deniedHostDir: string;

function writeAllowlist(): void {
  fs.writeFileSync(
    mockState.allowlistPath,
    JSON.stringify(
      {
        allowedRoots: [{ path: allowedHostDir, allowReadWrite: false, description: 'test-allowed' }],
        blockedPatterns: [],
      },
      null,
      2,
    ) + '\n',
  );
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-additional-mounts-'));
  mockState.testDir = tmpDir;
  mockState.allowlistPath = path.join(tmpDir, 'mount-allowlist.json');

  groupDir = path.join(tmpDir, 'data', 'groups', FOLDER);
  sessionDir = path.join(tmpDir, 'data', 'v2-sessions', GROUP_ID, SESSION_ID);
  claudeShared = path.join(tmpDir, 'data', 'v2-sessions', GROUP_ID, '.claude-shared');
  allowedHostDir = path.join(tmpDir, 'operator-approved');
  deniedHostDir = path.join(tmpDir, 'not-approved');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(claudeShared, { recursive: true });
  fs.mkdirSync(path.join(groupDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(groupDir, 'container.json'), '{}');
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# composed\n');
  fs.mkdirSync(allowedHostDir, { recursive: true });
  fs.writeFileSync(path.join(allowedHostDir, 'marker.txt'), 'operator-approved\n');
  fs.mkdirSync(deniedHostDir, { recursive: true });
  fs.writeFileSync(path.join(deniedHostDir, 'marker.txt'), 'not-approved\n');

  writeAllowlist();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  writeAllowlist();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function containerConfigWith(additionalMounts: ContainerConfig['additionalMounts']): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts,
    skills: [],
  } as unknown as ContainerConfig;
}

describe('additional-mounts allowlist check, on the real buildMounts composition path', () => {
  it('includes an allowlisted operator mount and silently drops one outside every allowed root', async () => {
    const containerConfig = containerConfigWith([
      { hostPath: allowedHostDir, containerPath: 'approved', readonly: true },
      { hostPath: deniedHostDir, containerPath: 'sneaky', readonly: true },
    ]);

    const mounts = await buildMounts(agentGroup, session, containerConfig, 'claude', {});
    const extra = mounts.filter((m) => m.containerPath.startsWith('/workspace/extra/'));

    expect(extra.map((m) => m.hostPath)).toContain(fs.realpathSync(allowedHostDir));
    expect(extra.map((m) => m.hostPath)).not.toContain(fs.realpathSync(deniedHostDir));
    expect(extra.some((m) => m.containerPath === '/workspace/extra/approved')).toBe(true);
    expect(extra.some((m) => m.containerPath === '/workspace/extra/sneaky')).toBe(false);
  });

  it('drops every additional mount when no allowlist file exists at all', async () => {
    fs.rmSync(mockState.allowlistPath, { force: true });

    const containerConfig = containerConfigWith([
      { hostPath: allowedHostDir, containerPath: 'approved', readonly: true },
    ]);

    const mounts = await buildMounts(agentGroup, session, containerConfig, 'claude', {});
    const extra = mounts.filter((m) => m.containerPath.startsWith('/workspace/extra/'));
    expect(extra).toHaveLength(0);
  });

  it('an allowlisted mount survives into a real, validated SessionSpec', async () => {
    const { GROUP_FOLDER_LABEL, validateSpec } = await import('./drivers/types.js');
    const { mountPolicy } = await import('./drivers/index.js');
    const { INSTALL_SLUG } = await import('./config.js');

    const containerConfig = containerConfigWith([
      { hostPath: allowedHostDir, containerPath: 'approved', readonly: true },
    ]);
    const mounts = await buildMounts(agentGroup, session, containerConfig, 'claude', {});
    const spec = {
      key: { installSlug: INSTALL_SLUG, agentGroupId: GROUP_ID, sessionId: SESSION_ID },
      labels: { [GROUP_FOLDER_LABEL]: FOLDER },
      containers: [
        { role: 'agent' as const, image: 'nanoclaw-agent:test', env: {}, mounts: toMountSpecs(mounts, GROUP_ID) },
      ],
      network: 'shared-private' as const,
      hardening: 'standard' as const,
      resources: {},
      runtimeTier: 'container' as const,
      stopGraceSeconds: 1,
    };

    expect(() => validateSpec(spec, mountPolicy())).not.toThrow();
    const allowlisted = spec.containers[0].mounts.find((m) => m.containerPath === '/workspace/extra/approved');
    expect(allowlisted?.class).toBe('allowlisted-extra');
  });
});

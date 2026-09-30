import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let DATA_DIR: string;

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return DATA_DIR;
  },
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from '../log.js';
import { registerProviderFileTransformer } from './file-transformers.js';
import {
  initializeProviderGroupSurfaces,
  providerProjectDocSpec,
  providerStateVolumePath,
  realizeProviderSpawnSurfaces,
  syncSharedSkillLinks,
} from './realize.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  type ProviderHostContract,
  type ProviderStateVolume,
} from './registry.js';

const AG = 'ag-realize-test';
const PROVIDER = 'test-provider';

const GROUP_VOLUME: ProviderStateVolume = {
  id: 'home',
  directory: '.test-shared',
  containerPath: '/home/node/.test',
  scope: 'group',
  mode: 'rw',
  mountClass: 'group-state',
};

const SESSION_VOLUME: ProviderStateVolume = {
  id: 'session-scratch',
  directory: '.test-session',
  containerPath: '/home/node/.test-session',
  scope: 'session',
  mode: 'rw',
  mountClass: 'group-state',
};

let root: string;
let groupDir: string;
let sessionDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-realize-test-'));
  DATA_DIR = path.join(root, 'data');
  fs.mkdirSync(path.join(DATA_DIR, 'v2-sessions', AG), { recursive: true });
  groupDir = path.join(root, 'groups', 'test-group');
  fs.mkdirSync(groupDir, { recursive: true });
  sessionDir = path.join(root, 'session');
  fs.mkdirSync(sessionDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('providerStateVolumePath', () => {
  it('resolves a group-scoped volume under DATA_DIR/v2-sessions/<agentGroupId>', () => {
    expect(providerStateVolumePath(GROUP_VOLUME, AG)).toBe(path.join(DATA_DIR, 'v2-sessions', AG, '.test-shared'));
  });

  it('resolves a session-scoped volume under the given session directory', () => {
    expect(providerStateVolumePath(SESSION_VOLUME, AG, sessionDir)).toBe(path.join(sessionDir, '.test-session'));
  });

  it('throws for a session-scoped volume with no session directory', () => {
    expect(() => providerStateVolumePath(SESSION_VOLUME, AG)).toThrow(/Session directory required/);
  });
});

describe('path-escape rejection (security-critical)', () => {
  it('initializeProviderGroupSurfaces rejects a directory field that escapes the volume root', () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [{ ...GROUP_VOLUME, directory: '../../etc' }],
    };
    expect(() => initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir)).toThrow(
      /Provider contract path escapes its resolved root/,
    );
  });

  it('initializeProviderGroupSurfaces rejects a prepared file relativePath that escapes the volume', () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [GROUP_VOLUME],
      files: [
        {
          id: 'escape',
          volumeId: 'home',
          // registry.ts's own shape validation would already reject this at
          // registration time — this proves realize.ts independently refuses
          // it too, at the filesystem boundary, if it ever got this far.
          relativePath: '..',
          prepare: { operation: 'create-if-missing', when: 'group-init', content: 'x' },
        },
      ],
    };
    expect(() => initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir)).toThrow(
      /Provider contract path escapes its resolved root/,
    );
  });
});

describe('initializeProviderGroupSurfaces', () => {
  it('creates a group-scoped state volume directory, reports it as newly initialized', () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [GROUP_VOLUME],
    };

    const initialized = initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir);

    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', AG, '.test-shared'))).toBe(true);
    expect(initialized).toContain('.test-shared');
  });

  it('does not create a session-scoped volume at group-init time', () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [SESSION_VOLUME],
    };

    expect(() => initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir)).not.toThrow();
    expect(fs.existsSync(path.join(sessionDir, '.test-session'))).toBe(false);
  });

  it('writes a create-if-missing file once, does not overwrite it on a second pass', () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [GROUP_VOLUME],
      files: [
        {
          id: 'settings',
          volumeId: 'home',
          relativePath: 'settings.json',
          prepare: { operation: 'create-if-missing', when: 'group-init', content: '{"default":true}' },
        },
      ],
    };
    const filePath = path.join(DATA_DIR, 'v2-sessions', AG, '.test-shared', 'settings.json');

    const first = initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"default":true}');
    expect(first).toContain('settings.json');

    fs.writeFileSync(filePath, '{"user":"edited"}');
    const second = initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"user":"edited"}');
    expect(second).not.toContain('settings.json');
  });

  it('reconciles an existing file through its named transformer', () => {
    registerProviderFileTransformer('realize-test-transformer', {
      transform: (current) => ({ kind: 'replace', content: `${current}\nreconciled` }),
      mapIoFailure: (err) => ({ level: 'error', message: String(err) }),
    });
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [GROUP_VOLUME],
      files: [
        {
          id: 'settings',
          volumeId: 'home',
          relativePath: 'settings.json',
          prepare: { operation: 'create-if-missing', when: 'group-init', content: 'original' },
          reconcile: { transformer: 'realize-test-transformer' },
        },
      ],
    };
    const filePath = path.join(DATA_DIR, 'v2-sessions', AG, '.test-shared', 'settings.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'original');

    const initialized = initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir);

    expect(fs.readFileSync(filePath, 'utf-8')).toBe('original\nreconciled');
    expect(initialized.some((entry) => entry.includes('reconciled'))).toBe(true);
  });

  it('creates a group-directory skill backing directory', () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      skillBackings: [
        {
          id: 'skills',
          location: { kind: 'group-directory', directory: '.provider-skills', subdirectory: '' },
          skillsSubdirectory: 'skills',
          conflictDiagnostics: 'warn',
          templateCopies: 'in-place',
        },
      ],
    };

    initializeProviderGroupSurfaces(PROVIDER, contract, AG, groupDir);

    expect(fs.existsSync(path.join(groupDir, '.provider-skills', 'skills'))).toBe(true);
  });
});

describe('realizeProviderSpawnSurfaces', () => {
  it('creates the state volume directory and an append-open-close file, without truncating existing content', async () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [SESSION_VOLUME],
      files: [
        {
          id: 'log',
          volumeId: 'session-scratch',
          relativePath: 'activity.log',
          prepare: { operation: 'append-open-close', when: 'every-spawn' },
        },
      ],
    };
    const filePath = path.join(sessionDir, '.test-session', 'activity.log');
    const composeProjectDocument = vi.fn().mockResolvedValue(undefined);
    const legacyOverlay = vi.fn().mockResolvedValue({});

    await realizeProviderSpawnSurfaces(PROVIDER, contract, AG, groupDir, sessionDir, [], {
      legacyOverlay,
      composeProjectDocument,
    });

    expect(fs.existsSync(filePath)).toBe(true);

    fs.writeFileSync(filePath, 'PRESERVED\n', { flag: 'a' });
    await realizeProviderSpawnSurfaces(PROVIDER, contract, AG, groupDir, sessionDir, [], {
      legacyOverlay,
      composeProjectDocument,
    });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('PRESERVED\n');
  });

  it('calls composeProjectDocument with the contract-derived spec', async () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: {
        fileName: 'CUSTOM.md',
        containerPath: '/app/CUSTOM.md',
        mountClass: 'group-state',
        maxBytes: 1024,
      },
    };
    const composeProjectDocument = vi.fn().mockResolvedValue(undefined);

    await realizeProviderSpawnSurfaces(PROVIDER, contract, AG, groupDir, sessionDir, [], {
      legacyOverlay: vi.fn().mockResolvedValue({}),
      composeProjectDocument,
    });

    expect(composeProjectDocument).toHaveBeenCalledWith({ fileName: 'CUSTOM.md', maxBytes: 1024 });
  });

  it('does not call composeProjectDocument when the contract declares no project document', async () => {
    // Realizable via the mount-surface invariant only when nothing else is
    // declared either — a degenerate but legal contract for this function's
    // own unit-level contract (registry.ts enforces the full invariant).
    const contract: ProviderHostContract = { seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION };
    const composeProjectDocument = vi.fn().mockResolvedValue(undefined);

    await realizeProviderSpawnSurfaces(PROVIDER, contract, AG, groupDir, sessionDir, [], {
      legacyOverlay: vi.fn().mockResolvedValue({}),
      composeProjectDocument,
    });

    expect(composeProjectDocument).not.toHaveBeenCalled();
  });

  it('resolves skillBackingPaths for every declared skill backing', async () => {
    const contract: ProviderHostContract = {
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: { fileName: 'X.md', containerPath: '/app/X.md', mountClass: 'group-state' },
      stateVolumes: [GROUP_VOLUME],
      skillBackings: [
        {
          id: 'skills',
          location: { kind: 'state-volume', volumeId: 'home', subdirectory: '' },
          skillsSubdirectory: 'skills',
          conflictDiagnostics: 'silent',
          templateCopies: 'in-place',
        },
      ],
    };

    const result = await realizeProviderSpawnSurfaces(PROVIDER, contract, AG, groupDir, sessionDir, [], {
      legacyOverlay: vi.fn().mockResolvedValue({}),
      composeProjectDocument: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.skillBackingPaths.get('skills')).toBe(path.join(DATA_DIR, 'v2-sessions', AG, '.test-shared'));
    expect(fs.existsSync(path.join(DATA_DIR, 'v2-sessions', AG, '.test-shared', 'skills'))).toBe(true);
  });

  it("passes through the legacy adapter's env but drops its mounts", async () => {
    const contract: ProviderHostContract = { seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION };
    const legacyOverlay = vi
      .fn()
      .mockResolvedValue({ env: { FOO: 'bar' }, mounts: [{ hostPath: '/x', containerPath: '/y' }] });

    const result = await realizeProviderSpawnSurfaces(PROVIDER, contract, AG, groupDir, sessionDir, [], {
      legacyOverlay,
      composeProjectDocument: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.contribution).toEqual({ env: { FOO: 'bar' } });
  });
});

describe('providerProjectDocSpec', () => {
  it('is undefined when the contract declares no project document', () => {
    expect(providerProjectDocSpec({ seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION })).toBeUndefined();
  });

  it('carries fileName, instructions and maxBytes when declared', () => {
    const spec = providerProjectDocSpec({
      seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
      projectDocument: {
        fileName: 'X.md',
        containerPath: '/app/X.md',
        mountClass: 'group-state',
        instructions: { nativeOverrideFiles: ['AGENTS.md'] },
        maxBytes: 2048,
      },
    });
    expect(spec).toEqual({ fileName: 'X.md', instructions: { nativeOverrideFiles: ['AGENTS.md'] }, maxBytes: 2048 });
  });
});

describe('syncSharedSkillLinks', () => {
  it('adds a symlink for each desired skill, removes a stale one', () => {
    const dir = path.join(root, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync('/app/skills/stale', path.join(dir, 'stale'));

    syncSharedSkillLinks(dir, ['keep'], true);

    expect(fs.existsSync(path.join(dir, 'stale'))).toBe(false);
    expect(fs.lstatSync(path.join(dir, 'keep')).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path.join(dir, 'keep'))).toBe('/app/skills/keep');
  });

  it('warns (does not throw or overwrite) when a real entry occupies a desired skill name, only if warnOnConflict', () => {
    const dir = path.join(root, 'skills-conflict');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'real-dir'));

    syncSharedSkillLinks(dir, ['real-dir'], true);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(fs.lstatSync(path.join(dir, 'real-dir')).isSymbolicLink()).toBe(false);

    vi.clearAllMocks();
    syncSharedSkillLinks(dir, ['real-dir'], false);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

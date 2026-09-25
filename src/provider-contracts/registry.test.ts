import { afterEach, describe, expect, it } from 'vitest';

import {
  assertProviderHostConformance,
  assertProviderHostContractShape,
  getProviderHostContract,
  getProviderModelEndpoint,
  hasProviderMountSurface,
  listProviderHostContractNames,
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  providerModelAllowedHosts,
  registerProviderHostContract,
  resetProviderHostContractForTesting,
  type ProviderHostContract,
  type ProviderPreparedFile,
  type ProviderSkillBacking,
  type ProviderSkillView,
  type ProviderStateVolume,
} from './registry.js';

const TEST_PROVIDER = 'test-provider';

afterEach(() => {
  resetProviderHostContractForTesting(TEST_PROVIDER);
});

function register(contract: ProviderHostContract): void {
  registerProviderHostContract(TEST_PROVIDER, contract);
}

const MODEL_ONLY: ProviderHostContract = {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  modelDomains: ['example.com'],
  modelEndpoints: { api: 'https://api.example.com' },
};

const VOLUME: ProviderStateVolume = {
  id: 'home',
  directory: '.provider-shared',
  containerPath: '/home/node/.provider',
  scope: 'group',
  mode: 'rw',
  mountClass: 'group-state',
};

const BACKING: ProviderSkillBacking = {
  id: 'skills',
  location: { kind: 'state-volume', volumeId: 'home', subdirectory: '' },
  skillsSubdirectory: 'skills',
  conflictDiagnostics: 'warn',
  templateCopies: 'in-place',
};

const VIEW: ProviderSkillView = {
  backingId: 'skills',
  containerPath: '/home/node/.provider/skills',
  mode: 'ro',
  mountClass: 'group-state',
};

const FILE: ProviderPreparedFile = {
  id: 'settings',
  volumeId: 'home',
  relativePath: 'settings.json',
  prepare: { operation: 'create-if-missing', when: 'group-init', content: '{}' },
};

function fullContract(overrides: Partial<ProviderHostContract> = {}): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: { fileName: 'CLAUDE.md', containerPath: '/app/CLAUDE.md', mountClass: 'group-state' },
    stateVolumes: [VOLUME],
    skillBackings: [BACKING],
    skillViews: [VIEW],
    files: [FILE],
    ...overrides,
  };
}

describe('registration', () => {
  it('registers and retrieves by name, case-insensitively', () => {
    register(MODEL_ONLY);
    expect(getProviderHostContract(TEST_PROVIDER)).toMatchObject({ modelDomains: ['example.com'] });
    expect(getProviderHostContract(TEST_PROVIDER.toUpperCase())).toMatchObject({ modelDomains: ['example.com'] });
    expect(listProviderHostContractNames()).toContain(TEST_PROVIDER);
  });

  it('rejects a non-kebab-case name', () => {
    expect(() => registerProviderHostContract('Test_Provider', MODEL_ONLY)).toThrow(/lowercase kebab-case/);
  });

  it('rejects a duplicate registration', () => {
    register(MODEL_ONLY);
    expect(() => register(MODEL_ONLY)).toThrow(/already registered/);
  });

  it('returns undefined for an unregistered or null/undefined name', () => {
    expect(getProviderHostContract('nobody')).toBeUndefined();
    expect(getProviderHostContract(null)).toBeUndefined();
    expect(getProviderHostContract(undefined)).toBeUndefined();
  });

  it('freezes the stored contract, including nested arrays', () => {
    register(fullContract());
    const stored = getProviderHostContract(TEST_PROVIDER)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.stateVolumes)).toBe(true);
    expect(Object.isFrozen(stored.stateVolumes![0])).toBe(true);
  });
});

describe('seamVersion', () => {
  it('rejects a mismatched seam version', () => {
    expect(() => register({ ...MODEL_ONLY, seamVersion: 999 })).toThrow(/incompatible with host seam/);
  });
});

describe('model domains and endpoints', () => {
  it('getProviderModelEndpoint reads a declared endpoint, throws for an undeclared one', () => {
    register(MODEL_ONLY);
    expect(getProviderModelEndpoint(TEST_PROVIDER, 'api')).toBe('https://api.example.com');
    expect(() => getProviderModelEndpoint(TEST_PROVIDER, 'subscription')).toThrow(/does not declare/);
  });

  it('providerModelAllowedHosts includes the wildcard subdomain form, deduped and sorted', () => {
    register(MODEL_ONLY);
    expect(providerModelAllowedHosts()).toEqual(['*.example.com', 'example.com']);
  });

  it('rejects an uppercase or malformed domain', () => {
    expect(() => register({ ...MODEL_ONLY, modelDomains: ['Example.com'] })).toThrow(/lowercase DNS domains/);
    expect(() => register({ ...MODEL_ONLY, modelDomains: ['not a domain'] })).toThrow(/lowercase DNS domains/);
  });

  it('rejects an endpoint outside the declared model domains', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'https://api.other.com' } })).toThrow(
      /within declared modelDomains/,
    );
  });

  it('rejects a non-HTTPS or credentialed endpoint URL', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'http://api.example.com' } })).toThrow(
      /within declared modelDomains/,
    );
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'https://user:pass@api.example.com' } })).toThrow(
      /within declared modelDomains/,
    );
  });
});

// The Isthmus-specific relaxation this widening introduces: see registry.ts's
// own header. A contract declaring no mount/file surface at all is valid
// (Isthmus's own claude.ts, as shipped in Workstream C8) — but any mount/file
// field present at all commits the contract to the FULL shape, projectDocument
// included, matching upstream exactly from that point on.
describe('mount-surface invariant (Isthmus divergence)', () => {
  it('accepts a contract with no mount/file surface at all', () => {
    expect(() => register(MODEL_ONLY)).not.toThrow();
    expect(hasProviderMountSurface(TEST_PROVIDER)).toBe(false);
  });

  it('accepts a fully-declared contract and marks it as having a mount surface', () => {
    expect(() => register(fullContract())).not.toThrow();
    expect(hasProviderMountSurface(TEST_PROVIDER)).toBe(true);
  });

  it('rejects a stateVolume declared with no projectDocument', () => {
    expect(() => register({ ...MODEL_ONLY, stateVolumes: [VOLUME] })).toThrow(
      /projectDocument is required once any mount\/file surface is declared/,
    );
  });

  it('rejects a skillBacking declared with no projectDocument', () => {
    expect(() => register({ ...MODEL_ONLY, skillBackings: [BACKING] })).toThrow(/projectDocument is required/);
  });

  it('rejects a skillView declared with no projectDocument', () => {
    expect(() => register({ ...MODEL_ONLY, skillViews: [VIEW] })).toThrow(/projectDocument is required/);
  });

  it('rejects a prepared file declared with no projectDocument', () => {
    expect(() => register({ ...MODEL_ONLY, files: [FILE] })).toThrow(/projectDocument is required/);
  });
});

describe('full contract shape validation', () => {
  it('accepts the complete valid shape', () => {
    expect(() => register(fullContract())).not.toThrow();
  });

  it('rejects a non-canonical (absolute-looking / traversal) container path', () => {
    expect(() =>
      register(
        fullContract({ projectDocument: { fileName: 'x', containerPath: 'relative', mountClass: 'group-state' } }),
      ),
    ).toThrow(/canonical absolute container path/);
    expect(() =>
      register(
        fullContract({
          stateVolumes: [{ ...VOLUME, containerPath: '/home/node/../etc' }],
        }),
      ),
    ).toThrow(/canonical absolute container path/);
  });

  it('rejects a bad mountClass on any mount-bearing field', () => {
    expect(() =>
      register(fullContract({ stateVolumes: [{ ...VOLUME, mountClass: 'gateway-trust' as never }] })),
    ).toThrow(/must be one of/);
    expect(() =>
      register(fullContract({ skillViews: [{ ...VIEW, mountClass: 'identity-material' as never }] })),
    ).toThrow(/must be one of/);
  });

  it('rejects duplicate stateVolume ids', () => {
    expect(() => register(fullContract({ stateVolumes: [VOLUME, VOLUME] }))).toThrow(/must be unique/);
  });

  it('rejects duplicate skillBacking ids', () => {
    expect(() => register(fullContract({ skillBackings: [BACKING, BACKING] }))).toThrow(/must be unique/);
  });

  it('rejects duplicate file ids', () => {
    expect(() => register(fullContract({ files: [FILE, FILE] }))).toThrow(/must be unique/);
  });

  it('rejects a skillBacking referencing an unknown state-volume id', () => {
    expect(() =>
      register(
        fullContract({
          skillBackings: [
            { ...BACKING, location: { kind: 'state-volume', volumeId: 'nonexistent', subdirectory: '' } },
          ],
        }),
      ),
    ).toThrow(/references unknown 'nonexistent'/);
  });

  it('rejects a skillView referencing an unknown backing id', () => {
    expect(() => register(fullContract({ skillViews: [{ ...VIEW, backingId: 'nonexistent' }] }))).toThrow(
      /references unknown 'nonexistent'/,
    );
  });

  it('rejects a file referencing an unknown volume id', () => {
    expect(() => register(fullContract({ files: [{ ...FILE, volumeId: 'nonexistent' }] }))).toThrow(
      /references unknown 'nonexistent'/,
    );
  });

  it('rejects a relative-path traversal attempt in a file or skill-backing subdirectory', () => {
    expect(() => register(fullContract({ files: [{ ...FILE, relativePath: '../../etc/passwd' }] }))).toThrow(
      /canonical relative path/,
    );
    expect(() =>
      register(
        fullContract({
          skillBackings: [
            { ...BACKING, location: { kind: 'state-volume', volumeId: 'home', subdirectory: '../escape' } },
          ],
        }),
      ),
    ).toThrow(/canonical relative path/);
  });

  it('rejects a create-if-missing file targeting a session-scoped volume', () => {
    expect(() =>
      register(
        fullContract({
          stateVolumes: [{ ...VOLUME, scope: 'session' }],
        }),
      ),
    ).toThrow(/cannot initialize session volume/);
  });

  it('rejects an append-open-close file that also declares reconcile', () => {
    expect(() =>
      register(
        fullContract({
          files: [
            {
              id: 'log',
              volumeId: 'home',
              relativePath: 'x.log',
              prepare: { operation: 'append-open-close', when: 'every-spawn' },
              reconcile: { transformer: 'whatever' },
            },
          ],
        }),
      ),
    ).toThrow(/reconcile must be omitted for append-open-close/);
  });

  it('rejects two mount-bearing fields that collide on the same container destination', () => {
    expect(() =>
      register(
        fullContract({
          skillViews: [{ ...VIEW, containerPath: '/home/node/.provider' }], // same as VOLUME's containerPath
        }),
      ),
    ).toThrow(/container destinations.*must be unique/);
  });
});

describe('assertProviderHostConformance', () => {
  it('passes for a contract with no file transformer references', () => {
    register(fullContract());
    expect(() => assertProviderHostConformance()).not.toThrow();
  });

  it('throws when a file names an unregistered transformer', () => {
    register(
      fullContract({
        files: [{ ...FILE, reconcile: { transformer: 'nonexistent-transformer' } }],
      }),
    );
    expect(() => assertProviderHostConformance()).toThrow(/unregistered file transformer 'nonexistent-transformer'/);
  });
});

describe('assertProviderHostContractShape as a standalone check', () => {
  it('can be called directly without registering', () => {
    expect(() => assertProviderHostContractShape('standalone', MODEL_ONLY)).not.toThrow();
    expect(getProviderHostContract('standalone')).toBeUndefined();
  });
});

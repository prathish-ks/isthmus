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

const PROJECT_DOCUMENT: ProviderHostContract['projectDocument'] = {
  fileName: 'CLAUDE.md',
  containerPath: '/app/CLAUDE.md',
  mountClass: 'group-state',
};

const VALID_NATIVE_SKILLS = {
  discoveryPath: '/home/node/.provider/skills',
  sharedSource: '/workspace/skills',
  selfAuthoredHome: '~/.provider/skills',
  persistentRoots: ['/home/node/.provider'],
};

function fullContract(overrides: Partial<ProviderHostContract> = {}): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: PROJECT_DOCUMENT,
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

describe('assertProviderHostConformance additional branches', () => {
  it('throws when legacyHostAdapter is required but no legacy host adapter is registered', () => {
    register({ ...MODEL_ONLY, legacyHostAdapter: 'required' });
    expect(() => assertProviderHostConformance()).toThrow(/requires a legacy host adapter/);
  });
});

describe('modelEndpoints shape validation', () => {
  it('rejects a null modelEndpoints', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: null as never })).toThrow(
      /modelEndpoints must be an object/,
    );
  });

  it('rejects an array modelEndpoints', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: [] as never })).toThrow(/modelEndpoints must be an object/);
  });

  it('rejects an endpoint with an unrecognized kind key', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { bogus: 'https://api.example.com' } as never })).toThrow(
      /contains an invalid endpoint/,
    );
  });

  it('rejects an endpoint whose value is not a string', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 123 as never } })).toThrow(
      /contains an invalid endpoint/,
    );
  });

  it('rejects an endpoint URL carrying a hash fragment', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'https://api.example.com#frag' } })).toThrow(
      /within declared modelDomains/,
    );
  });

  it('rejects an endpoint URL carrying a search query', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'https://api.example.com?x=1' } })).toThrow(
      /within declared modelDomains/,
    );
  });

  it('rejects an endpoint URL carrying a non-default port', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'https://api.example.com:8443' } })).toThrow(
      /within declared modelDomains/,
    );
  });

  it('rejects an endpoint URL with a password but no username', () => {
    expect(() => register({ ...MODEL_ONLY, modelEndpoints: { api: 'https://:secret@api.example.com' } })).toThrow(
      /within declared modelDomains/,
    );
  });

  it('accepts an endpoint hostname exactly equal to a declared modelDomain', () => {
    expect(() =>
      register({ ...MODEL_ONLY, modelDomains: ['example.com'], modelEndpoints: { api: 'https://example.com' } }),
    ).not.toThrow();
  });
});

describe('inference validation', () => {
  it('rejects a null inference declaration', () => {
    expect(() => register({ ...MODEL_ONLY, inference: null as never })).toThrow(/inference must be an object/);
  });

  it('rejects a non-object inference declaration', () => {
    expect(() => register({ ...MODEL_ONLY, inference: 'fast' as never })).toThrow(/inference must be an object/);
  });

  it('rejects a non-array speedTiers', () => {
    expect(() => register({ ...MODEL_ONLY, inference: { speedTiers: 'fast' as never } })).toThrow(
      /inference\.speedTiers must be an array/,
    );
  });

  it('rejects an empty speedTiers array', () => {
    expect(() => register({ ...MODEL_ONLY, inference: { speedTiers: [] } })).toThrow(
      /inference\.speedTiers must not be empty/,
    );
  });

  it('rejects a non-kebab-case speed tier name', () => {
    expect(() => register({ ...MODEL_ONLY, inference: { speedTiers: ['Fast Mode'] } })).toThrow(/lowercase kebab-case/);
  });

  it('rejects duplicate speed tiers', () => {
    expect(() => register({ ...MODEL_ONLY, inference: { speedTiers: ['fast', 'fast'] } })).toThrow(
      /inference\.speedTiers must be unique/,
    );
  });
});

describe('projectDocument shape validation additional branches', () => {
  it('rejects a null projectDocument', () => {
    expect(() => register(fullContract({ projectDocument: null as never }))).toThrow(
      /projectDocument must be an object/,
    );
  });

  it('rejects an invalid projectDocument.fileName', () => {
    expect(() => register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, fileName: 'a/b' } }))).toThrow(
      /must be one file or directory name/,
    );
  });

  it('rejects an invalid projectDocument.mountClass', () => {
    expect(() =>
      register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, mountClass: 'bogus' as never } })),
    ).toThrow(/must be one of/);
  });

  it('rejects a non-integer maxBytes', () => {
    expect(() => register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, maxBytes: 1.5 } }))).toThrow(
      /maxBytes must be a positive integer/,
    );
  });

  it('rejects a non-positive maxBytes', () => {
    expect(() => register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, maxBytes: 0 } }))).toThrow(
      /maxBytes must be a positive integer/,
    );
  });

  it('accepts a valid maxBytes', () => {
    expect(() => register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, maxBytes: 4096 } }))).not.toThrow();
  });
});

describe('projectDocument.instructions validation', () => {
  it('rejects a non-object instructions', () => {
    expect(() =>
      register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, instructions: 'bad' as never } })),
    ).toThrow(/instructions must be an object/);
  });

  it('rejects an empty nativeOverrideFiles array', () => {
    expect(() =>
      register(fullContract({ projectDocument: { ...PROJECT_DOCUMENT, instructions: { nativeOverrideFiles: [] } } })),
    ).toThrow(/nativeOverrideFiles must be a non-empty array/);
  });

  it('rejects an invalid nativeOverrideFiles entry', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: { ...PROJECT_DOCUMENT, instructions: { nativeOverrideFiles: ['a/b'] } },
        }),
      ),
    ).toThrow(/must be one file or directory name/);
  });

  it('rejects a non-object nativeSkills', () => {
    expect(() =>
      register(
        fullContract({ projectDocument: { ...PROJECT_DOCUMENT, instructions: { nativeSkills: 'bad' as never } } }),
      ),
    ).toThrow(/nativeSkills must be an object/);
  });

  it('rejects an invalid nativeSkills.discoveryPath', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: {
            ...PROJECT_DOCUMENT,
            instructions: { nativeSkills: { ...VALID_NATIVE_SKILLS, discoveryPath: 'relative' } },
          },
        }),
      ),
    ).toThrow(/canonical absolute container path/);
  });

  it('rejects an invalid nativeSkills.sharedSource', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: {
            ...PROJECT_DOCUMENT,
            instructions: { nativeSkills: { ...VALID_NATIVE_SKILLS, sharedSource: 'relative' } },
          },
        }),
      ),
    ).toThrow(/canonical absolute container path/);
  });

  it('rejects an empty nativeSkills.selfAuthoredHome', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: {
            ...PROJECT_DOCUMENT,
            instructions: { nativeSkills: { ...VALID_NATIVE_SKILLS, selfAuthoredHome: '' } },
          },
        }),
      ),
    ).toThrow(/selfAuthoredHome must be a non-empty string/);
  });

  it('rejects an empty nativeSkills.persistentRoots array', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: {
            ...PROJECT_DOCUMENT,
            instructions: { nativeSkills: { ...VALID_NATIVE_SKILLS, persistentRoots: [] } },
          },
        }),
      ),
    ).toThrow(/persistentRoots must be a non-empty array/);
  });

  it('rejects an empty entry in nativeSkills.persistentRoots', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: {
            ...PROJECT_DOCUMENT,
            instructions: { nativeSkills: { ...VALID_NATIVE_SKILLS, persistentRoots: [''] } },
          },
        }),
      ),
    ).toThrow(/persistentRoots\[\] must be a non-empty string/);
  });

  it('accepts a fully-declared valid instructions block', () => {
    expect(() =>
      register(
        fullContract({
          projectDocument: {
            ...PROJECT_DOCUMENT,
            instructions: {
              nativeOverrideFiles: ['NOTES.md'],
              nativeSkills: VALID_NATIVE_SKILLS,
            },
          },
        }),
      ),
    ).not.toThrow();
  });
});

describe('commands validation', () => {
  it('rejects a non-array commands.nativeAdmin', () => {
    expect(() => register({ ...MODEL_ONLY, commands: { nativeAdmin: 'bad' as never } })).toThrow(
      /commands\.nativeAdmin must be an array/,
    );
  });

  it('rejects a non-array commands.nativeFiltered', () => {
    expect(() => register({ ...MODEL_ONLY, commands: { nativeFiltered: 'bad' as never } })).toThrow(
      /commands\.nativeFiltered must be an array/,
    );
  });

  it('rejects an invalid command string', () => {
    expect(() => register({ ...MODEL_ONLY, commands: { nativeAdmin: ['no-leading-slash'] } })).toThrow(
      /contains invalid command/,
    );
    expect(() => register({ ...MODEL_ONLY, commands: { nativeAdmin: ['/Upper'] } })).toThrow(
      /contains invalid command/,
    );
  });

  it('rejects duplicate commands', () => {
    expect(() => register({ ...MODEL_ONLY, commands: { nativeAdmin: ['/foo', '/foo'] } })).toThrow(
      /commands\.nativeAdmin must be unique/,
    );
  });
});

describe('id/name kebab-case validation on mount-bearing fields', () => {
  it('rejects an invalid stateVolume id', () => {
    expect(() => register(fullContract({ stateVolumes: [{ ...VOLUME, id: 'Bad_Id' }] }))).toThrow(
      /lowercase kebab-case/,
    );
  });

  it('rejects an invalid skillBacking id', () => {
    expect(() => register(fullContract({ skillBackings: [{ ...BACKING, id: 'Bad_Id' }] }))).toThrow(
      /lowercase kebab-case/,
    );
  });

  it('rejects an invalid file id', () => {
    expect(() => register(fullContract({ files: [{ ...FILE, id: 'Bad_Id' }] }))).toThrow(/lowercase kebab-case/);
  });

  it('rejects an invalid file.reconcile.transformer name', () => {
    expect(() =>
      register(fullContract({ files: [{ ...FILE, reconcile: { transformer: 'Bad_Transformer' } }] })),
    ).toThrow(/lowercase kebab-case/);
  });

  it('rejects an invalid file.reconcile.transformerProvider name', () => {
    expect(() =>
      register(
        fullContract({
          files: [{ ...FILE, reconcile: { transformer: 'good-transformer', transformerProvider: 'Bad_Provider' } }],
        }),
      ),
    ).toThrow(/lowercase kebab-case/);
  });
});

describe('assertRelativePath / assertContainerPath additional branches', () => {
  it('rejects an empty skillsSubdirectory (not allowed empty)', () => {
    expect(() => register(fullContract({ skillBackings: [{ ...BACKING, skillsSubdirectory: '' }] }))).toThrow(
      /canonical relative path/,
    );
  });

  it('rejects a trailing-slash container path', () => {
    expect(() =>
      register(fullContract({ stateVolumes: [{ ...VOLUME, containerPath: '/home/node/.provider/' }] })),
    ).toThrow(/canonical absolute container path/);
  });
});

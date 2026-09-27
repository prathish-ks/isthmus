import { describe, expect, it } from 'vitest';
import {
  describeRegisteredProviderFileTransformers,
  getProviderFileTransformer,
  listProviderFileTransformerNames,
  registerProviderFileTransformer,
  type ProviderFileTransformer,
} from './file-transformers.js';

const NOOP: ProviderFileTransformer = {
  transform: () => ({ kind: 'unchanged' }),
  mapIoFailure: (error, filePath) => ({ level: 'error', message: `${filePath}: ${String(error)}` }),
};

// Must run before any registration in this file — this module's transformer
// map is process-global with no reset hook, so the empty-registry branch can
// only be observed while nothing has been registered yet.
describe('describeRegisteredProviderFileTransformers with nothing registered', () => {
  it("returns the '(none)' placeholder, not an empty string", () => {
    expect(listProviderFileTransformerNames()).toEqual([]);
    expect(describeRegisteredProviderFileTransformers()).toBe('(none)');
  });
});

describe('registerProviderFileTransformer', () => {
  it('registers and retrieves a transformer by name', () => {
    const name = `test-transformer-${Math.random().toString(36).slice(2)}`;
    registerProviderFileTransformer(name, NOOP);
    expect(getProviderFileTransformer(name)).toBe(NOOP);
    expect(listProviderFileTransformerNames()).toContain(name);
  });

  it('rejects a non-string name', () => {
    expect(() => registerProviderFileTransformer(123 as never, NOOP)).toThrow(/lowercase kebab-case/);
  });

  it('rejects a name that is not lowercase kebab-case', () => {
    expect(() => registerProviderFileTransformer('Bad_Name', NOOP)).toThrow(/lowercase kebab-case/);
  });

  it('rejects a duplicate registration', () => {
    const name = `test-dup-${Math.random().toString(36).slice(2)}`;
    registerProviderFileTransformer(name, NOOP);
    expect(() => registerProviderFileTransformer(name, NOOP)).toThrow(/already registered/);
  });
});

describe('getProviderFileTransformer', () => {
  it('returns undefined for an unregistered name', () => {
    expect(getProviderFileTransformer('nonexistent-transformer')).toBeUndefined();
  });
});

describe('describeRegisteredProviderFileTransformers', () => {
  it('lists registered names, comma-joined', () => {
    const a = `test-list-a-${Math.random().toString(36).slice(2)}`;
    const b = `test-list-b-${Math.random().toString(36).slice(2)}`;
    registerProviderFileTransformer(a, NOOP);
    registerProviderFileTransformer(b, NOOP);
    const described = describeRegisteredProviderFileTransformers();
    expect(described).toContain(a);
    expect(described).toContain(b);
  });
});

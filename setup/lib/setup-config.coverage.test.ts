/**
 * Coverage for the name-derivation helpers in setup-config.ts
 * (envVarFor/flagFor/findByFlag) and a shape sanity-check on the real
 * CONFIG registry itself.
 */
import { describe, it, expect } from 'vitest';

import { CONFIG, envVarFor, flagFor, findByFlag, type Entry } from './setup-config.js';

const baseEntry = (overrides: Partial<Entry> = {}): Entry =>
  ({
    key: 'fooBarBaz',
    label: 'Foo',
    help: 'help text',
    surface: 'flag',
    type: 'string',
    ...overrides,
  }) as Entry;

describe('envVarFor', () => {
  it('derives NANOCLAW_<UPPER_SNAKE> from a camelCase key', () => {
    expect(envVarFor(baseEntry({ key: 'fooBarBaz' }))).toBe('NANOCLAW_FOO_BAR_BAZ');
  });

  it('a single-word key needs no underscores inserted', () => {
    expect(envVarFor(baseEntry({ key: 'skip' }))).toBe('NANOCLAW_SKIP');
  });

  it('an explicit envVar override wins over derivation', () => {
    expect(envVarFor(baseEntry({ key: 'fooBarBaz', envVar: 'CUSTOM_ENV' }))).toBe('CUSTOM_ENV');
  });
});

describe('flagFor', () => {
  it('derives --kebab-case from a camelCase key', () => {
    expect(flagFor(baseEntry({ key: 'fooBarBaz' }))).toBe('--foo-bar-baz');
  });

  it('an explicit flag override wins over derivation', () => {
    expect(flagFor(baseEntry({ key: 'fooBarBaz', flag: '--custom-flag' }))).toBe('--custom-flag');
  });
});

describe('findByFlag', () => {
  it('finds a real CONFIG entry by its derived flag', () => {
    const entry = findByFlag('--template-path');
    expect(entry?.key).toBe('templatePath');
  });

  it('returns null for a flag no entry declares', () => {
    expect(findByFlag('--no-such-flag')).toBeNull();
  });
});

describe("CONFIG entries' own validate() functions", () => {
  function entry(key: string): Entry {
    const e = CONFIG.find((c) => c.key === key);
    if (!e) throw new Error(`no CONFIG entry for ${key}`);
    return e;
  }

  it('onecliApiToken requires the oc_ prefix', () => {
    const e = entry('onecliApiToken') as Extract<Entry, { type: 'string' }>;
    expect(e.validate?.('oc_abc123')).toBeUndefined();
    expect(e.validate?.('sk-something')).toBe('Must start with oc_');
  });

  it('onecliApiHost / anthropicBaseUrl require an http(s) URL', () => {
    const host = entry('onecliApiHost') as Extract<Entry, { type: 'url' }>;
    const base = entry('anthropicBaseUrl') as Extract<Entry, { type: 'url' }>;
    for (const e of [host, base]) {
      expect(e.validate?.('https://api.example.com')).toBeUndefined();
      expect(e.validate?.('http://api.example.com')).toBeUndefined();
      expect(e.validate?.('not-a-url')).toBe('Must be http(s)://…');
    }
  });

  it('anthropicAuthToken requires a non-blank value', () => {
    const e = entry('anthropicAuthToken') as Extract<Entry, { type: 'string' }>;
    expect(e.validate?.('token-value')).toBeUndefined();
    expect(e.validate?.('   ')).toBe('Required');
  });
});

describe('CONFIG registry shape', () => {
  it('every entry resolves to a unique flag (no collisions across derivation + overrides)', () => {
    const flags = CONFIG.map(flagFor);
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('every entry resolves to a unique env var', () => {
    const envVars = CONFIG.map(envVarFor);
    expect(new Set(envVars).size).toBe(envVars.length);
  });
});

/**
 * Coverage for setup-config-parse.ts's coerce/parseFlags/readFromEnv/
 * applyToEnv/printHelp logic. The sibling setup-config-parse.test.ts only
 * exercises the real CONFIG registry (which today has no `integer` or
 * unvalidated-string entries), so this file swaps in a synthetic CONFIG
 * (keeping the real envVarFor/flagFor derivation) to reach every `coerce`
 * branch and every parseFlags error path.
 */
import { describe, it, expect, vi } from 'vitest';

import type { Entry } from './setup-config.js';

const SYNTHETIC_CONFIG: Entry[] = vi.hoisted(() => [
  { key: 'flagBool', envVar: 'NANOCLAW_FLAG_BOOL', label: 'Bool', help: 'a bool', surface: 'flag', type: 'boolean' },
  { key: 'countVal', envVar: 'NANOCLAW_COUNT_VAL', label: 'Count', help: 'a count', surface: 'flag', type: 'integer' },
  {
    key: 'nameVal',
    envVar: 'NANOCLAW_NAME_VAL',
    label: 'Name',
    help: 'a name',
    surface: 'flag',
    type: 'string',
    validate: (v) => (v.length > 0 ? undefined : 'Required'),
  },
  {
    key: 'plainVal',
    envVar: 'NANOCLAW_PLAIN_VAL',
    label: 'Plain',
    help: 'no validator',
    surface: 'flag',
    type: 'string',
  },
  {
    key: 'urlVal',
    envVar: 'NANOCLAW_URL_VAL',
    label: 'URL',
    help: 'a url',
    surface: 'flag',
    type: 'url',
    validate: (v) => (/^https?:\/\//.test(v) ? undefined : 'Must be http(s)'),
  },
]);

vi.mock('./setup-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./setup-config.js')>();
  return {
    ...actual,
    CONFIG: SYNTHETIC_CONFIG,
    findByFlag: (flag: string) => SYNTHETIC_CONFIG.find((e) => actual.flagFor(e) === flag) ?? null,
  };
});

import { readFromEnv, parseFlags, applyToEnv, printHelp } from './setup-config-parse.js';

describe('readFromEnv', () => {
  it('coerces booleans/integers/strings from a supplied env map', () => {
    const env = {
      NANOCLAW_FLAG_BOOL: 'yes',
      NANOCLAW_COUNT_VAL: '42',
      NANOCLAW_NAME_VAL: 'hello',
      NANOCLAW_URL_VAL: 'https://example.com',
    };
    expect(readFromEnv(env)).toEqual({
      flagBool: true,
      countVal: 42,
      nameVal: 'hello',
      urlVal: 'https://example.com',
    });
  });

  it('skips entries that are absent or empty', () => {
    expect(readFromEnv({ NANOCLAW_NAME_VAL: '' })).toEqual({});
    expect(readFromEnv({})).toEqual({});
  });

  it('skips a value that fails coercion (unrecognized boolean / non-numeric integer)', () => {
    expect(readFromEnv({ NANOCLAW_FLAG_BOOL: 'maybe' })).toEqual({});
    expect(readFromEnv({ NANOCLAW_COUNT_VAL: 'not-a-number' })).toEqual({});
  });

  it('recognizes every boolean spelling', () => {
    for (const [raw, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['TRUE', true], // case-insensitive
    ] as const) {
      expect(readFromEnv({ NANOCLAW_FLAG_BOOL: raw })).toEqual({ flagBool: expected });
    }
  });
});

describe('parseFlags', () => {
  it('--help / -h sets help without consuming further args', () => {
    expect(parseFlags(['--help']).help).toBe(true);
    expect(parseFlags(['-h']).help).toBe(true);
  });

  it('-- ends option parsing; everything after is pass-through rest', () => {
    const result = parseFlags(['--name-val', 'x', '--', '--not-a-flag', 'plain']);
    expect(result.values).toEqual({ nameVal: 'x' });
    expect(result.rest).toEqual(['--not-a-flag', 'plain']);
  });

  it('a bare positional (no -- prefix) goes to rest', () => {
    expect(parseFlags(['positional', '--name-val', 'x']).rest).toEqual(['positional']);
  });

  it('an unknown flag is reported but parsing continues', () => {
    const result = parseFlags(['--totally-unknown', '--name-val', 'x']);
    expect(result.errors).toEqual(['Unknown flag: --totally-unknown']);
    expect(result.values).toEqual({ nameVal: 'x' });
  });

  describe('boolean flags', () => {
    it('bare flag sets true', () => {
      expect(parseFlags(['--flag-bool']).values).toEqual({ flagBool: true });
    });

    it('--no- prefix negates to false', () => {
      expect(parseFlags(['--no-flag-bool']).values).toEqual({ flagBool: false });
    });

    it('inline =value coerces', () => {
      expect(parseFlags(['--flag-bool=false']).values).toEqual({ flagBool: false });
      expect(parseFlags(['--flag-bool=1']).values).toEqual({ flagBool: true });
    });

    it('an unparseable inline boolean is reported as an error, not set', () => {
      const result = parseFlags(['--flag-bool=maybe']);
      expect(result.errors).toEqual(['Invalid boolean for --flag-bool: maybe']);
      expect(result.values).toEqual({});
    });
  });

  describe('value-taking flags (string/integer/url)', () => {
    it('space-separated form consumes the next argv element', () => {
      expect(parseFlags(['--count-val', '7']).values).toEqual({ countVal: 7 });
    });

    it('inline =value form works too', () => {
      expect(parseFlags(['--count-val=7']).values).toEqual({ countVal: 7 });
    });

    it('a missing value at end of argv is an error', () => {
      const result = parseFlags(['--name-val']);
      expect(result.errors).toEqual(['Missing value for --name-val']);
    });

    it('an invalid integer is reported with the raw text', () => {
      const result = parseFlags(['--count-val', 'nope']);
      expect(result.errors).toEqual(['Invalid integer for --count-val: nope']);
      expect(result.values).toEqual({});
    });

    it('a string/url validate() failure blocks the value and reports "<flag>: <message>"', () => {
      const result = parseFlags(['--url-val', 'ftp://nope']);
      expect(result.errors).toEqual(['--url-val: Must be http(s)']);
      expect(result.values).toEqual({});
    });

    it('a string/url validate() success sets the value', () => {
      expect(parseFlags(['--url-val', 'https://ok.example']).values).toEqual({ urlVal: 'https://ok.example' });
    });

    it('a string entry with no validate() at all still sets the value', () => {
      expect(parseFlags(['--plain-val', 'anything goes']).values).toEqual({ plainVal: 'anything goes' });
    });
  });

  it('accumulates multiple errors and values across a mixed argv', () => {
    const result = parseFlags(['--flag-bool', '--totally-unknown', '--count-val', 'x', '--name-val', 'ok']);
    expect(result.values).toEqual({ flagBool: true, nameVal: 'ok' });
    expect(result.errors).toEqual(['Unknown flag: --totally-unknown', 'Invalid integer for --count-val: x']);
  });
});

describe('applyToEnv', () => {
  it('writes booleans as "true"/"false" strings and others via String()', () => {
    const env: NodeJS.ProcessEnv = {};
    applyToEnv({ flagBool: true, countVal: 7, nameVal: 'hi' }, env);
    expect(env).toEqual({
      NANOCLAW_FLAG_BOOL: 'true',
      NANOCLAW_COUNT_VAL: '7',
      NANOCLAW_NAME_VAL: 'hi',
    });
  });

  it('writes "false" for an explicit false, not skipping it', () => {
    const env: NodeJS.ProcessEnv = {};
    applyToEnv({ flagBool: false }, env);
    expect(env.NANOCLAW_FLAG_BOOL).toBe('false');
  });

  it('skips config entries absent from the supplied values', () => {
    const env: NodeJS.ProcessEnv = {};
    applyToEnv({}, env);
    expect(env).toEqual({});
  });
});

describe('printHelp', () => {
  it('renders one line per flag, help text, and the trailing env-var note', () => {
    const chunks: string[] = [];
    const stream = { write: (s: string) => void chunks.push(s) } as unknown as NodeJS.WritableStream;
    printHelp(stream);
    const out = chunks.join('');
    expect(out).toContain('Usage: bash nanoclaw.sh [flags...]');
    expect(out).toContain('--flag-bool');
    expect(out).toContain('a bool');
    expect(out).toContain('--url-val');
    expect(out).toContain('Each flag also reads from its corresponding NANOCLAW_<KEY> env var.');
  });
});

/**
 * Coverage for the advanced-settings menu loop in setup-config-screen.ts.
 * brightSelect and @clack/prompts (confirm/text/password) are mocked so the
 * whole flow is driven from queued answers instead of a real TTY; the
 * per-type CONFIG registry is swapped for a synthetic one (via vi.mock)
 * covering boolean/enum/integer/string/url/secret so every promptOne branch
 * is reachable regardless of what the real registry happens to contain today.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Entry } from './setup-config.js';

const SYNTHETIC_CONFIG: Entry[] = vi.hoisted(
  () =>
    [
      { key: 'boolFlag', label: 'Bool Flag', help: '', surface: 'flag+ui', type: 'boolean', default: false },
      { key: 'boolFlagNoDefault', label: 'Bool Flag No Default', help: '', surface: 'flag+ui', type: 'boolean' },
      {
        key: 'enumFlag',
        label: 'Enum Flag',
        help: '',
        surface: 'flag+ui',
        type: 'enum',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
      { key: 'intFlag', label: 'Int Flag', help: '', surface: 'flag+ui', type: 'integer', default: 5, min: 1, max: 10 },
      { key: 'intFlagNoDefault', label: 'Int Flag No Default', help: '', surface: 'flag+ui', type: 'integer' },
      {
        key: 'strFlag',
        label: 'Str Flag',
        help: '',
        surface: 'flag+ui',
        type: 'string',
        placeholder: 'ph',
        validate: (v: string) => (v.length < 3 ? 'too short' : undefined),
      },
      {
        key: 'urlFlag',
        label: 'URL Flag',
        help: '',
        surface: 'flag+ui',
        type: 'url',
        default: 'https://default.example',
      },
      { key: 'secretFlag', label: 'Secret Flag', help: '', surface: 'flag+ui', type: 'string', secret: true },
      // Not shown on the advanced screen — proves the surface filter works.
      { key: 'hiddenFlag', label: 'Hidden Flag', help: '', surface: 'flag', type: 'string' },
    ] as Entry[],
);

vi.mock('./setup-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./setup-config.js')>();
  return { ...actual, CONFIG: SYNTHETIC_CONFIG };
});

const h = vi.hoisted(() => ({
  selectQueue: [] as string[],
  selectCalls: [] as Array<{ message: string; options: Array<{ value: string; label: string; hint?: string }> }>,
  confirmQueue: [] as boolean[],
  confirmCalls: [] as Array<{ message: string; initialValue: boolean }>,
  textQueue: [] as Array<string | undefined>,
  textCalls: [] as Array<{ message: string; placeholder?: string; validate?: (v: string) => string | undefined }>,
  passwordCalls: [] as Array<{ message: string; validate?: (v: string) => string | undefined }>,
}));

vi.mock('./bright-select.js', () => ({
  brightSelect: vi.fn(
    async (opts: { message: string; options: Array<{ value: string; label: string; hint?: string }> }) => {
      h.selectCalls.push(opts);
      return h.selectQueue.shift();
    },
  ),
}));

vi.mock('./runner.js', () => ({ ensureAnswer: (v: unknown) => v }));

vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async (opts: { message: string; initialValue: boolean }) => {
      h.confirmCalls.push(opts);
      return h.confirmQueue.shift() ?? false;
    }),
    text: vi.fn(
      async (opts: { message: string; placeholder?: string; validate?: (v: string) => string | undefined }) => {
        h.textCalls.push(opts);
        return h.textQueue.shift();
      },
    ),
    password: vi.fn(async (opts: { message: string; validate?: (v: string) => string | undefined }) => {
      h.passwordCalls.push(opts);
      return h.textQueue.shift();
    }),
  };
});

import { runAdvancedScreen } from './setup-config-screen.js';

const DONE = '__done__';

beforeEach(() => {
  h.selectQueue.length = 0;
  h.selectCalls.length = 0;
  h.confirmQueue.length = 0;
  h.confirmCalls.length = 0;
  h.textQueue.length = 0;
  h.textCalls.length = 0;
  h.passwordCalls.length = 0;
});

describe('runAdvancedScreen — menu + hints', () => {
  it('picking Done immediately returns the initial values unchanged', async () => {
    h.selectQueue.push(DONE);
    const result = await runAdvancedScreen({ boolFlag: true });
    expect(result).toEqual({ boolFlag: true });
  });

  it('excludes flag-only (non flag+ui) entries from the menu', async () => {
    h.selectQueue.push(DONE);
    await runAdvancedScreen({});
    const keys = h.selectCalls[0].options.map((o) => o.value);
    expect(keys).not.toContain('hiddenFlag');
    expect(keys).toContain(DONE);
  });

  it('hints show "not set", the raw value, or a mask for secrets', async () => {
    h.selectQueue.push(DONE);
    await runAdvancedScreen({ intFlag: 7, secretFlag: 'super-secret' });
    const opts = h.selectCalls[0].options;
    expect(opts.find((o) => o.value === 'boolFlag')?.hint).toBe('not set');
    expect(opts.find((o) => o.value === 'intFlag')?.hint).toBe('7');
    expect(opts.find((o) => o.value === 'secretFlag')?.hint).toBe('••••••••');
  });

  it('an unmatched selection (defensive guard) is a no-op, loop continues to Done', async () => {
    h.selectQueue.push('__not_a_real_entry__', DONE);
    const result = await runAdvancedScreen({});
    expect(result).toEqual({});
  });
});

describe('promptOne — boolean', () => {
  it('uses the current value as the confirm default when already set', async () => {
    h.selectQueue.push('boolFlag', DONE);
    h.confirmQueue.push(true);
    const result = await runAdvancedScreen({ boolFlag: false });
    expect(result.boolFlag).toBe(true);
  });

  it('falls back to the entry default when unset', async () => {
    h.selectQueue.push('boolFlag', DONE);
    h.confirmQueue.push(true);
    const result = await runAdvancedScreen({});
    expect(result.boolFlag).toBe(true);
  });

  it('falls back to false (not the entry default) when neither a value nor a default exists', async () => {
    h.selectQueue.push('boolFlagNoDefault', DONE);
    h.confirmQueue.push(true);
    await runAdvancedScreen({});
    expect(h.confirmCalls[0].initialValue).toBe(false);
  });
});

describe('promptOne — enum', () => {
  it('picking a real option sets the value', async () => {
    h.selectQueue.push('enumFlag', 'b', DONE);
    const result = await runAdvancedScreen({});
    expect(result.enumFlag).toBe('b');
  });

  it('picking "leave unchanged" does not set/alter the value', async () => {
    h.selectQueue.push('enumFlag', '__leave_unchanged__', DONE);
    const result = await runAdvancedScreen({ enumFlag: 'a' });
    expect(result.enumFlag).toBe('a');
  });
});

describe('promptOne — integer', () => {
  it('a blank answer leaves the value unset', async () => {
    h.selectQueue.push('intFlag', DONE);
    h.textQueue.push('   ');
    const result = await runAdvancedScreen({});
    expect(result.intFlag).toBeUndefined();
  });

  it('a numeric answer sets the coerced number', async () => {
    h.selectQueue.push('intFlag', DONE);
    h.textQueue.push('8');
    const result = await runAdvancedScreen({});
    expect(result.intFlag).toBe(8);
  });

  it("passes the entry's default as the text placeholder", async () => {
    h.selectQueue.push('intFlag', DONE);
    h.textQueue.push('');
    await runAdvancedScreen({});
    expect(h.textCalls[0].placeholder).toBe('5');
  });

  it('the integer validate callback: blank ok, non-numeric/out-of-range rejected, in-range accepted', async () => {
    h.selectQueue.push('intFlag', DONE);
    h.textQueue.push('3');
    await runAdvancedScreen({});
    const validate = h.textCalls[0].validate!;
    expect(validate(undefined as unknown as string)).toBeUndefined(); // `v ?? ''` fallback
    expect(validate('')).toBeUndefined();
    expect(validate('   ')).toBeUndefined();
    expect(validate('abc')).toBe('Must be a number');
    expect(validate('0')).toBe('Must be ≥ 1');
    expect(validate('11')).toBe('Must be ≤ 10');
    expect(validate('5')).toBeUndefined();
  });

  it('an entry with no default has no placeholder, and no min/max skips those checks', async () => {
    h.selectQueue.push('intFlagNoDefault', DONE);
    h.textQueue.push('100'); // no max declared -> not rejected
    await runAdvancedScreen({});
    expect(h.textCalls[0].placeholder).toBeUndefined();
    expect(h.textCalls[0].validate!('100')).toBeUndefined();
  });

  it('an undefined resolved answer (not just blank) leaves the value unset', async () => {
    h.selectQueue.push('intFlag', DONE);
    h.textQueue.push(undefined);
    const result = await runAdvancedScreen({});
    expect(result.intFlag).toBeUndefined();
  });
});

describe('promptOne — string/url', () => {
  it('a blank answer leaves the value unset', async () => {
    h.selectQueue.push('strFlag', DONE);
    h.textQueue.push('  ');
    const result = await runAdvancedScreen({});
    expect(result.strFlag).toBeUndefined();
  });

  it('a non-blank answer is trimmed and set', async () => {
    h.selectQueue.push('strFlag', DONE);
    h.textQueue.push('  hello  ');
    const result = await runAdvancedScreen({});
    expect(result.strFlag).toBe('hello');
  });

  it("uses the entry's placeholder when set, else its default", async () => {
    h.selectQueue.push('strFlag', DONE);
    h.textQueue.push('');
    await runAdvancedScreen({});
    expect(h.textCalls[0].placeholder).toBe('ph');

    h.selectQueue.push('urlFlag', DONE);
    h.textQueue.push('');
    await runAdvancedScreen({});
    expect(h.textCalls[1].placeholder).toBe('https://default.example');
  });

  it('the validate wrapper: blank -> ok (unchanged), non-blank delegates to entry.validate', async () => {
    h.selectQueue.push('strFlag', DONE);
    h.textQueue.push('xy'); // triggers the call, but we test validate() directly below
    await runAdvancedScreen({});
    const validate = h.textCalls[0].validate!;
    expect(validate(undefined as unknown as string)).toBeUndefined(); // `v ?? ''` fallback
    expect(validate('')).toBeUndefined();
    expect(validate('   ')).toBeUndefined();
    expect(validate('xy')).toBe('too short'); // delegates to entry.validate on the trimmed value
    expect(validate('valid')).toBeUndefined();
  });

  it('an undefined resolved answer (not just blank) leaves the value unset', async () => {
    h.selectQueue.push('strFlag', DONE);
    h.textQueue.push(undefined);
    const result = await runAdvancedScreen({});
    expect(result.strFlag).toBeUndefined();
  });

  it('an entry with no validate() at all still wraps cleanly (url entry has none here)', async () => {
    h.selectQueue.push('urlFlag', DONE);
    h.textQueue.push('https://example.com');
    await runAdvancedScreen({});
    const validate = h.textCalls[0].validate!;
    expect(validate('https://example.com')).toBeUndefined();
  });

  it('secret entries use password(), not text(), and mask nothing in the call itself', async () => {
    h.selectQueue.push('secretFlag', DONE);
    h.textQueue.push('sekrit');
    const result = await runAdvancedScreen({});
    expect(result.secretFlag).toBe('sekrit');
    expect(h.passwordCalls).toHaveLength(1);
    expect(h.textCalls).toHaveLength(0);
  });
});

describe('multi-step loop', () => {
  it('editing two entries in one session before Done', async () => {
    h.selectQueue.push('boolFlag', 'strFlag', DONE);
    h.confirmQueue.push(true);
    h.textQueue.push('multi-value');
    const result = await runAdvancedScreen({});
    expect(result).toEqual({ boolFlag: true, strFlag: 'multi-value' });
  });
});

import { describe, it, expect, vi } from 'vitest';

// Pin the install timezone so localized stamps are deterministic.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, TIMEZONE: 'UTC' };
});

import { formatResponse, localizeIsoTimestamps } from './format.js';
import type { ResponseFrame } from './frame.js';

describe('localizeIsoTimestamps', () => {
  it('rewrites a whole-value UTC ISO instant to the local "YYYY-MM-DD HH:mm" stamp', () => {
    expect(localizeIsoTimestamps('2026-01-15T09:30:00Z')).toBe('2026-01-15 09:30');
    expect(localizeIsoTimestamps('2026-01-15T09:30:15.250Z')).toBe('2026-01-15 09:30');
    expect(localizeIsoTimestamps('2026-01-15T09:30Z')).toBe('2026-01-15 09:30');
  });

  it('leaves non-instant strings, embedded instants, and scalars alone', () => {
    expect(localizeIsoTimestamps('hello')).toBe('hello');
    expect(localizeIsoTimestamps('at 2026-01-15T09:30:00Z sharp')).toBe('at 2026-01-15T09:30:00Z sharp');
    expect(localizeIsoTimestamps('2026-01-15T09:30:00+01:00')).toBe('2026-01-15T09:30:00+01:00');
    expect(localizeIsoTimestamps(42)).toBe(42);
    expect(localizeIsoTimestamps(null)).toBeNull();
    expect(localizeIsoTimestamps(undefined)).toBeUndefined();
    expect(localizeIsoTimestamps(true)).toBe(true);
  });

  it('recurses through arrays and nested objects', () => {
    expect(
      localizeIsoTimestamps([
        '2026-01-15T09:30:00Z',
        { created_at: '2026-02-01T00:00:00Z', inner: { seen: ['2026-03-01T12:00:00Z', 7] } },
      ]),
    ).toEqual(['2026-01-15 09:30', { created_at: '2026-02-01 00:00', inner: { seen: ['2026-03-01 12:00', 7] } }]);
  });
});

describe('formatResponse', () => {
  it('json mode pretty-prints the frame verbatim (no localization) with a trailing newline', () => {
    const res: ResponseFrame = { id: 'r', ok: true, data: { at: '2026-01-15T09:30:00Z' } };
    const out = formatResponse(res, 'json');
    expect(out).toBe(JSON.stringify(res, null, 2) + '\n');
    expect(out).toContain('2026-01-15T09:30:00Z');
  });

  it('human mode renders an error frame as a single "error (code): message" line', () => {
    const res: ResponseFrame = { id: 'r', ok: false, error: { code: 'forbidden', message: 'nope' } };
    expect(formatResponse(res, 'human')).toBe('error (forbidden): nope\n');
  });

  it('human mode prints empty output for null/undefined data', () => {
    expect(formatResponse({ id: 'r', ok: true, data: null }, 'human')).toBe('\n');
    expect(formatResponse({ id: 'r', ok: true, data: undefined }, 'human')).toBe('\n');
  });

  it('human mode prints string data as-is', () => {
    expect(formatResponse({ id: 'r', ok: true, data: 'plain text' }, 'human')).toBe('plain text\n');
  });

  it('human mode renders an array of flat records as an aligned table with localized stamps', () => {
    const out = formatResponse(
      {
        id: 'r',
        ok: true,
        data: [
          { id: 'a', name: 'alpha', n: 1, created_at: '2026-01-15T09:30:00Z', gone: null },
          { id: 'bb', name: 'b', n: 22, created_at: '2026-01-16T10:00:00Z', gone: undefined },
        ],
      },
      'human',
    );
    expect(out.endsWith('\n')).toBe(true);
    const lines = out.slice(0, -1).split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('id  name   n   created_at        gone');
    expect(lines[1]).toBe('──  ─────  ──  ────────────────  ────');
    expect(lines[2]).toBe('a   alpha  1   2026-01-15 09:30      ');
    expect(lines[3]).toBe('bb  b      22  2026-01-16 10:00      ');
  });

  it('human mode prints "(no rows)" for an empty array', () => {
    expect(formatResponse({ id: 'r', ok: true, data: [] }, 'human')).toBe('(no rows)\n');
  });

  it('human mode falls back to JSON for arrays containing non-flat records', () => {
    const data = [{ id: 'a', nested: { x: 1 } }];
    expect(formatResponse({ id: 'r', ok: true, data }, 'human')).toBe(JSON.stringify(data, null, 2) + '\n');
    // A primitive element is not a record either.
    const mixed = [{ id: 'a' }, 5];
    expect(formatResponse({ id: 'r', ok: true, data: mixed }, 'human')).toBe(JSON.stringify(mixed, null, 2) + '\n');
    const withNull = [null];
    expect(formatResponse({ id: 'r', ok: true, data: withNull }, 'human')).toBe(
      JSON.stringify(withNull, null, 2) + '\n',
    );
  });

  it('human mode pretty-prints plain objects and numbers as JSON, localizing embedded instants', () => {
    expect(formatResponse({ id: 'r', ok: true, data: { at: '2026-01-15T09:30:00Z', n: 1 } }, 'human')).toBe(
      JSON.stringify({ at: '2026-01-15 09:30', n: 1 }, null, 2) + '\n',
    );
    expect(formatResponse({ id: 'r', ok: true, data: 12 }, 'human')).toBe('12\n');
  });
});

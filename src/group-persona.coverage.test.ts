/**
 * Coverage-uplift tests for group-persona.ts targeting branches the
 * pre-existing group-persona.test.ts suite doesn't reach: stageGroupPersona's
 * empty-content short-circuit and its non-EEXIST rethrow, and
 * readGroupPersona's not-a-regular-file guard (a directory at the prepend
 * path).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { PERSONA_PREPEND_FILE, readGroupPersona, stageGroupPersona } from './group-persona.js';

const TMP = '/tmp/nanoclaw-group-persona-cov';

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('stageGroupPersona', () => {
  it('returns false for empty or whitespace-only content without touching the filesystem', () => {
    expect(stageGroupPersona(TMP, '   \n  ')).toBe(false);
    expect(fs.existsSync(path.join(TMP, PERSONA_PREPEND_FILE))).toBe(false);
  });

  it('rethrows a non-EEXIST write error', () => {
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    expect(() => stageGroupPersona(TMP, 'hello')).toThrow('EACCES');
    writeSpy.mockRestore();
  });
});

describe('readGroupPersona', () => {
  it('returns null (and does not throw) when the prepend path is a directory, not a file', () => {
    fs.mkdirSync(path.join(TMP, PERSONA_PREPEND_FILE));
    expect(readGroupPersona(TMP)).toBeNull();
  });
});

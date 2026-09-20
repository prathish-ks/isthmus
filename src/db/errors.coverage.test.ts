/**
 * Coverage-uplift tests for db/errors.ts's isUniqueViolation — every
 * branch: non-object input, missing `code`, each recognized code prefix,
 * and the Error-message regex fallback (both matching and non-matching).
 */
import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from './errors.js';

describe('isUniqueViolation', () => {
  it('is false for null, undefined, and primitive values', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('not an object')).toBe(false);
    expect(isUniqueViolation(42)).toBe(false);
  });

  it('is false for an object with no code and no Error message match', () => {
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation(new Error('disk full'))).toBe(false);
  });

  it('recognizes the Postgres 23505 code', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('recognizes SQLITE_CONSTRAINT_UNIQUE and SQLITE_CONSTRAINT_PRIMARYKEY prefixes', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })).toBe(true);
  });

  it('falls back to matching "UNIQUE constraint failed" in an Error message', () => {
    expect(isUniqueViolation(new Error('UNIQUE constraint failed: t.id'))).toBe(true);
    expect(isUniqueViolation(new Error('unique constraint failed: t.id'))).toBe(true);
  });

  it('is false for a non-Error object even with a matching-looking message field', () => {
    expect(isUniqueViolation({ message: 'UNIQUE constraint failed' })).toBe(false);
  });
});

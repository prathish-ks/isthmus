/**
 * Coverage-uplift test for db/schema.ts — a reference-only SQL template
 * string, never imported at runtime (hence 0% baseline coverage: nothing
 * ever executes the module). Importing it and asserting its shape is
 * enough to mark the export statement covered.
 */
import { describe, expect, it } from 'vitest';

import { SCHEMA } from './schema.js';

describe('SCHEMA reference constant', () => {
  it('is a non-empty SQL string documenting the core tables', () => {
    expect(typeof SCHEMA).toBe('string');
    expect(SCHEMA).toContain('CREATE TABLE agent_groups');
    expect(SCHEMA).toContain('CREATE TABLE messaging_groups');
  });
});

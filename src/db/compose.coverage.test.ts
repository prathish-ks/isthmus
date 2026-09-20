/**
 * Coverage-uplift test for db/compose.ts targeting the branch the
 * pre-existing suites never reach: the registered SQLite factory's guard
 * against a remote-backend `config.url` (no remote backend is installed in
 * this composition). Importing compose.js triggers its one-time
 * `registerDbDriver` side effect for this isolated test file's module
 * graph, then we invoke the registered factory directly via
 * createDbDriver — bypassing initDb() entirely, so no real database is
 * touched.
 */
import { describe, expect, it } from 'vitest';

import { createDbDriver } from './driver-registry.js';
import './compose.js';

describe('compose.ts registered SQLite factory', () => {
  it('throws when a remote config.url is provided (no remote backend installed)', async () => {
    await expect(
      createDbDriver({ path: '/tmp/unused.db', url: 'postgres://example' }, { role: 'test' }),
    ).rejects.toThrow('A remote central-DB target was provided, but no remote backend is installed');
  });
});

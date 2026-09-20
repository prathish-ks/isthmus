/**
 * Coverage-uplift tests for db/connection.ts targeting branches the
 * pre-existing db-v2.test.ts / driver-registry.test.ts suites don't reach:
 * getDb() before initialization, initDb() called twice, passing a partial
 * config object (not a path string) to initDb(), and the config.url log
 * branch.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';

import { closeDb, getDb, initDb } from './connection.js';

afterEach(async () => {
  await closeDb();
});

describe('getDb before initialization', () => {
  it('throws a clear error', () => {
    expect(() => getDb()).toThrow('Database not initialized. Call initDb() first.');
  });
});

describe('initDb', () => {
  it('throws when called a second time without closing first', async () => {
    await initDb(':memory:', { role: 'test' });
    await expect(initDb(':memory:', { role: 'test' })).rejects.toThrow('Central DB is already initialized');
  });

  it('accepts a partial config object instead of a bare path string', async () => {
    const db = await initDb({ path: ':memory:' }, { role: 'test' });
    expect(db).toBe(getDb());
  });

  it('logs "configured remote target" rather than a bare path when config.url is set', async () => {
    // The real sqlite composition's factory rejects a remote url outright,
    // so exercising the `config.url ? 'configured remote target' : ...`
    // logging branch needs a driver that actually succeeds with a url set.
    // Swap in a stub driver via a fresh, isolated module graph.
    vi.resetModules();
    vi.doMock('./compose.js', () => ({})); // suppress the real sqlite auto-registration
    const { registerDbDriver } = await import('./driver-registry.js');
    registerDbDriver(
      () =>
        ({
          dialect: 'sqlite',
          close: async () => {},
        }) as never,
    );
    const freshConnection = await import('./connection.js');
    // resetModules() gave connection.js its own fresh ../log.js instance —
    // spy on that instance, not the one imported at this file's top.
    const freshLog = await import('../log.js');
    const logSpy = vi.spyOn(freshLog.log, 'info').mockImplementation(() => {});
    await freshConnection.initDb({ path: ':memory:', url: 'postgres://example' }, { role: 'host' });
    expect(logSpy).toHaveBeenCalledWith(
      'Central DB initialized',
      expect.objectContaining({ target: 'configured remote target' }),
    );
    await freshConnection.closeDb();
    logSpy.mockRestore();
    vi.doUnmock('./compose.js');
    vi.resetModules();
  });
});

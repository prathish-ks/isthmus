/**
 * Coverage-uplift tests for log.ts (no sibling test file previously
 * existed for this module): log.fatal emission, the process-level
 * uncaughtException / unhandledRejection handlers, and the LOG_LEVEL
 * env-var override branch (module-level constant, so re-imported fresh
 * with the env var set beforehand via vi.resetModules).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('log.fatal and level filtering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a fatal-level line to stderr', async () => {
    const { log } = await import('./log.js');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.fatal('boom', { detail: 1 });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0][0]).toContain('FATAL');
    expect(writeSpy.mock.calls[0][0]).toContain('boom');
  });

  it('formats an Error value under the special "err" key differently from other JSON values', async () => {
    const { log } = await import('./log.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log.info('with error', { err: new Error('nested'), other: 'plain' });
    const line = writeSpy.mock.calls[0][0] as string;
    expect(line).toContain('type: "Error"');
    // ANSI color codes sit between the key and "=", so match loosely.
    expect(line).toContain('other');
    expect(line).toContain('"plain"');
  });
});

describe('process-level handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unhandledRejection logs the reason as an error', async () => {
    await import('./log.js');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.emit('unhandledRejection', new Error('rejected'), Promise.resolve());
    expect(writeSpy).toHaveBeenCalled();
    expect(writeSpy.mock.calls[0][0]).toContain('Unhandled rejection');
  });

  it('uncaughtException logs fatally and calls process.exit(1)', async () => {
    await import('./log.js');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    process.emit('uncaughtException', new Error('fatal error'));
    expect(writeSpy).toHaveBeenCalled();
    expect(writeSpy.mock.calls[0][0]).toContain('Uncaught exception');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('LOG_LEVEL env override', () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLevel;
    vi.resetModules();
  });

  it('suppresses debug output below the configured threshold (warn)', async () => {
    process.env.LOG_LEVEL = 'warn';
    const { log } = await import('./log.js');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    log.debug('should be suppressed');
    log.info('should also be suppressed');
    expect(writeSpy).not.toHaveBeenCalled();
    const errWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    log.warn('should appear');
    expect(errWriteSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Coverage-uplift tests for inbox-safety.ts targeting branches no sibling
 * test file (none previously existed for this module) covers: the happy
 * path, the pre-placed-symlink rejections, the realpath-containment escape
 * branch (forced via a mocked fs.realpathSync, since a genuine TOCTOU race
 * isn't reliably constructible in a test), and the resolve-failure catch.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureContainedInboxDir, isPathInside } from './inbox-safety.js';
import { log } from './log.js';

describe('isPathInside', () => {
  it('is true for the parent itself and for nested children', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true);
  });

  it('is false for a sibling or an escaping path', () => {
    expect(isPathInside('/a/b', '/a/c')).toBe(false);
    expect(isPathInside('/a/b', '/a/b/../c')).toBe(false);
  });
});

describe('ensureContainedInboxDir', () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-inbox-safety-cov-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('creates and returns the resolved subdir on the happy path', () => {
    const inboxRoot = path.join(base, 'inbox');
    const result = ensureContainedInboxDir(inboxRoot, 'msg-1', { messageId: 'msg-1' });
    expect(result).toBe(fs.realpathSync(path.join(inboxRoot, 'msg-1')));
    expect(fs.statSync(result!).isDirectory()).toBe(true);
  });

  it('rejects a symlinked inbox root', () => {
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    const inboxRoot = path.join(base, 'inbox-symlinked');
    fs.symlinkSync(outside, inboxRoot);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = ensureContainedInboxDir(inboxRoot, 'msg-2', { messageId: 'msg-2' });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'inbox-safety: rejecting unsafe inbox path',
      expect.objectContaining({ messageId: 'msg-2' }),
    );
  });

  it('rejects a pre-placed symlink at the per-message subdir', () => {
    const inboxRoot = path.join(base, 'inbox2');
    fs.mkdirSync(inboxRoot, { recursive: true });
    const outsideTarget = path.join(base, 'outside2');
    fs.mkdirSync(outsideTarget, { recursive: true });
    fs.symlinkSync(outsideTarget, path.join(inboxRoot, 'msg-3'));
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = ensureContainedInboxDir(inboxRoot, 'msg-3', { messageId: 'msg-3' });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'inbox-safety: rejecting unsafe inbox path',
      expect.objectContaining({ messageId: 'msg-3' }),
    );
  });

  it('rejects when the resolved subdir escapes the resolved root (forced mismatch)', () => {
    const inboxRoot = path.join(base, 'inbox3');
    const origRealpath = fs.realpathSync.bind(fs) as typeof fs.realpathSync;
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (typeof p === 'string' && p.endsWith(path.join('inbox3', 'msg-4'))) return '/somewhere/else/msg-4';
      return origRealpath(p as string);
    }) as typeof fs.realpathSync);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = ensureContainedInboxDir(inboxRoot, 'msg-4', { messageId: 'msg-4' });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'inbox-safety: inbox dir escaped inbox root',
      expect.objectContaining({ messageId: 'msg-4' }),
    );
    realpathSpy.mockRestore();
  });

  it('logs and returns null when realpath resolution throws', () => {
    const inboxRoot = path.join(base, 'inbox4');
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('EIO');
    });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = ensureContainedInboxDir(inboxRoot, 'msg-5', { messageId: 'msg-5' });
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'inbox-safety: failed to resolve inbox dir',
      expect.objectContaining({ messageId: 'msg-5', err: expect.any(Error) }),
    );
    realpathSpy.mockRestore();
  });
});

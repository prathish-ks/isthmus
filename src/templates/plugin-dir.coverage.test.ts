/**
 * Coverage-uplift tests for templates/plugin-dir.ts targeting two defensive
 * branches the pre-existing plugin-dir.test.ts suite can't reach on a real
 * filesystem: `readdirSync` never actually returns a "." / ".." / slash-
 * containing entry name or a non-symlink/non-directory/non-file Dirent
 * (special files like sockets or FIFOs aren't portable to construct in a
 * test), so both are exercised here via a mocked `fs.readdirSync`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { walkPluginDir } from './plugin-dir.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-cov-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function fakeDirent(name: string, kind: 'file' | 'dir' | 'symlink' | 'other'): fs.Dirent {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => kind === 'other',
    isSocket: () => false,
  } as fs.Dirent;
}

describe('walkPluginDir defensive guards', () => {
  it('rejects an entry name readdir should never produce (slash/dot-entries)', () => {
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([fakeDirent('../escape', 'file')] as never);
    expect(() => walkPluginDir(root)).toThrow(/entry name "\.\.\/escape".*is not allowed/);
    readdirSpy.mockRestore();
  });

  it('rejects a special file (not a regular file or directory)', () => {
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([fakeDirent('a-fifo', 'other')] as never);
    expect(() => walkPluginDir(root)).toThrow(/"a-fifo" is not a regular file or directory/);
    readdirSpy.mockRestore();
  });
});

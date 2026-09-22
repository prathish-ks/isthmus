/**
 * getRuntimeSocketDir/ensureRuntimeSocketDir exist specifically to keep
 * Unix socket paths under the 104-byte macOS/BSD sockaddr_un limit
 * regardless of install path depth — see their own doc comments and
 * go-host/internal/kernel/server.go's maxSocketPathLen. These tests
 * exercise the length guarantee itself (the property that actually
 * matters) and the pure/side-effecting split (getRuntimeSocketDir must
 * stay filesystem-free — it runs at config.ts module-load time, so any
 * I/O there would make importing config.ts itself touch the filesystem).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureRuntimeSocketDir, getInstallSlug, getRuntimeSocketDir } from './install-slug.js';

// The same limit go-host/internal/kernel/server.go enforces — kept as a
// literal here rather than imported (no TS/Go shared-constant mechanism)
// so this test fails loudly if the two ever drift apart.
const MAX_SOCKET_PATH_LEN = 104;

let savedXdgRuntimeDir: string | undefined;

beforeEach(() => {
  savedXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
});

afterEach(() => {
  if (savedXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = savedXdgRuntimeDir;
});

describe('getRuntimeSocketDir', () => {
  it('is pure — computing the path performs no filesystem access', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const dir = getRuntimeSocketDir('/never/created/' + Math.random().toString(36).slice(2));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('stays well under the sockaddr_un limit even for a pathologically deep project root', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const deepRoot = '/' + 'a'.repeat(20) + '/'.repeat(1) + 'b'.repeat(20).repeat(5);
    const dir = getRuntimeSocketDir(deepRoot);
    const socketPath = path.join(dir, 'nanogo-kernel.sock');
    expect(socketPath.length).toBeLessThan(MAX_SOCKET_PATH_LEN);
  });

  it('is independent of project root length — same short base regardless of input', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const short = getRuntimeSocketDir('/x');
    const long = getRuntimeSocketDir('/' + 'y'.repeat(300));
    // Different slugs (different dirs), but both rooted at the same short base.
    expect(path.dirname(short)).toBe(path.dirname(long));
    expect(short).not.toBe(long);
  });

  it('is deterministic — same projectRoot always yields the same dir', () => {
    delete process.env.XDG_RUNTIME_DIR;
    expect(getRuntimeSocketDir('/repeat/me')).toBe(getRuntimeSocketDir('/repeat/me'));
  });

  it('keys the directory name off getInstallSlug', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const root = '/keyed/example';
    const dir = getRuntimeSocketDir(root);
    expect(path.basename(dir)).toBe(`nanoclaw-${getInstallSlug(root)}`);
  });

  it('prefers XDG_RUNTIME_DIR over os.tmpdir() when set', () => {
    process.env.XDG_RUNTIME_DIR = '/fake/runtime/dir';
    const dir = getRuntimeSocketDir('/anything');
    expect(dir.startsWith('/fake/runtime/dir')).toBe(true);
  });

  it('falls back to os.tmpdir() when XDG_RUNTIME_DIR is unset', () => {
    delete process.env.XDG_RUNTIME_DIR;
    const dir = getRuntimeSocketDir('/anything');
    expect(dir.startsWith(os.tmpdir())).toBe(true);
  });
});

describe('ensureRuntimeSocketDir', () => {
  it('creates the directory with 0700 permissions', () => {
    const dir = path.join(os.tmpdir(), `ensure-test-${Math.random().toString(36).slice(2)}`);
    expect(fs.existsSync(dir)).toBe(false);
    ensureRuntimeSocketDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent — safe to call repeatedly on the same dir', () => {
    const dir = path.join(os.tmpdir(), `ensure-idempotent-${Math.random().toString(36).slice(2)}`);
    ensureRuntimeSocketDir(dir);
    ensureRuntimeSocketDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-chmods a pre-existing directory back to 0700', () => {
    const dir = path.join(os.tmpdir(), `ensure-rechmod-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { mode: 0o755 });
    ensureRuntimeSocketDir(dir);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  imageSource: 'local' as 'local' | 'hardened',
}));

vi.mock('child_process', () => ({ spawnSync: h.spawnSync }));
vi.mock('./registry-state.js', () => ({
  HARDENED_IMAGE_ENV_KEY: 'NANOCLAW_HARDENED_IMAGE',
  readImageSource: () => h.imageSource,
}));

import { buildContainerImage } from './container-build.js';

beforeEach(() => {
  h.spawnSync.mockReset();
  h.imageSource = 'local';
});

describe('buildContainerImage', () => {
  it('refuses when the image is pinned (hardened), without ever spawning docker', () => {
    h.imageSource = 'hardened';
    const result = buildContainerImage('/proj');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('NANOCLAW_HARDENED_IMAGE=true');
      expect(result.hint).toContain('container/build.sh pull');
    }
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('succeeds when build.sh exits 0', () => {
    h.spawnSync.mockReturnValue({ status: 0, signal: null, error: undefined });
    const result = buildContainerImage('/proj');
    expect(result).toEqual({ ok: true });
    expect(h.spawnSync).toHaveBeenCalledWith(path.join('/proj', 'container', 'build.sh'), [], {
      cwd: '/proj',
      stdio: 'inherit',
    });
  });

  it('defaults projectRoot to process.cwd() when omitted', () => {
    h.spawnSync.mockReturnValue({ status: 0, signal: null, error: undefined });
    buildContainerImage();
    expect(h.spawnSync).toHaveBeenCalledWith(
      path.join(process.cwd(), 'container', 'build.sh'),
      [],
      expect.objectContaining({ cwd: process.cwd() }),
    );
  });

  it('reports a spawn error (script missing/not executable)', () => {
    h.spawnSync.mockReturnValue({ status: null, signal: null, error: new Error('ENOENT') });
    const result = buildContainerImage('/proj');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Couldn't run");
      expect(result.message).toContain('ENOENT');
      expect(result.hint).toContain('executable');
    }
  });

  it('reports a signal termination', () => {
    h.spawnSync.mockReturnValue({ status: null, signal: 'SIGKILL', error: undefined });
    const result = buildContainerImage('/proj');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('terminated by SIGKILL');
      expect(result.hint).toContain('memory');
    }
  });

  it('reports a non-zero exit status', () => {
    h.spawnSync.mockReturnValue({ status: 1, signal: null, error: undefined });
    const result = buildContainerImage('/proj');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('exit 1');
      expect(result.hint).toContain('Docker must be running');
    }
  });
});

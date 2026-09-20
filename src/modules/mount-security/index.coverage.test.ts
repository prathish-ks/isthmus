/**
 * Coverage tests for the mount allowlist loader/validator — the paths the
 * sibling index.test.ts does not drive: structural validation errors, the
 * mtime cache hit, `~` expansion, blocked-pattern matching (component and
 * whole-path), container-path rejection rules, the "not under any root"
 * refusal, validateAdditionalMounts, and the template generator.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({ allowlistPath: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
  };
});

import { log } from '../../log.js';
import { generateAllowlistTemplate, loadMountAllowlist, validateAdditionalMounts, validateMount } from './index.js';

let tmpDir: string;
let configFile: string;
let projectsDir: string;
let repoDir: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-sec-cov-'));
  configFile = path.join(tmpDir, 'mount-allowlist.json');
  mockState.allowlistPath = configFile;
  projectsDir = path.join(tmpDir, 'projects');
  repoDir = path.join(projectsDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAllowlist(obj: unknown): void {
  fs.writeFileSync(configFile, JSON.stringify(obj, null, 2) + '\n');
}

describe('loadMountAllowlist — structure validation and cache', () => {
  it('rejects a file whose allowedRoots is not an array', () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    writeAllowlist({ allowedRoots: 'nope', blockedPatterns: [] });
    expect(loadMountAllowlist()).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load mount allowlist'),
      expect.objectContaining({ error: 'allowedRoots must be an array' }),
    );
  });

  it('rejects a file whose blockedPatterns is not an array', () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    writeAllowlist({ allowedRoots: [], blockedPatterns: {} });
    expect(loadMountAllowlist()).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: 'blockedPatterns must be an array' }),
    );
  });

  it('reports a non-Error throw as a string', () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    writeAllowlist({ allowedRoots: [], blockedPatterns: [] });
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw 'raw string failure';
    });
    expect(loadMountAllowlist()).toBeNull();
    expect(errSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ error: 'raw string failure' }));
  });

  it('serves the cached allowlist while the file mtime is unchanged and re-reads after a change', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: ['zzz'] });
    const first = loadMountAllowlist();
    expect(first).not.toBeNull();

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const second = loadMountAllowlist();
    expect(second).toBe(first); // same object → cache hit, no re-parse
    expect(readSpy).not.toHaveBeenCalled();

    // A changed file (new mtime) is re-read.
    const later = new Date(Date.now() + 5000);
    writeAllowlist({ allowedRoots: [], blockedPatterns: [] });
    fs.utimesSync(configFile, later, later);
    const third = loadMountAllowlist();
    expect(third).not.toBe(first);
    expect(third!.allowedRoots).toHaveLength(0);
  });

  it('merges custom blocked patterns with the defaults, deduplicated', () => {
    writeAllowlist({ allowedRoots: [], blockedPatterns: ['.ssh', 'custom-secret'] });
    const allowlist = loadMountAllowlist()!;
    expect(allowlist.blockedPatterns.filter((p) => p === '.ssh')).toHaveLength(1);
    expect(allowlist.blockedPatterns).toContain('custom-secret');
    expect(allowlist.blockedPatterns).toContain('.config/nanoclaw');
  });

  it('normalizes roots: non-string path → "", description kept, neither readOnly nor allowReadWrite → read-only', () => {
    writeAllowlist({
      allowedRoots: [
        { path: 42, description: 'weird' },
        { path: projectsDir, description: 7 },
      ],
      blockedPatterns: [],
    });
    const allowlist = loadMountAllowlist()!;
    expect(allowlist.allowedRoots[0]).toEqual({ path: '', allowReadWrite: false, description: 'weird' });
    expect(allowlist.allowedRoots[1]).toEqual({ path: projectsDir, allowReadWrite: false, description: undefined });
  });
});

describe('validateMount — refusal paths', () => {
  it('blocks every mount when no allowlist file exists', () => {
    const result = validateMount({ hostPath: repoDir });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No mount allowlist configured at');
    expect(result.reason).toContain(configFile);
  });

  it('rejects container paths with "..", absolute paths, blank paths, and colons', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    for (const containerPath of ['../escape', '/abs', '   ', 'repo:rw']) {
      const result = validateMount({ hostPath: repoDir, containerPath });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain(`Invalid container path: "${containerPath}"`);
    }
  });

  it('derives an empty container path from a root hostPath and rejects it', () => {
    writeAllowlist({ allowedRoots: [{ path: '/', allowReadWrite: false }], blockedPatterns: [] });
    const result = validateMount({ hostPath: '/' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid container path: ""');
  });

  it('rejects a host path that does not exist (reports the expanded path)', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    const missing = path.join(projectsDir, 'ghost');
    const result = validateMount({ hostPath: missing });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(`Host path does not exist: "${missing}" (expanded: "${missing}")`);
  });

  it('rejects a path whose component matches a blocked pattern', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    const sshDir = path.join(projectsDir, '.ssh');
    fs.mkdirSync(sshDir);
    const result = validateMount({ hostPath: sshDir });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Path matches blocked pattern ".ssh"');
  });

  it('rejects a path matching a separator-spanning pattern against the whole real path', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    const nanoclawDir = path.join(projectsDir, '.config', 'nanoclaw');
    fs.mkdirSync(nanoclawDir, { recursive: true });
    const result = validateMount({ hostPath: nanoclawDir });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('".config/nanoclaw"');
  });

  it('rejects a path that is not under any allowed root and lists the expanded roots', () => {
    const otherDir = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(otherDir);
    writeAllowlist({
      allowedRoots: [
        { path: projectsDir, allowReadWrite: true },
        { path: path.join(tmpDir, 'does-not-exist'), allowReadWrite: true }, // skipped
      ],
      blockedPatterns: [],
    });
    const result = validateMount({ hostPath: otherDir });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(`Path "${fs.realpathSync(otherDir)}" is not under any allowed root`);
    expect(result.reason).toContain(projectsDir);
    expect(result.reason).toContain(path.join(tmpDir, 'does-not-exist'));
  });
});

describe('validateMount — tilde expansion and allow paths', () => {
  it('expands "~/..." roots and host paths against $HOME', () => {
    process.env.HOME = tmpDir;
    writeAllowlist({ allowedRoots: [{ path: '~/projects', allowReadWrite: true }], blockedPatterns: [] });
    const result = validateMount({ hostPath: '~/projects/repo', readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.realHostPath).toBe(fs.realpathSync(repoDir));
    expect(result.resolvedContainerPath).toBe('repo');
    expect(result.effectiveReadonly).toBe(false);
  });

  it('expands a bare "~" root to the home directory', () => {
    process.env.HOME = tmpDir;
    writeAllowlist({ allowedRoots: [{ path: '~', allowReadWrite: false, description: 'home' }], blockedPatterns: [] });
    const result = validateMount({ hostPath: repoDir });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('Allowed under root "~" (home)');
    expect(result.effectiveReadonly).toBe(true);
  });

  it('falls back to os.homedir() when $HOME is unset', () => {
    delete process.env.HOME;
    writeAllowlist({ allowedRoots: [{ path: '~', allowReadWrite: false }], blockedPatterns: [] });
    const outside = validateMount({ hostPath: repoDir });
    expect(outside.allowed).toBe(false);
    expect(outside.reason).toContain(`Allowed roots: ${os.homedir()}`);
  });

  it('resolves a relative host path against the cwd', () => {
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });
    const rel = path.relative(process.cwd(), repoDir);
    const result = validateMount({ hostPath: rel, containerPath: 'code' });
    expect(result.allowed).toBe(true);
    expect(result.resolvedContainerPath).toBe('code');
  });

  it('forces read-only with a log line when the root does not allow read-write', () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: false }], blockedPatterns: [] });
    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith(
      'Mount forced to read-only - root does not allow read-write',
      expect.objectContaining({ mount: repoDir, root: projectsDir }),
    );
  });

  it('stays read-only when the mount does not request read-write, even on an RW root', () => {
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    expect(validateMount({ hostPath: repoDir }).effectiveReadonly).toBe(true);
    expect(validateMount({ hostPath: repoDir, readonly: true }).effectiveReadonly).toBe(true);
  });
});

describe('validateAdditionalMounts', () => {
  it('keeps validated mounts under /workspace/extra and warns for rejected ones', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    const missing = path.join(projectsDir, 'nope');

    const result = validateAdditionalMounts(
      [
        { hostPath: repoDir, containerPath: 'my-repo', readonly: false },
        { hostPath: missing, containerPath: 'gone' },
      ],
      'group-x',
    );

    expect(result).toEqual([
      { hostPath: fs.realpathSync(repoDir), containerPath: '/workspace/extra/my-repo', readonly: false },
    ]);
    expect(debugSpy).toHaveBeenCalledWith(
      'Mount validated successfully',
      expect.objectContaining({ group: 'group-x', containerPath: 'my-repo', readonly: false }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Additional mount REJECTED',
      expect.objectContaining({ group: 'group-x', requestedPath: missing, containerPath: 'gone' }),
    );
  });

  it('returns an empty list for no mounts', () => {
    expect(validateAdditionalMounts([], 'g')).toEqual([]);
  });
});

describe('generateAllowlistTemplate', () => {
  it('produces parseable JSON with three example roots and extra blocked patterns', () => {
    const parsed = JSON.parse(generateAllowlistTemplate()) as {
      allowedRoots: Array<{ path: string; allowReadWrite: boolean }>;
      blockedPatterns: string[];
    };
    expect(parsed.allowedRoots.map((r) => r.path)).toEqual(['~/projects', '~/repos', '~/Documents/work']);
    expect(parsed.allowedRoots[2].allowReadWrite).toBe(false);
    expect(parsed.blockedPatterns).toEqual(['password', 'secret', 'token']);
  });
});

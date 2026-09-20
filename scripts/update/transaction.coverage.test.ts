import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  abandonUpdate,
  acknowledgeRequirement,
  cleanupUpdate,
  cutoverUpdate,
  defaultTransactionsRoot,
  finishUpdate,
  loadState,
  prepareUpdate,
  pruneTransactions,
  resumePreparedUpdate,
  rollbackUpdate,
  summarizeState,
  validateUpdate,
  type UpdateRuntime,
  type UpdateState,
} from './transaction.js';
import type { CommandRunner, ServiceHandle } from './service.js';

/**
 * ENVIRONMENTAL CONDITION THAT TRIPS `hasSafeStatePaths` IN THIS SANDBOX
 * (see the brief): `prepareUpdate` canonicalizes its project root with
 * `fs.realpathSync(options.projectRoot)` before persisting it into
 * `state.projectRoot`. On macOS, `os.tmpdir()` returns a path under
 * `/var/folders/...`, and `/var` is itself a symlink to `/private/var`. A
 * caller that passes the RAW (non-realpath'd) tmpdir path to
 * `validateUpdate`/`cutoverUpdate`/etc. (as the sibling
 * transaction.e2e.test.ts does) ends up with
 * `path.resolve(state.projectRoot)` (`/private/var/folders/...`, already
 * canonicalized at prepare time) never equal to `path.resolve(projectRoot)`
 * (`/var/folders/...`, the raw argument) inside `hasSafeStatePaths` — so the
 * safety check trips and `loadState` throws "Update state contains
 * mismatched or unsafe paths" on the very next call after `prepareUpdate`.
 * This is a real macOS-only path-canonicalization mismatch between what
 * `prepareUpdate` stores and what callers pass back in, not a logic bug we
 * were asked to fix. Our own fixtures below realpath every temp root up
 * front so every call site already agrees on the canonical path.
 */

const roots: string[] = [];
let previousUpdateDir: string | undefined;
let updateDirSet = false;

function temp(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function exec(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryExec(cwd: string, command: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    return { ok: true, stdout: exec(cwd, command, args) };
  } catch (err) {
    const failed = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: [failed.stdout, failed.stderr]
        .map((part) => part?.toString().trim())
        .filter(Boolean)
        .join('\n'),
    };
  }
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(root: string, message: string): string {
  exec(root, 'git', ['add', '.']);
  exec(root, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
  return exec(root, 'git', ['rev-parse', 'HEAD']);
}

function useUpdateDir(): string {
  if (!updateDirSet) {
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    updateDirSet = true;
  }
  const dir = temp('nanoclaw-update-state-');
  process.env.NANOCLAW_UPDATE_DIR = dir;
  return dir;
}

interface Fixture {
  install: string;
  originalHead: string;
  upstreamHead: string;
  official: string;
}

function createForkFixture(
  options: { breaking?: boolean; externalPinMove?: boolean; withAppendSkill?: boolean } = {},
): Fixture {
  const seed = temp('nanoclaw-update-seed-');
  exec(seed, 'git', ['init', '-b', 'main']);
  write(seed, 'package.json', '{"name":"nanoclaw-test","version":"2.1.54"}\n');
  write(seed, '.gitignore', 'data/\n.env\nstart-nanoclaw.sh\nnanoclaw.pid\n');
  write(seed, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  if (options.withAppendSkill) {
    write(seed, 'src/channels/index.ts', "import './cli.js';\nimport './demo.js';\n");
    write(
      seed,
      '.claude/skills/add-demo/SKILL.md',
      ['# Apply', '```nc:append to:MARKER.txt', 'installed-marker', '```'].join('\n'),
    );
  } else {
    write(seed, 'src/channels/index.ts', "import './cli.js';\n");
  }
  write(seed, 'src/providers/index.ts', '');
  write(seed, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
  write(seed, 'versions.json', '{"onecli-gateway":"1.0.0","onecli-cli":"1.0.0"}\n');
  write(seed, 'CHANGELOG.md', '# Changelog\n');
  write(seed, 'src/value.ts', 'export const value = "old";\n');
  commit(seed, 'base');

  const official = temp('nanoclaw-update-official-');
  fs.rmSync(official, { recursive: true });
  exec(path.dirname(official), 'git', ['clone', '--bare', seed, official]);
  const fork = temp('nanoclaw-update-fork-');
  fs.rmSync(fork, { recursive: true });
  exec(path.dirname(fork), 'git', ['clone', '--bare', official, fork]);

  write(seed, 'src/value.ts', 'export const value = "new";\n');
  if (options.breaking) {
    fs.appendFileSync(
      path.join(seed, 'CHANGELOG.md'),
      '- [BREAKING] Test schema migration. Follow [the guide](docs/test-migration.md).\n',
    );
    write(seed, 'docs/test-migration.md', '# Test migration\n');
  }
  if (options.externalPinMove) {
    write(seed, 'versions.json', '{"onecli-gateway":"2.0.0","onecli-cli":"1.0.0"}\n');
  }
  const upstreamHead = commit(seed, 'upstream update at same package version');
  exec(seed, 'git', ['remote', 'add', 'publish', official]);
  exec(seed, 'git', ['push', 'publish', 'main']);

  const install = temp('nanoclaw-update-install-');
  fs.rmSync(install, { recursive: true });
  exec(path.dirname(install), 'git', ['clone', fork, install]);
  exec(install, 'git', ['config', 'user.name', 'Test']);
  exec(install, 'git', ['config', 'user.email', 'test@example.com']);
  exec(install, 'git', ['remote', 'add', 'upstream', official]);
  exec(install, 'git', ['fetch', 'upstream']);
  write(install, 'local-customization.txt', 'keep me\n');
  const originalHead = commit(install, 'local customization');
  write(install, 'data/v2.db', 'old-schema');
  write(install, '.env', 'EXAMPLE=old\n');
  write(install, 'start-nanoclaw.sh', '#!/bin/bash\nnode dist/index.js\n');
  write(install, 'nanoclaw.pid', '1234\n');
  return { install, originalHead, upstreamHead, official };
}

interface FakeRuntimeOptions {
  health?: boolean[];
  migrateOnStart?: boolean;
  /** Intercept a specific git invocation; return undefined to pass through to real git. */
  gitOverride?: (args: string[], cwd: string) => { ok: boolean; stdout: string } | undefined;
}

function fakeRuntime(install: string, options: FakeRuntimeOptions = {}): { runtime: UpdateRuntime; events: string[] } {
  const events: string[] = [];
  const health = [...(options.health ?? [true])];
  const service: ServiceHandle = { mode: 'systemd-user', active: true, name: 'nanoclaw-test' };

  const runner: CommandRunner = {
    run(command, args, cwd = install) {
      if (command === 'git') {
        const override = options.gitOverride?.(args, cwd);
        if (override) {
          if (!override.ok) throw new Error(override.stdout || 'git failed');
          return override.stdout;
        }
        return exec(cwd, command, args);
      }
      events.push(`${command} ${args.join(' ')}`);
      if (command === 'pnpm' && args.includes('upgrade-state.ts')) {
        const head = exec(cwd, 'git', ['rev-parse', 'HEAD']);
        write(cwd, 'data/upgrade-state.json', JSON.stringify({ version: '2.1.54', commit: head, tree: 'test' }));
      }
      return '';
    },
    tryRun(command, args, cwd = install) {
      if (command === 'git') {
        const override = options.gitOverride?.(args, cwd);
        if (override) return override;
        return tryExec(cwd, command, args);
      }
      if (command === 'bun' && args[0] === '--version') return { ok: false, stdout: '' };
      return { ok: true, stdout: '' };
    },
  };

  const runtime: UpdateRuntime = {
    runner,
    serviceEnv: {
      platform: 'linux',
      home: os.homedir(),
      uid: process.getuid?.() ?? 0,
      runner,
      sleep: async () => {},
    },
    detectService: () => service,
    stopService: async (handle) => {
      if (handle.mode === 'unmanaged') throw new Error('refusing unmanaged service');
      events.push('service stop');
    },
    drainContainers: async () => {
      events.push('containers drained');
    },
    startService: () => {
      events.push('service start');
      if (options.migrateOnStart && fs.readFileSync(path.join(install, 'src/value.ts'), 'utf8').includes('new')) {
        fs.writeFileSync(path.join(install, 'data/v2.db'), 'forward-migrated-schema');
      }
    },
    verifyHealth: async () => health.shift() ?? true,
  };
  return { runtime, events };
}

/**
 * The sandbox this suite runs in has ~200-250MB free (see AGENT-BRIEF.md),
 * which is BELOW createSnapshot's own 256MB safety reserve — so the real
 * `fs.statfsSync` would trip "Not enough free space for mutable-state
 * snapshot" on every cutover, even for our tiny fixtures. We stub it to
 * report ample space by default; the dedicated low-space test below
 * overrides it back down to exercise the real throw.
 */
function stubAmpleDiskSpace(): void {
  vi.spyOn(fs, 'statfsSync').mockReturnValue({
    bavail: BigInt(10 * 1024 * 1024 * 1024),
    bsize: 1,
  } as unknown as ReturnType<typeof fs.statfsSync>);
}

afterEach(() => {
  if (updateDirSet) {
    if (previousUpdateDir === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
    else process.env.NANOCLAW_UPDATE_DIR = previousUpdateDir;
    updateDirSet = false;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('full transaction lifecycle (fixed for the realpath/tmpdir symlink condition above)', () => {
  it('stages, validates, cuts over, gates a breaking requirement, finishes, cleans up, and rolls back', async () => {
    const fixture = createForkFixture({ breaking: true });
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime, events } = fakeRuntime(fixture.install);

    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    expect(state.phase).toBe('prepared');
    expect(state.targetHead).not.toBe(fixture.originalHead);
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);

    state = await validateUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('validated');
    expect(state.skillRefresh?.success).toBe(true);
    expect(state.validation).toContain('host dependencies');
    expect(state.validation).toContain('host build');
    expect(state.validation).toContain('host tests');

    state = await cutoverUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('cutover');
    expect(fs.readFileSync(path.join(fixture.install, 'src/value.ts'), 'utf8')).toContain('new');
    expect(fs.readFileSync(path.join(fixture.install, 'local-customization.txt'), 'utf8')).toBe('keep me\n');
    expect(state.requirements).toHaveLength(1);
    expect(state.requirements[0].type).toBe('breaking-change');

    // acknowledgeRequirement + finishUpdate are gated on this requirement.
    await expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Unresolved migrations');

    state = acknowledgeRequirement(fixture.install, state.id, state.requirements[0].id, 'succeeded', undefined);
    expect(state.requirements[0].status).toBe('succeeded');

    state = await finishUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('complete');
    expect(events).toContain('service start');

    const summary = summarizeState(state);
    expect(summary.phase).toBe('complete');
    // cutover always snapshots mutable state before touching it, so a rollback
    // command is always available once cutover has run, success or not.
    expect(summary.rollback).toBe(`pnpm exec tsx scripts/update-nanoclaw.ts rollback --id ${state.id}`);

    const stageRoot = state.stageRoot;
    const stageBranch = state.stageBranch;
    state = cleanupUpdate(fixture.install, state.id, runtime);
    expect(state.stageCleanedAt).toBeTruthy();
    expect(fs.existsSync(stageRoot)).toBe(false);
    expect(() => exec(fixture.install, 'git', ['rev-parse', '--verify', stageBranch])).toThrow();
    expect(fs.existsSync(path.join(state.transactionRoot, 'snapshot'))).toBe(true);

    fs.writeFileSync(path.join(fixture.install, 'data/v2.db'), 'post-update-data');
    fs.writeFileSync(path.join(fixture.install, 'start-nanoclaw.sh'), '#!/bin/bash\nexit 1\n');
    fs.writeFileSync(path.join(fixture.install, 'nanoclaw.pid'), '9999\n');
    runtime.detectService = () => ({ mode: 'unmanaged', active: true });
    state = await rollbackUpdate(fixture.install, state.id, runtime);
    expect(state.phase).toBe('rolled-back');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.readFileSync(path.join(fixture.install, '.env'), 'utf8')).toBe('EXAMPLE=old\n');
    expect(fs.readFileSync(path.join(fixture.install, 'start-nanoclaw.sh'), 'utf8')).toBe(
      '#!/bin/bash\nnode dist/index.js\n',
    );
    expect(fs.readFileSync(path.join(fixture.install, 'nanoclaw.pid'), 'utf8')).toBe('1234\n');

    const summaryAfterRollback = summarizeState(state);
    expect(summaryAfterRollback.rollback).toBe(`pnpm exec tsx scripts/update-nanoclaw.ts rollback --id ${state.id}`);

    // loadState round-trips through the real filesystem.
    expect(loadState(fixture.install, state.id).phase).toBe('rolled-back');
  });
});

describe('createUpdateRuntime delegation', () => {
  it('wires each runtime method through to the underlying service.js functions', async () => {
    vi.resetModules();
    const mocks = {
      detectService: vi.fn(() => ({ mode: 'none', active: false }) as ServiceHandle),
      stopService: vi.fn(async () => {}),
      drainContainers: vi.fn(async () => {}),
      startService: vi.fn(() => {}),
      verifyServiceHealth: vi.fn(async () => true),
      createCommandRunner: vi.fn(() => ({ run: () => '', tryRun: () => ({ ok: true, stdout: '' }) }) as CommandRunner),
      defaultServiceEnvironment: vi.fn((runner: CommandRunner) => ({
        platform: 'linux' as NodeJS.Platform,
        home: '/home/test',
        uid: 0,
        runner,
        sleep: async () => {},
      })),
    };
    vi.doMock('./service.js', () => mocks);
    const { createUpdateRuntime: createUpdateRuntimeFresh } = await import('./transaction.js');

    const runtime = createUpdateRuntimeFresh();
    expect(mocks.defaultServiceEnvironment).toHaveBeenCalled();

    const handle = runtime.detectService('/root');
    expect(mocks.detectService).toHaveBeenCalledWith('/root', runtime.serviceEnv);
    expect(handle).toEqual({ mode: 'none', active: false });

    await runtime.stopService(handle);
    expect(mocks.stopService).toHaveBeenCalledWith(handle, runtime.serviceEnv);

    await runtime.drainContainers('/root');
    expect(mocks.drainContainers).toHaveBeenCalledWith('/root', runtime.serviceEnv);

    runtime.startService(handle, '/root');
    expect(mocks.startService).toHaveBeenCalledWith(handle, '/root', runtime.serviceEnv);

    await runtime.verifyHealth(handle, '/root');
    expect(mocks.verifyServiceHealth).toHaveBeenCalledWith(handle, '/root', runtime.serviceEnv);

    vi.doUnmock('./service.js');
  });
});

describe('defaultTransactionsRoot', () => {
  const originalEnv = process.env.NANOCLAW_UPDATE_DIR;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NANOCLAW_UPDATE_DIR;
    else process.env.NANOCLAW_UPDATE_DIR = originalEnv;
  });

  it('resolves NANOCLAW_UPDATE_DIR when set, ignoring the project root entirely', () => {
    process.env.NANOCLAW_UPDATE_DIR = '/tmp/custom-update-dir';
    expect(defaultTransactionsRoot('/some/project')).toBe(path.resolve('/tmp/custom-update-dir'));
  });

  it('derives a slug-scoped sibling directory when unset', () => {
    delete process.env.NANOCLAW_UPDATE_DIR;
    const root = defaultTransactionsRoot('/some/project');
    expect(root.startsWith(path.join('/some', '.nanoclaw-updates'))).toBe(true);
    expect(root).not.toContain('project');
  });
});

describe('loadState safety checks', () => {
  it('rejects an unsupported schema', () => {
    const projectRoot = temp('nanoclaw-tx-badschema-');
    useUpdateDir();
    const id = 'tx-1';
    const transactionRoot = path.join(process.env.NANOCLAW_UPDATE_DIR!, id);
    fs.mkdirSync(transactionRoot, { recursive: true });
    fs.writeFileSync(path.join(transactionRoot, 'state.json'), JSON.stringify({ schema: 'nanoclaw-update/v99' }));

    expect(() => loadState(projectRoot, id)).toThrow('Unsupported update state');
  });

  it('rejects a state whose recorded fields do not match the safe-path shape', () => {
    const projectRoot = temp('nanoclaw-tx-unsafe-');
    useUpdateDir();
    const id = 'tx-1';
    const transactionRoot = path.join(process.env.NANOCLAW_UPDATE_DIR!, id);
    fs.mkdirSync(transactionRoot, { recursive: true });
    fs.writeFileSync(
      path.join(transactionRoot, 'state.json'),
      JSON.stringify({
        schema: 'nanoclaw-update/v1',
        id: 'a-completely-different-id',
        projectRoot,
        transactionRoot,
        stageRoot: path.join(transactionRoot, 'worktree'),
        stageBranch: `update-nanoclaw/${id}`,
        backupBranch: 'backup/pre-update-aaaaaaaa-20260101000000-bbbbbbbb',
        backupTag: 'pre-update-aaaaaaaa-20260101000000-bbbbbbbb',
      }),
    );

    expect(() => loadState(projectRoot, id)).toThrow('Update state contains mismatched or unsafe paths');
  });
});

describe('prepareUpdate preconditions and strategies', () => {
  function initRepo(): string {
    const root = temp('nanoclaw-tx-prep-');
    exec(root, 'git', ['init', '-b', 'main']);
    write(root, 'file.txt', 'v1\n');
    commit(root, 'base');
    return root;
  }

  it('refuses to prepare from a detached HEAD', () => {
    // NOTE (surprising behavior, see final report): currentBranch() calls
    // git() — which uses the non-catching runner.run — for `symbolic-ref
    // --quiet --short HEAD`. Under the REAL createCommandRunner, a detached
    // HEAD makes that command exit non-zero, so run() throws a raw
    // "Command failed: git symbolic-ref ..." error before currentBranch's own
    // friendly `if (!branch) throw new Error('...not detached HEAD')` check
    // ever runs — that check is dead code against the real runner. We
    // reach it here by making the fake runner return '' instead of
    // throwing, the only way to observe this branch at all.
    const root = initRepo();
    const head = exec(root, 'git', ['rev-parse', 'HEAD']);
    exec(root, 'git', ['checkout', head]);
    useUpdateDir();
    const { runtime } = fakeRuntime(root, {
      gitOverride: (args) => (args[0] === 'symbolic-ref' ? { ok: true, stdout: '' } : undefined),
    });

    expect(() => prepareUpdate({ projectRoot: root, upstreamRef: head }, runtime)).toThrow('not detached HEAD');
  });

  it('refuses to prepare with a dirty working tree', () => {
    const root = initRepo();
    write(root, 'file.txt', 'dirty\n');
    useUpdateDir();
    const { runtime } = fakeRuntime(root);

    expect(() => prepareUpdate({ projectRoot: root, upstreamRef: 'HEAD' }, runtime)).toThrow(
      'Working tree must be clean',
    );
  });

  it('cherry-picks the given commits onto the staging branch', () => {
    const root = initRepo();
    write(root, 'other.txt', 'x\n');
    const pickMe = commit(root, 'pick me');
    exec(root, 'git', ['reset', '--hard', 'HEAD~1']);
    useUpdateDir();
    const { runtime } = fakeRuntime(root);

    const state = prepareUpdate(
      { projectRoot: root, upstreamRef: pickMe, strategy: 'cherry-pick', commits: [pickMe] },
      runtime,
    );

    expect(state.phase).toBe('prepared');
    expect(state.strategy).toBe('cherry-pick');
    expect(fs.existsSync(path.join(state.stageRoot, 'other.txt'))).toBe(true);
  });

  it('requires at least one commit for the cherry-pick strategy', () => {
    const root = initRepo();
    useUpdateDir();
    const { runtime } = fakeRuntime(root);

    expect(() =>
      prepareUpdate({ projectRoot: root, upstreamRef: 'HEAD', strategy: 'cherry-pick', commits: [] }, runtime),
    ).toThrow('Cherry-pick strategy requires at least one commit');
  });

  it('rebases onto the upstream ref when strategy is rebase', () => {
    const root = initRepo();
    const base = exec(root, 'git', ['rev-parse', 'HEAD']);
    write(root, 'upstream-file.txt', 'up\n');
    const upstream = commit(root, 'upstream change');
    exec(root, 'git', ['reset', '--hard', base]);
    write(root, 'local-file.txt', 'local\n');
    commit(root, 'local change');
    useUpdateDir();
    const { runtime } = fakeRuntime(root);

    const state = prepareUpdate({ projectRoot: root, upstreamRef: upstream, strategy: 'rebase' }, runtime);

    expect(state.phase).toBe('prepared');
    expect(fs.existsSync(path.join(state.stageRoot, 'upstream-file.txt'))).toBe(true);
    expect(fs.existsSync(path.join(state.stageRoot, 'local-file.txt'))).toBe(true);
  });

  it('lands in the conflict phase on a real merge conflict, and resumePreparedUpdate re-validates after resolution', () => {
    const root = initRepo();
    const base = exec(root, 'git', ['rev-parse', 'HEAD']);
    write(root, 'file.txt', 'upstream-version\n');
    const upstream = commit(root, 'upstream conflicting change');
    exec(root, 'git', ['reset', '--hard', base]);
    write(root, 'file.txt', 'local-version\n');
    commit(root, 'local conflicting change');
    useUpdateDir();
    const { runtime } = fakeRuntime(root);

    let state = prepareUpdate({ projectRoot: root, upstreamRef: upstream, strategy: 'merge' }, runtime);
    expect(state.phase).toBe('conflict');
    expect(state.lastError).toBeTruthy();

    // Resolve the conflict by hand in the staging worktree, then resume.
    write(state.stageRoot, 'file.txt', 'resolved-version\n');
    exec(state.stageRoot, 'git', ['add', 'file.txt']);
    exec(state.stageRoot, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--no-edit']);

    state = resumePreparedUpdate(root, state.id, runtime);
    expect(state.phase).toBe('prepared');
  });

  it('refuses to resume from a terminal phase', () => {
    const root = initRepo();
    useUpdateDir();
    const { runtime } = fakeRuntime(root);
    const state = prepareUpdate({ projectRoot: root, upstreamRef: 'HEAD' }, runtime);
    // Force a terminal phase directly on disk to exercise resumePreparedUpdate's guard.
    const loaded = loadState(root, state.id);
    loaded.phase = 'complete';
    fs.writeFileSync(path.join(loaded.transactionRoot, 'state.json'), `${JSON.stringify(loaded, null, 2)}\n`);

    expect(() => resumePreparedUpdate(root, state.id, runtime)).toThrow('Cannot resume from complete');
  });
});

describe('validateUpdate branches', () => {
  it('refuses to validate from a phase other than prepared/validated', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = { ...state, phase: 'cutover' };
    fs.writeFileSync(path.join(state.transactionRoot, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);

    await expect(validateUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Cannot validate from cutover');
  });

  it('surfaces a skill-refresh failure and records it on the state before rethrowing', async () => {
    const fixture = createForkFixture();
    // Reference an uninstalled skill name that update-skills.ts cannot find a
    // SKILL.md for, so refreshInstalledSkills reports success:false.
    write(fixture.install, 'src/channels/index.ts', "import './cli.js';\nimport './ghost.js';\n");
    exec(fixture.install, 'git', ['add', '.']);
    exec(fixture.install, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'reference an uninstalled skill',
    ]);
    fixture.originalHead = exec(fixture.install, 'git', ['rev-parse', 'HEAD']);
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);

    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    await expect(validateUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'One or more installed skills failed to refresh',
    );
    expect(loadState(fixture.install, state.id).lastError).toContain('failed to refresh');
  });

  it('commits real skill-refresh changes in the staging worktree before re-diffing', async () => {
    const fixture = createForkFixture({ withAppendSkill: true });
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);

    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    const validated = await validateUpdate(fixture.install, state.id, runtime);

    expect(validated.phase).toBe('validated');
    expect(fs.readFileSync(path.join(validated.stageRoot, 'MARKER.txt'), 'utf8')).toContain('installed-marker');
    // The refresh commit landed cleanly (commitStageChanges + refreshPreparedState's
    // own assertClean both succeeded), and the marker file is part of the diff.
    expect(validated.changedFiles).toContain('MARKER.txt');
  });

  it('runs the container typecheck when agent-runner files changed and bun is unavailable on the host', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    // hasChanged('container/agent-runner') is computed from the diff between
    // originalHead and targetHead in the staging worktree, so the simplest
    // deterministic way to land a real change under that path is to commit
    // one directly into the staging worktree after prepareUpdate creates it.
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    write(state.stageRoot, 'container/agent-runner/src/extra.ts', 'export {};\n');
    exec(state.stageRoot, 'git', ['add', '.']);
    exec(state.stageRoot, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'container/agent-runner change',
    ]);

    const validated = await validateUpdate(fixture.install, state.id, runtime);
    expect(validated.validation).toContain('container typecheck deferred to image build (Bun unavailable on host)');
  });

  it('runs the container install+typecheck when agent-runner files changed and bun IS available on the host', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const originalTryRun = runtime.runner.tryRun.bind(runtime.runner);
    runtime.runner.tryRun = (command, args, cwd) => {
      if (command === 'bun' && args[0] === '--version') return { ok: true, stdout: '1.3.12' };
      return originalTryRun(command, args, cwd);
    };

    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    write(state.stageRoot, 'container/agent-runner/src/extra.ts', 'export {};\n');
    exec(state.stageRoot, 'git', ['add', '.']);
    exec(state.stageRoot, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'container/agent-runner change',
    ]);

    const validated = await validateUpdate(fixture.install, state.id, runtime);
    expect(validated.validation).toContain('container dependencies and typecheck');
  });
});

describe('cutoverUpdate branches', () => {
  async function prepareAndValidate(fixture: Fixture, runtime: UpdateRuntime): Promise<UpdateState> {
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    return state;
  }

  it('refuses to cut over from a phase other than validated', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Cannot cut over from prepared');
  });

  it('refuses to cut over a validated update with a dirty live checkout', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    const state = await prepareAndValidate(fixture, runtime);
    write(fixture.install, 'uncommitted.txt', 'oops\n');

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Working tree must be clean');
  });

  it('refuses to cut over when the live checkout moved after staging', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    const state = await prepareAndValidate(fixture, runtime);
    write(fixture.install, 'moved.txt', 'drift\n');
    exec(fixture.install, 'git', ['add', '.']);
    exec(fixture.install, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'someone committed on the live checkout',
    ]);

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'Live checkout moved after the update was staged',
    );
  });

  it('restarts the previously-active service without restoring a snapshot when drainContainers fails', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime, events } = fakeRuntime(fixture.install);
    const state = await prepareAndValidate(fixture, runtime);
    runtime.drainContainers = async () => {
      throw new Error('containers refused to drain');
    };

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow('containers refused to drain');
    expect(events).toContain('service start');
    expect(loadState(fixture.install, state.id).snapshot).toBeUndefined();
  });

  it('automatically restores code and mutable state when installAndBuild fails after the snapshot was taken', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    const state = await prepareAndValidate(fixture, runtime);
    const originalRun = runtime.runner.run.bind(runtime.runner);
    let installCalls = 0;
    runtime.runner.run = (command, args, cwd) => {
      // Fail only the FIRST post-validate pnpm install (cutover's own
      // installAndBuild) so the automatic rollback's own reinstall — the
      // same command, run again as part of restoring the previous code —
      // is allowed to succeed instead of recursively failing itself.
      if (command === 'pnpm' && args[0] === 'install') {
        installCalls += 1;
        if (installCalls === 1) throw new Error('pnpm install exploded');
      }
      return originalRun(command, args, cwd);
    };

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow('pnpm install exploded');
    const rolledBack = loadState(fixture.install, state.id);
    expect(rolledBack.phase).toBe('rolled-back');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
  });

  it('refuses to cut over a validated state whose target commit was stripped', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    const state = await prepareAndValidate(fixture, runtime);
    const tampered: UpdateState = { ...state, targetHead: undefined };
    fs.writeFileSync(path.join(state.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'Validated update has no target commit',
    );
  });

  it('snapshots a symlinked mutable path and runs the hardened-image build when container files changed', async () => {
    const fixture = createForkFixture();
    fs.rmSync(path.join(fixture.install, '.env'));
    fs.symlinkSync('/etc/hosts', path.join(fixture.install, '.env'));
    write(fixture.install, '.env.real-marker', 'unused\n'); // keep dir non-empty guard away
    exec(fixture.install, 'git', ['add', '.env.real-marker']);
    exec(fixture.install, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'symlink .env for the snapshot test',
    ]);
    fixture.originalHead = exec(fixture.install, 'git', ['rev-parse', 'HEAD']);
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    // hasChanged() is read from state.changedFiles as last computed by
    // validateUpdate (cutoverUpdate never recomputes it), so the container
    // change must land in the staging worktree BEFORE validateUpdate runs.
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    write(state.stageRoot, 'container/build.sh', 'echo build\n');
    exec(state.stageRoot, 'git', ['add', '.']);
    exec(state.stageRoot, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'container change',
    ]);
    state = await validateUpdate(fixture.install, state.id, runtime);

    const cutOver = await cutoverUpdate(fixture.install, state.id, runtime);

    expect(cutOver.phase).toBe('cutover');
    const snapshotEnv = path.join(cutOver.transactionRoot, 'snapshot', '.env');
    expect(fs.lstatSync(snapshotEnv).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(snapshotEnv)).toBe('/etc/hosts');
  });

  it('passes `pull` to the hardened-image build script when NANOCLAW_HARDENED_IMAGE=true is set', async () => {
    const fixture = createForkFixture();
    // .env is gitignored (see the fixture's .gitignore) — it's still read
    // directly off disk by installAndBuild after `git reset --hard`, so no
    // add/commit is needed (and would fail: an ignored file stages nothing).
    write(fixture.install, '.env', 'NANOCLAW_HARDENED_IMAGE=true\n');
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime, events } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    write(state.stageRoot, 'container/build.sh', 'echo build\n');
    exec(state.stageRoot, 'git', ['add', '.']);
    exec(state.stageRoot, 'git', [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'container change',
    ]);
    state = await validateUpdate(fixture.install, state.id, runtime);

    await cutoverUpdate(fixture.install, state.id, runtime);

    expect(events).toContain('bash container/build.sh pull');
  });

  it('refuses to snapshot when the filesystem is too low on free space (real fs.statfsSync)', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = await prepareAndValidate(fixture, runtime);
    vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: BigInt(1), bsize: 1 } as unknown as ReturnType<
      typeof fs.statfsSync
    >);

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'Not enough free space for mutable-state snapshot',
    );
  });
});

describe('acknowledgeRequirement branches', () => {
  it('refuses to acknowledge outside the cutover phase', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    expect(() => acknowledgeRequirement(fixture.install, state.id, 'whatever', 'succeeded', undefined)).toThrow(
      'Cannot acknowledge requirements from prepared',
    );
  });

  it('rejects an unknown requirement id', async () => {
    const fixture = createForkFixture({ breaking: true });
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    expect(() =>
      acknowledgeRequirement(fixture.install, state.id, 'ghost-requirement', 'succeeded', undefined),
    ).toThrow('Unknown requirement: ghost-requirement');
  });

  it('requires an exact rollback instruction to mark an external-component requirement succeeded, and records the one given', async () => {
    const fixture = createForkFixture({ externalPinMove: true });
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    const requirementId = state.requirements[0].id;
    // The fixture's requirement already carries a default rollback instruction
    // (see externalRequirements), so clear it here to force the explicit-arg path.
    const loaded = loadState(fixture.install, state.id);
    loaded.requirements[0].rollback = undefined;
    fs.writeFileSync(path.join(loaded.transactionRoot, 'state.json'), `${JSON.stringify(loaded, null, 2)}\n`);

    expect(() => acknowledgeRequirement(fixture.install, state.id, requirementId, 'succeeded', undefined)).toThrow(
      'needs an exact rollback instruction',
    );

    const acked = acknowledgeRequirement(fixture.install, state.id, requirementId, 'succeeded', 'roll back by hand');
    expect(acked.requirements[0]).toMatchObject({ status: 'succeeded', rollback: 'roll back by hand' });
  });
});

describe('finishUpdate branches', () => {
  it('refuses to finish outside the cutover phase', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    return expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toThrow('Cannot finish from prepared');
  });

  it('automatically restores the previous checkout when the post-cutover health check fails', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install, { health: [false, true], migrateOnStart: true });
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    await expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toThrow('health verification');
    expect(exec(fixture.install, 'git', ['rev-parse', 'HEAD'])).toBe(fixture.originalHead);
    expect(fs.readFileSync(path.join(fixture.install, 'data/v2.db'), 'utf8')).toBe('old-schema');
    expect(fs.existsSync(path.join(fixture.install, 'data/upgrade-state.json'))).toBe(false);
    expect(loadState(fixture.install, state.id).phase).toBe('rolled-back');
  });

  it("falls back to restoreSnapshot's own guard when a rollback is attempted against a state whose snapshot was stripped", async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    // Tamper the persisted state to simulate operator/manual corruption: phase
    // says 'cutover' (so finishUpdate's own guard passes) but the snapshot
    // captured during cutover is gone. finishUpdate's catch always calls
    // rollbackLocal unconditionally, so this is the only way to observe
    // restoreSnapshot's own "No mutable-state snapshot exists" guard — every
    // reachable path through the public API always has a snapshot by the time
    // rollbackLocal runs.
    const tampered = loadState(fixture.install, state.id);
    tampered.snapshot = undefined;
    fs.writeFileSync(path.join(tampered.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);
    const originalRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd) => {
      if (command === 'pnpm' && args.some((a) => a.includes('upgrade-state.ts'))) {
        throw new Error('upgrade-state stamp failed');
      }
      return originalRun(command, args, cwd);
    };

    await expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toThrow('No mutable-state snapshot exists');
  });
});

describe('rollbackUpdate, rollbackLocal guards', () => {
  it('refuses to roll back an update with no snapshot', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'has no mutable-state snapshot to restore',
    );
  });

  it('refuses to roll back a snapshot whose state carries no captured service handle', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    const tampered = loadState(fixture.install, state.id);
    tampered.service = undefined;
    fs.writeFileSync(path.join(tampered.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);

    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'no captured service handle for rollback',
    );
  });

  it('surfaces a post-rollback health check failure', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    runtime.verifyHealth = async () => false;

    await expect(rollbackUpdate(fixture.install, state.id, runtime)).rejects.toThrow(
      'previous service failed health verification',
    );
  });
});

describe('cleanupUpdate + removeStageArtifacts + deleteBranch/deleteTag branches', () => {
  it('refuses to clean up outside complete/rolled-back', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    expect(() => cleanupUpdate(fixture.install, state.id, runtime)).toThrow(
      'Cannot clean staging artifacts from prepared',
    );
  });

  it('falls back to `worktree prune` when the worktree directory is already gone', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install, {
      gitOverride: (args) =>
        args[0] === 'worktree' && args[1] === 'remove' ? { ok: false, stdout: 'already gone' } : undefined,
    });
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    fs.rmSync(state.stageRoot, { recursive: true, force: true });
    const tampered = { ...state, phase: 'complete' as const };
    fs.writeFileSync(path.join(state.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);

    const cleaned = cleanupUpdate(fixture.install, state.id, runtime);
    expect(cleaned.stageCleanedAt).toBeTruthy();
  });

  it('throws when `worktree remove` fails but the directory genuinely still exists', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install, {
      gitOverride: (args) =>
        args[0] === 'worktree' && args[1] === 'remove' ? { ok: false, stdout: 'locked' } : undefined,
    });
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    const tampered = { ...state, phase: 'complete' as const };
    fs.writeFileSync(path.join(state.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);

    expect(() => cleanupUpdate(fixture.install, state.id, runtime)).toThrow('Could not remove staging worktree');
    expect(fs.existsSync(state.stageRoot)).toBe(true); // left in place, matching the thrown message
  });

  it('throws when the update branch survives a failed `branch -D`', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install, {
      gitOverride: (args) => (args[0] === 'branch' && args[1] === '-D' ? { ok: false, stdout: 'refused' } : undefined),
    });
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    const tampered = { ...state, phase: 'complete' as const };
    fs.writeFileSync(path.join(state.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);

    // The worktree removes cleanly for real; only the branch delete is faked.
    expect(() => cleanupUpdate(fixture.install, state.id, runtime)).toThrow('Could not remove update branch');
  });

  it('throws when the backup tag survives a failed `tag -d` (exercised via abandonUpdate)', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install, {
      gitOverride: (args) => (args[0] === 'tag' && args[1] === '-d' ? { ok: false, stdout: 'refused' } : undefined),
    });
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    expect(() => abandonUpdate(fixture.install, state.id, runtime)).toThrow('Could not remove update tag');
  });
});

describe('abandonUpdate branches', () => {
  it('refuses to abandon after cutover', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);

    expect(() => abandonUpdate(fixture.install, state.id, runtime)).toThrow('Cannot abandon an update after cutover');
  });

  it('removes the staging worktree/branch and the backup branch/tag, and marks the transaction abandoned', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    const abandoned = abandonUpdate(fixture.install, state.id, runtime);

    expect(abandoned.phase).toBe('abandoned');
    expect(abandoned.completedAt).toBeTruthy();
    expect(fs.existsSync(state.stageRoot)).toBe(false);
    expect(() => exec(fixture.install, 'git', ['rev-parse', '--verify', state.backupBranch])).toThrow();
    expect(() => exec(fixture.install, 'git', ['rev-parse', '--verify', `refs/tags/${state.backupTag}`])).toThrow();
  });
});

describe('pruneTransactions branches', () => {
  it('refuses to run against an unsafe transaction root (the project root itself)', () => {
    const fixture = createForkFixture();
    previousUpdateDir = process.env.NANOCLAW_UPDATE_DIR;
    updateDirSet = true;
    process.env.NANOCLAW_UPDATE_DIR = fixture.install;
    const { runtime } = fakeRuntime(fixture.install);

    expect(() => pruneTransactions(fixture.install, 'whatever', true, runtime)).toThrow('Unsafe transaction root');
  });

  it('retains a transaction whose state.json is corrupt instead of touching it', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const keepState = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    const corruptId = 'corrupt-transaction';
    const corruptRoot = path.join(process.env.NANOCLAW_UPDATE_DIR!, corruptId);
    fs.mkdirSync(corruptRoot, { recursive: true });
    fs.writeFileSync(path.join(corruptRoot, 'state.json'), 'not valid json{{{');

    const report = pruneTransactions(fixture.install, keepState.id, true, runtime);
    expect(report.retained).toContain(corruptId);
    expect(report.removed).not.toContain(corruptId);
  });

  it('ignores stray non-directory entries under the transactions root', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const keepState = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    fs.writeFileSync(path.join(process.env.NANOCLAW_UPDATE_DIR!, 'a-stray-file.txt'), 'not a transaction');

    const report = pruneTransactions(fixture.install, keepState.id, true, runtime);
    expect(report.removed).toEqual([]);
    // The stray file is silently skipped (never pushed to either list); the
    // kept transaction itself is always retained.
    expect(report.retained).toEqual([keepState.id]);
  });

  /**
   * abandonUpdate() itself deletes the backup branch/tag as part of
   * abandoning, so building "terminal" fixtures with it would leave nothing
   * real for pruneTransactions' OWN backup-branch/tag cleanup to remove.
   * Instead we tamper `phase` directly to a terminal value on disk, leaving
   * the real worktree/stageBranch/backupBranch/backupTag from prepareUpdate
   * intact so prune's own removeStageArtifacts/deleteBranch/deleteTag calls
   * have real git state to act on.
   */
  function markTerminal(state: UpdateState, phase: UpdateState['phase'], createdAt: string): void {
    const tampered = { ...state, phase, createdAt };
    fs.writeFileSync(path.join(state.transactionRoot, 'state.json'), `${JSON.stringify(tampered, null, 2)}\n`);
  }

  it('removes only older terminal transactions, deleting their distinct backup branch/tag, and keeps the selected rollback point', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);

    const older = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    markTerminal(older, 'rolled-back', '2000-01-01T00:00:00.000Z');

    const keep = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    markTerminal(keep, 'complete', '2030-01-01T00:00:00.000Z');

    // A pending (non-terminal) transaction that must never be touched.
    const pending = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    const preview = pruneTransactions(fixture.install, keep.id, true, runtime);
    expect(preview.removed).toEqual([older.id]);
    expect(fs.existsSync(older.transactionRoot)).toBe(true); // dry run touches nothing

    const report = pruneTransactions(fixture.install, keep.id, false, runtime);
    expect(report.removed).toEqual([older.id]);
    expect(report.retained.sort()).toEqual([keep.id, pending.id].sort());
    expect(fs.existsSync(older.transactionRoot)).toBe(false);
    expect(fs.existsSync(keep.transactionRoot)).toBe(true);
    expect(fs.existsSync(pending.transactionRoot)).toBe(true);
    expect(fs.existsSync(older.stageRoot)).toBe(false);
    expect(() => exec(fixture.install, 'git', ['rev-parse', '--verify', older.backupBranch])).toThrow();
    expect(() => exec(fixture.install, 'git', ['rev-parse', '--verify', `refs/tags/${older.backupTag}`])).toThrow();
    // The kept transaction's own backup branch/tag must survive.
    expect(exec(fixture.install, 'git', ['rev-parse', '--verify', keep.backupBranch])).toBeTruthy();
  });

  it('skips deleting the backup branch/tag when they are shared with the kept transaction', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const older = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    // Keep shares the same backup branch/tag as `older` (simulating two
    // transaction records that happened to point at the same backup) — the
    // delete-tag/delete-branch calls for `older` must then be SKIPPED, since
    // deleting them would also break the kept transaction's rollback point.
    const keep = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    const keepTampered = {
      ...keep,
      phase: 'complete' as const,
      createdAt: '2030-01-01T00:00:00.000Z',
      backupBranch: older.backupBranch,
      backupTag: older.backupTag,
    };
    fs.writeFileSync(path.join(keep.transactionRoot, 'state.json'), `${JSON.stringify(keepTampered, null, 2)}\n`);
    markTerminal(older, 'rolled-back', '2000-01-01T00:00:00.000Z');

    pruneTransactions(fixture.install, keep.id, false, runtime);

    // `older`'s backup branch/tag are untouched because they're shared with `keep`.
    expect(exec(fixture.install, 'git', ['rev-parse', '--verify', older.backupBranch])).toBeTruthy();
    expect(exec(fixture.install, 'git', ['rev-parse', '--verify', `refs/tags/${older.backupTag}`])).toBeTruthy();
  });

  it('treats a transactions root that does not exist yet as having nothing to scan', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const keep = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    const root = path.resolve(process.env.NANOCLAW_UPDATE_DIR!);
    // loadState(keepId) only reads the one file it needs, so it succeeds even
    // when we spy fs.existsSync to report the transactions ROOT itself as
    // absent — the only way to exercise this defensive branch, since a real
    // pruneTransactions call always has the root on disk by the time it
    // reaches the loop (loadState already proved a file inside it exists).
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((p) => (p === root ? false : fs.existsSync(p)));
    try {
      const report = pruneTransactions(fixture.install, keep.id, true, runtime);
      expect(report).toEqual({
        schema: 'nanoclaw-update-prune/v1',
        keepId: keep.id,
        dryRun: true,
        removed: [],
        retained: [],
      });
    } finally {
      existsSpy.mockRestore();
    }
  });
});

describe('remaining branch edges', () => {
  it('externalRequirements reports "absent" when a component key is missing on one side', async () => {
    const seed = temp('nanoclaw-update-absent-seed-');
    exec(seed, 'git', ['init', '-b', 'main']);
    write(seed, 'package.json', '{"name":"t","version":"1.0.0"}\n');
    write(seed, '.gitignore', 'data/\n.env\nstart-nanoclaw.sh\nnanoclaw.pid\n');
    write(seed, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    write(seed, 'src/channels/index.ts', "import './cli.js';\n");
    write(seed, 'src/providers/index.ts', '');
    write(seed, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
    write(seed, 'versions.json', '{"onecli-cli":"1.0.0"}\n'); // onecli-gateway absent on the "before" side
    write(seed, 'CHANGELOG.md', '# Changelog\n');
    commit(seed, 'base');

    const official = temp('nanoclaw-update-absent-official-');
    fs.rmSync(official, { recursive: true });
    exec(path.dirname(official), 'git', ['clone', '--bare', seed, official]);
    const fork = temp('nanoclaw-update-absent-fork-');
    fs.rmSync(fork, { recursive: true });
    exec(path.dirname(fork), 'git', ['clone', '--bare', official, fork]);

    write(seed, 'versions.json', '{"onecli-gateway":"1.0.0","onecli-cli":"1.0.0"}\n'); // now present
    const upstreamHead = commit(seed, 'add onecli-gateway pin');
    exec(seed, 'git', ['remote', 'add', 'publish', official]);
    exec(seed, 'git', ['push', 'publish', 'main']);

    const install = temp('nanoclaw-update-absent-install-');
    fs.rmSync(install, { recursive: true });
    exec(path.dirname(install), 'git', ['clone', fork, install]);
    exec(install, 'git', ['config', 'user.name', 'Test']);
    exec(install, 'git', ['config', 'user.email', 'test@example.com']);
    exec(install, 'git', ['remote', 'add', 'upstream', official]);
    exec(install, 'git', ['fetch', 'upstream']);

    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(install);
    let state = prepareUpdate({ projectRoot: install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(install, state.id, runtime);
    state = await cutoverUpdate(install, state.id, runtime);

    expect(state.requirements).toMatchObject([
      {
        description: 'onecli-gateway: absent → 1.0.0',
        rollback: 'Restore onecli-gateway to the previously installed version',
      },
    ]);
    void upstreamHead;
  });

  it('externalRequirements reports "absent" for the AFTER side when a component key is removed', async () => {
    const seed = temp('nanoclaw-update-absentafter-seed-');
    exec(seed, 'git', ['init', '-b', 'main']);
    write(seed, 'package.json', '{"name":"t","version":"1.0.0"}\n');
    write(seed, '.gitignore', 'data/\n.env\nstart-nanoclaw.sh\nnanoclaw.pid\n');
    write(seed, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    write(seed, 'src/channels/index.ts', "import './cli.js';\n");
    write(seed, 'src/providers/index.ts', '');
    write(seed, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\n");
    write(seed, 'versions.json', '{"onecli-gateway":"1.0.0","onecli-cli":"1.0.0"}\n'); // present before
    write(seed, 'CHANGELOG.md', '# Changelog\n');
    commit(seed, 'base');

    const official = temp('nanoclaw-update-absentafter-official-');
    fs.rmSync(official, { recursive: true });
    exec(path.dirname(official), 'git', ['clone', '--bare', seed, official]);
    const fork = temp('nanoclaw-update-absentafter-fork-');
    fs.rmSync(fork, { recursive: true });
    exec(path.dirname(fork), 'git', ['clone', '--bare', official, fork]);

    write(seed, 'versions.json', '{"onecli-cli":"1.0.0"}\n'); // onecli-gateway removed
    commit(seed, 'drop onecli-gateway pin');
    exec(seed, 'git', ['remote', 'add', 'publish', official]);
    exec(seed, 'git', ['push', 'publish', 'main']);

    const install = temp('nanoclaw-update-absentafter-install-');
    fs.rmSync(install, { recursive: true });
    exec(path.dirname(install), 'git', ['clone', fork, install]);
    exec(install, 'git', ['config', 'user.name', 'Test']);
    exec(install, 'git', ['config', 'user.email', 'test@example.com']);
    exec(install, 'git', ['remote', 'add', 'upstream', official]);
    exec(install, 'git', ['fetch', 'upstream']);

    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(install);
    let state = prepareUpdate({ projectRoot: install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(install, state.id, runtime);
    state = await cutoverUpdate(install, state.id, runtime);

    expect(state.requirements).toMatchObject([{ description: 'onecli-gateway: 1.0.0 → absent' }]);
  });

  it('records the strategy-needs-conflict-resolution fallback message when git reports no conflict detail', async () => {
    const root = temp('nanoclaw-update-emptyconflict-');
    exec(root, 'git', ['init', '-b', 'main']);
    write(root, 'file.txt', 'v1\n');
    commit(root, 'base');
    const upstream = exec(root, 'git', ['rev-parse', 'HEAD']);
    useUpdateDir();
    const { runtime } = fakeRuntime(root, {
      gitOverride: (args) => (args[0] === 'merge' ? { ok: false, stdout: '' } : undefined),
    });

    const state = prepareUpdate({ projectRoot: root, upstreamRef: upstream, strategy: 'merge' }, runtime);

    expect(state.phase).toBe('conflict');
    expect(state.lastError).toBe('merge needs conflict resolution');
  });

  it('stringifies a non-Error rejection inside validateUpdate before rethrowing', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const originalRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd) => {
      if (command === 'pnpm' && args[0] === 'install') {
        // eslint-disable-next-line no-throw-literal
        throw 'raw pnpm failure';
      }
      return originalRun(command, args, cwd);
    };
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    await expect(validateUpdate(fixture.install, state.id, runtime)).rejects.toBe('raw pnpm failure');
    expect(loadState(fixture.install, state.id).lastError).toBe('raw pnpm failure');
  });

  it('stringifies a non-Error rejection inside cutoverUpdate before rethrowing, and skips restart when the captured service was inactive', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    runtime.detectService = () => ({ mode: 'none', active: false });
    runtime.drainContainers = async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'raw drain failure';
    };
    const startSpy = vi.fn();
    runtime.startService = startSpy;

    await expect(cutoverUpdate(fixture.install, state.id, runtime)).rejects.toBe('raw drain failure');
    expect(loadState(fixture.install, state.id).lastError).toBe('raw drain failure');
    expect(startSpy).not.toHaveBeenCalled(); // service was never active, so no restart attempt
  });

  it('stringifies a non-Error rejection inside finishUpdate before rethrowing', async () => {
    const fixture = createForkFixture();
    useUpdateDir();
    stubAmpleDiskSpace();
    const { runtime } = fakeRuntime(fixture.install);
    let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
    state = await validateUpdate(fixture.install, state.id, runtime);
    state = await cutoverUpdate(fixture.install, state.id, runtime);
    const originalRun = runtime.runner.run.bind(runtime.runner);
    runtime.runner.run = (command, args, cwd) => {
      if (command === 'pnpm' && args.some((a) => a.includes('upgrade-state.ts'))) {
        // eslint-disable-next-line no-throw-literal
        throw 'raw upgrade-state failure';
      }
      return originalRun(command, args, cwd);
    };

    await expect(finishUpdate(fixture.install, state.id, runtime)).rejects.toBe('raw upgrade-state failure');
  });

  it('copyEntry silently skips ephemeral special files (e.g. a unix domain socket) instead of copying them', async () => {
    const net = await import('node:net');
    const fixture = createForkFixture();
    const socketPath = path.join(fixture.install, 'data', 'weird.sock');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(socketPath, resolve);
      server.once('error', reject);
    });
    try {
      useUpdateDir();
      stubAmpleDiskSpace();
      const { runtime } = fakeRuntime(fixture.install);
      let state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);
      state = await validateUpdate(fixture.install, state.id, runtime);
      state = await cutoverUpdate(fixture.install, state.id, runtime);

      const snapshotSocket = path.join(state.transactionRoot, 'snapshot', 'data', 'weird.sock');
      expect(fs.existsSync(snapshotSocket)).toBe(false);
      // The rest of `data/` was still copied normally.
      expect(fs.existsSync(path.join(state.transactionRoot, 'snapshot', 'data', 'v2.db'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('summarizeState omits the rollback command for a state with no snapshot yet', () => {
    const fixture = createForkFixture();
    useUpdateDir();
    const { runtime } = fakeRuntime(fixture.install);
    const state = prepareUpdate({ projectRoot: fixture.install, upstreamRef: 'upstream/main' }, runtime);

    expect(summarizeState(state).rollback).toBeUndefined();
  });
});

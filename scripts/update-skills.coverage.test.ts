import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectInstalledSkills,
  portableDependencyCommand,
  refreshInstalledSkills,
  resolveRegistryRemote,
} from './update-skills.js';

const tempRoots: string[] = [];
const originalEnv = { ...process.env };
const originalArgv = process.argv;

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(root: string, message: string): void {
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  process.env = { ...originalEnv };
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('portableDependencyCommand', () => {
  it('requires an exact BUN_VERSION pin when bun is unavailable on the host', () => {
    const root = temp('nanoclaw-skills-badpin-');
    write(root, 'container/Dockerfile', 'FROM node:20\n');
    expect(() =>
      portableDependencyCommand(root, false, { manager: 'bun', action: 'add', packages: ['x'], cwd: '' }),
    ).toThrow('container/Dockerfile does not declare an exact BUN_VERSION');
  });

  it('wraps bun through a cwd-prefixed pnpm dlx when unavailable on the host', () => {
    const root = temp('nanoclaw-skills-pin-');
    write(root, 'container/Dockerfile', 'ARG BUN_VERSION=1.2.9\n');
    expect(
      portableDependencyCommand(root, false, {
        manager: 'bun',
        action: 'add',
        packages: ['x', 'y'],
        cwd: 'container/agent-runner',
      }),
    ).toBe('cd container/agent-runner && pnpm --package=bun@1.2.9 dlx bun add x y');
  });

  it('calls bun directly with no cwd prefix when it is available on the host', () => {
    const root = temp('nanoclaw-skills-hostbun-');
    expect(portableDependencyCommand(root, true, { manager: 'bun', action: 'remove', packages: ['x'], cwd: '' })).toBe(
      'bun remove x',
    );
  });

  it('passes non-bun managers through unchanged regardless of host bun availability', () => {
    const root = temp('nanoclaw-skills-npm-');
    expect(portableDependencyCommand(root, false, { manager: 'pnpm', action: 'add', packages: ['x'], cwd: '' })).toBe(
      'pnpm add x',
    );
  });
});

describe('detectInstalledSkills with nothing installed', () => {
  it('returns an empty list when neither channel nor provider index files exist', () => {
    const root = temp('nanoclaw-skills-empty-');
    expect(detectInstalledSkills(root)).toEqual([]);
  });
});

describe('resolveRegistryRemote', () => {
  function initRepoWithRemote(remoteName: string, remoteUrl: string): string {
    const root = temp('nanoclaw-skills-remote-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'README.md', 'seed\n');
    commit(root, 'seed');
    run(root, 'git', ['remote', 'add', remoteName, remoteUrl]);
    return root;
  }

  function bareRepoWithBranch(branch: string | null): string {
    const seed = temp('nanoclaw-skills-bare-seed-');
    run(seed, 'git', ['init', '-b', 'main']);
    write(seed, 'README.md', 'seed\n');
    commit(seed, 'seed');
    if (branch) {
      run(seed, 'git', ['checkout', '-b', branch]);
      write(seed, 'marker.txt', branch);
      commit(seed, branch);
      run(seed, 'git', ['checkout', 'main']);
    }
    const bareParent = temp('nanoclaw-skills-bare-');
    fs.rmSync(bareParent, { recursive: true });
    run(path.dirname(bareParent), 'git', ['clone', '--bare', seed, bareParent]);
    return bareParent;
  }

  it('uses an explicit override remote when it exists and carries the branch', () => {
    const bare = bareRepoWithBranch('channels');
    const root = initRepoWithRemote('registry', bare);
    process.env.NANOCLAW_REGISTRY_REMOTE = 'registry';

    expect(resolveRegistryRemote(root, 'channels')).toBe('registry');
  });

  it('rejects an override remote that is not configured', () => {
    const root = initRepoWithRemote('origin', bareRepoWithBranch('channels'));
    process.env.NANOCLAW_REGISTRY_REMOTE = 'ghost';

    expect(() => resolveRegistryRemote(root, 'channels')).toThrow('Registry remote ghost does not exist');
  });

  it('rejects an override remote that does not carry the requested branch', () => {
    const bare = bareRepoWithBranch(null);
    const root = initRepoWithRemote('registry', bare);
    process.env.NANOCLAW_REGISTRY_REMOTE = 'registry';

    expect(() => resolveRegistryRemote(root, 'channels')).toThrow('Registry remote registry has no channels branch');
  });

  it('falls back to NANOCLAW_CHANNELS_REMOTE when the primary override is unset', () => {
    const bare = bareRepoWithBranch('channels');
    const root = initRepoWithRemote('registry', bare);
    process.env.NANOCLAW_CHANNELS_REMOTE = 'registry';

    expect(resolveRegistryRemote(root, 'channels')).toBe('registry');
  });

  it('prefers origin first, then falls through remotes in order when origin lacks the branch', () => {
    const originBare = bareRepoWithBranch(null);
    const secondBare = bareRepoWithBranch('channels');
    const root = initRepoWithRemote('origin', originBare);
    run(root, 'git', ['remote', 'add', 'upstream', secondBare]);

    expect(resolveRegistryRemote(root, 'channels')).toBe('upstream');
  });

  it('treats a remote whose ls-remote call errors (e.g. an unreachable URL) as branch-not-found', () => {
    const root = initRepoWithRemote('registry', '/nonexistent/path/does-not-exist.git');
    process.env.NANOCLAW_REGISTRY_REMOTE = 'registry';

    expect(() => resolveRegistryRemote(root, 'channels')).toThrow('Registry remote registry has no channels branch');
  });

  it('throws when no configured remote carries the registry branch', () => {
    const root = initRepoWithRemote('origin', bareRepoWithBranch(null));

    expect(() => resolveRegistryRemote(root, 'channels')).toThrow(
      'No configured remote carries the channels registry branch',
    );
  });

  it('walks remotes in `git remote` order when none of them is named origin', () => {
    const firstBare = bareRepoWithBranch(null);
    const secondBare = bareRepoWithBranch('channels');
    const root = initRepoWithRemote('alpha', firstBare);
    run(root, 'git', ['remote', 'add', 'beta', secondBare]);

    expect(resolveRegistryRemote(root, 'channels')).toBe('beta');
  });
});

describe('refreshInstalledSkills real commandAvailable + success path', () => {
  it('falls back to pnpm dlx bun when the real host lookup finds no bun binary, and records a refreshed skill', async () => {
    const root = temp('nanoclaw-skills-realcheck-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './opencode.js';\n");
    write(root, 'container/Dockerfile', 'ARG BUN_VERSION=1.3.12\n');
    write(
      root,
      '.claude/skills/add-opencode/SKILL.md',
      ['# Apply', '```nc:dep manager:bun cwd:container/agent-runner', 'example-provider@1.2.3', '```'].join('\n'),
    );
    const commands: string[] = [];
    const originalPath = process.env.PATH;
    process.env.PATH = ''; // real commandAvailable('bun', ...) must now hit its catch branch
    try {
      const report = await refreshInstalledSkills(root, 'all', {
        exec: (command) => {
          commands.push(command);
        },
      });
      expect(report.success, JSON.stringify(report, null, 2)).toBe(true);
      expect(report.skills[0]).toMatchObject({ name: 'opencode', status: 'refreshed' });
      expect(commands).toEqual([
        'cd container/agent-runner && pnpm --package=bun@1.3.12 dlx bun add example-provider@1.2.3',
      ]);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('refreshInstalledSkills edge cases', () => {
  it('rejects a requested skill name that is not installed', async () => {
    const root = temp('nanoclaw-skills-missingreq-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './slack.js';\n");

    await expect(refreshInstalledSkills(root, ['slack', 'ghost-channel'])).rejects.toThrow(
      'Requested skills are not installed: ghost-channel',
    );
  });

  it('narrows to the requested subset by name or skill name', async () => {
    const root = temp('nanoclaw-skills-subset-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './slack.js';\nimport './discord.js';\n");
    write(root, '.claude/skills/add-slack/SKILL.md', '# Apply\nProse only.\n');

    const report = await refreshInstalledSkills(root, ['add-slack']);

    expect(report.selected).toEqual(['slack']);
  });

  it('reports a missing SKILL.md as a structured failure', async () => {
    const root = temp('nanoclaw-skills-noskillmd-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './ghost.js';\n");

    const report = await refreshInstalledSkills(root);

    expect(report.success).toBe(false);
    expect(report.skills[0]).toMatchObject({ name: 'ghost', status: 'failed' });
    expect(report.skills[0].errors[0]).toContain('Missing');
    expect(report.skills[0].errors[0]).toContain(path.join('.claude/skills/add-ghost/SKILL.md'));
  });

  it('marks a skill failed (not refreshed) when applySkill bounces a directive to an agent', async () => {
    const root = temp('nanoclaw-skills-bounce-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './demo.js';\n");
    write(
      root,
      '.claude/skills/add-demo/SKILL.md',
      ['# Apply', '```nc:json-merge into:some/file.json key:foo', 'not valid json', '```'].join('\n'),
    );

    const report = await refreshInstalledSkills(root);

    expect(report.success).toBe(false);
    expect(report.skills[0]).toMatchObject({ name: 'demo', status: 'failed' });
    expect(report.skills[0].errors).toEqual(['no deterministic handler']);
  });

  it('stringifies a non-Error rejection from applySkill instead of crashing', async () => {
    vi.resetModules();
    vi.doMock('./skill-apply.js', () => ({
      applySkill: vi.fn().mockRejectedValue('a raw string failure'),
      fullyApplied: () => false,
    }));
    const { refreshInstalledSkills: refreshWithMockedApply } = await import('./update-skills.js');

    const root = temp('nanoclaw-skills-crash-string-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './demo.js';\n");
    write(
      root,
      '.claude/skills/add-demo/SKILL.md',
      ['# Apply', '```nc:copy from-branch:channels', 'src/channels/demo.ts', '```'].join('\n'),
    );

    const report = await refreshWithMockedApply(root);

    expect(report.skills[0]).toMatchObject({ name: 'demo', status: 'failed' });
    expect(report.skills[0].errors).toEqual(['a raw string failure']);
  });

  it('surfaces an unexpected applySkill rejection as a failed result instead of throwing', async () => {
    vi.resetModules();
    vi.doMock('./skill-apply.js', () => ({
      applySkill: vi.fn().mockRejectedValue(new Error('boom: unexpected apply failure')),
      fullyApplied: () => false,
    }));
    const { refreshInstalledSkills: refreshWithMockedApply } = await import('./update-skills.js');

    const root = temp('nanoclaw-skills-crash-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './demo.js';\n");
    write(
      root,
      '.claude/skills/add-demo/SKILL.md',
      ['# Apply', '```nc:copy from-branch:channels', 'src/channels/demo.ts', '```'].join('\n'),
    );

    const report = await refreshWithMockedApply(root);

    expect(report.success).toBe(false);
    expect(report.skills[0]).toMatchObject({ name: 'demo', status: 'failed', applied: [], skipped: [] });
    expect(report.skills[0].errors).toEqual(['boom: unexpected apply failure']);
  });
});

describe('scripts/update-skills.ts CLI entry (main)', () => {
  async function runEntry(
    args: string[],
  ): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
    vi.resetModules();
    const modPath = path.resolve(__dirname, 'update-skills.ts');
    process.argv = ['node', modPath, ...args];
    process.exitCode = undefined;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await import('./update-skills.js');
      // Flush the async main().catch(...) microtask/macrotask queue.
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    return { stdout, stderr, exitCode };
  }

  it('prints a refresh report as JSON for a clean tree with nothing installed', async () => {
    const root = temp('nanoclaw-skills-cli-clean-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'README.md', 'seed\n');
    commit(root, 'seed');

    const { stdout, stderr } = await runEntry(['--root', root]);

    expect(stderr).toEqual([]);
    const report = JSON.parse(stdout.join(''));
    expect(report).toMatchObject({ schema: 'nanoclaw-skill-refresh/v1', success: true, selected: [] });
  });

  it('refuses to run against a dirty working tree', async () => {
    const root = temp('nanoclaw-skills-cli-dirty-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'README.md', 'seed\n');
    commit(root, 'seed');
    write(root, 'README.md', 'dirty\n');

    const { stderr, exitCode } = await runEntry(['--root', root]);

    expect(stderr.join('')).toContain('Working tree must be clean before refreshing installed skills');
    expect(exitCode).toBe(1);
  });

  it('rejects an unknown CLI argument', async () => {
    const root = temp('nanoclaw-skills-cli-badarg-');

    const { stderr, exitCode } = await runEntry(['--root', root, '--bogus']);

    expect(stderr.join('')).toContain('Unknown argument: --bogus');
    expect(exitCode).toBe(1);
  });

  it('parses an explicit --skills all the same as the default', async () => {
    const root = temp('nanoclaw-skills-cli-all-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'README.md', 'seed\n');
    commit(root, 'seed');

    const { stdout } = await runEntry(['--root', root, '--skills', 'all']);

    const report = JSON.parse(stdout.join(''));
    expect(report.selected).toEqual([]);
  });

  it('resolves a trailing --root with no value to the cwd instead of throwing', async () => {
    const root = temp('nanoclaw-skills-cli-trailing-root-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'README.md', 'seed\n');
    commit(root, 'seed');
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const { stdout, exitCode } = await runEntry(['--root']);
      expect(exitCode).toBeUndefined();
      const report = JSON.parse(stdout.join(''));
      expect(report).toMatchObject({ success: true, selected: [] });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('resolves a trailing --skills with no value to "all" instead of throwing', async () => {
    const root = temp('nanoclaw-skills-cli-trailing-skills-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'README.md', 'seed\n');
    commit(root, 'seed');

    const { stdout } = await runEntry(['--root', root, '--skills']);

    const report = JSON.parse(stdout.join(''));
    expect(report.selected).toEqual([]);
  });

  it('stringifies a non-Error thrown from the git preflight check instead of crashing', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:child_process')>();
      return {
        ...actual,
        execFileSync: vi.fn(() => {
          // eslint-disable-next-line no-throw-literal
          throw 'raw git failure';
        }),
      };
    });
    const modPath = path.resolve(__dirname, 'update-skills.ts');
    process.argv = ['node', modPath, '--root', temp('nanoclaw-skills-cli-nonerror-')];
    process.exitCode = undefined;
    const stderr: string[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await import('./update-skills.js');
      await new Promise((r) => setTimeout(r, 30));
      expect(stderr.join('')).toBe('raw git failure\n');
      expect(process.exitCode).toBe(1);
    } finally {
      errSpy.mockRestore();
      process.exitCode = undefined;
      vi.doUnmock('node:child_process');
    }
  });

  it('parses a comma-separated --skills list and reports it back trimmed', async () => {
    const root = temp('nanoclaw-skills-cli-list-');
    run(root, 'git', ['init', '-b', 'main']);
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './slack.js';\n");
    write(root, '.claude/skills/add-slack/SKILL.md', '# Apply\nProse only.\n');
    commit(root, 'seed');

    const { stdout, exitCode } = await runEntry(['--root', root, '--skills', ' slack , ']);

    const report = JSON.parse(stdout.join(''));
    expect(report.selected).toEqual(['slack']);
    expect(report.success).toBe(false);
    expect(exitCode).toBe(1);
  });
});

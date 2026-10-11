import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

// Mock child_process so runCodexLoginAuth never spawns a real codex CLI; the
// spawn stand-in plays `codex login` writing auth.json into whatever
// CODEX_HOME it was handed.
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Keep the auth flow's structured logging out of logs/setup.log.
vi.mock('../logs.js', () => ({ step: vi.fn(), userInput: vi.fn() }));

// offerCodexFailureAssist confirms before handing off to the interactive TUI.
const mockConfirm = vi.fn();
vi.mock('@clack/prompts', async (importActual) => ({
  ...(await importActual<typeof import('@clack/prompts')>()),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

import {
  buildCodexFailurePrompt,
  offerCodexFailureAssist,
  runCodexInstallCheck,
  runCodexLoginAuth,
  verifyCodexInstall,
} from './codex.js';

// Structural guard for the codex payload wiring: provider files, both barrel
// imports, and the pinned Dockerfile install. Goes red if any of them is
// removed without going through the /add-codex (or its REMOVE.md) path.
describe('verifyCodexInstall', () => {
  it('passes on a tree with the codex payload wired', () => {
    const { ok, problems } = verifyCodexInstall();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it('blocks setup when the payload is incomplete', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-check-'));
    try {
      await expect(runCodexInstallCheck(root)).rejects.toThrow(/Codex provider is not fully installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// Pure prompt builder for the failure-assist hook — no spawning involved.
describe('buildCodexFailurePrompt', () => {
  it('carries the failure context and the de-duped reference list', () => {
    const projectRoot = '/repo';
    const prompt = buildCodexFailurePrompt(
      {
        stepName: 'verify',
        msg: 'first-chat ping timed out',
        hint: 'check the container logs',
        rawLogPath: '/repo/logs/setup-steps/verify.log',
      },
      projectRoot,
    );

    expect(prompt).toContain('Failed step: verify');
    expect(prompt).toContain('Error: first-chat ping timed out');
    expect(prompt).toContain('Hint: check the container logs');
    expect(prompt).toContain('README.md'); // BIG_PICTURE_FILES
    expect(prompt).toContain('setup/verify.ts'); // STEP_FILES['verify']
    expect(prompt).toContain('logs/setup.log');
    expect(prompt).toContain('logs/setup-steps/verify.log'); // relativized rawLogPath
  });

  it('falls back to the step-log directory when no raw log path is given', () => {
    const prompt = buildCodexFailurePrompt({ stepName: 'verify', msg: 'boom' }, '/repo');
    expect(prompt).toContain('logs/setup-steps/');
    expect(prompt).not.toContain('Hint:');
  });
});

// Session-isolation invariant: the ChatGPT session vaulted for the gateway
// must never be the user's personal ~/.codex session — sharing one OAuth
// session across two consumers gets the whole family invalidated server-side
// when refresh tokens rotate (see the header of codex.ts).
describe('runCodexLoginAuth', () => {
  it('logs in under an isolated CODEX_HOME, vaults from it, and deletes it', async () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    mockExecFileSync.mockReturnValue('');

    let loginEnv: NodeJS.ProcessEnv | undefined;
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const opts = args[2] as { env?: NodeJS.ProcessEnv };
      loginEnv = opts.env;
      fs.writeFileSync(path.join(opts.env!.CODEX_HOME!, 'auth.json'), '{"tokens":{}}');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0));
      return child;
    });

    await runCodexLoginAuth('browser');

    // The login spawn ran under a CODEX_HOME that is not the personal one.
    const codexHome = loginEnv?.CODEX_HOME;
    expect(codexHome).toBeDefined();
    expect(codexHome).not.toBe(path.join(os.homedir(), '.codex'));

    // The vault snapshot was read from the isolated dir, not ~/.codex.
    const vaultCall = mockExecFileSync.mock.calls.find((c) => c[0] === 'onecli');
    expect(vaultCall).toBeDefined();
    const vaultArgs = vaultCall![1] as string[];
    expect(vaultArgs[vaultArgs.indexOf('--file') + 1]).toBe(path.join(codexHome!, 'auth.json'));

    // The isolated dir holds a live credential — gone once vaulted.
    expect(fs.existsSync(codexHome!)).toBe(false);
  });
});

// Security: a bare `spawn('codex', [prompt], ...)` hands the operator's
// failing setup run over to an unrestricted interactive agent — full
// filesystem write and shell-exec with no per-action approval. This must
// stay sandboxed and ask-first, matching the already-established
// CLAUDE_READ_ONLY_ARGS precedent for Claude's own equivalent flow.
describe('offerCodexFailureAssist', () => {
  it('launches Codex read-only with approval on request', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-assist-home-'));
    try {
      fs.mkdirSync(path.join(home, '.codex'));
      fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
      vi.stubEnv('HOME', home);
      mockSpawn.mockReset();
      mockSpawnSync.mockReset();
      mockConfirm.mockReset();
      mockSpawnSync.mockReturnValue({ status: 0, stdout: 'codex-cli 0.155.1' });
      mockConfirm.mockResolvedValue(true);
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 0));
        return child;
      });

      expect(await offerCodexFailureAssist({ stepName: 'gateway', msg: 'boom' }, '/repo')).toBe('launched');

      const [binary, args] = mockSpawn.mock.calls[0] as [string, string[]];
      expect(binary).toBe('codex');
      expect(args.slice(0, 4)).toEqual(['--sandbox', 'read-only', '--ask-for-approval', 'on-request']);
      expect(args).toHaveLength(5);
    } finally {
      vi.unstubAllEnvs();
      mockSpawn.mockReset();
      mockSpawnSync.mockReset();
      mockConfirm.mockReset();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

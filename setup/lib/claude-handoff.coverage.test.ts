/**
 * Coverage for the interactive-handoff paths in claude-handoff.ts that the
 * sibling claude-handoff.test.ts doesn't reach: offerClaudeHandoff (the
 * user-initiated "?" escape hatch), spawnInteractiveClaude's session-id vs
 * --resume pinning, buildHandoffPrompt/buildFailurePrompt content, and
 * validateWithHelpEscape/isHelpEscape.
 *
 * child_process is mocked so `claude` never actually spawns. execSync
 * always "succeeds" here (claude installed + authenticated) so the real
 * (unmocked) claude-assist.ensureClaudeReady short-circuits true with zero
 * spawnSync calls — its own branches are covered in
 * claude-assist.coverage.test.ts.
 */
import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  execSyncOk: true,
  execSync: vi.fn((cmd: string) => {
    if (!h.execSyncOk) throw new Error(`fail: ${cmd}`);
    return '';
  }),
  spawn: vi.fn(),
  confirms: [] as boolean[],
  warnings: [] as string[],
  notes: [] as Array<{ message: string; title?: string }>,
}));

vi.mock('child_process', () => ({ execSync: h.execSync, spawn: h.spawn }));

vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async () => h.confirms.shift() ?? false),
    log: {
      ...actual.log,
      warn: vi.fn((m: string) => h.warnings.push(m)),
      error: vi.fn(),
      success: vi.fn(),
    },
    note: vi.fn((message: string, title?: string) => {
      h.notes.push({ message, title });
    }),
  };
});

import {
  offerClaudeHandoff,
  offerClaudeOnFailure,
  validateWithHelpEscape,
  isHelpEscape,
  HELP_ESCAPE_SENTINEL,
} from './claude-handoff.js';

class FakeChild extends EventEmitter {}

function nextChild(): FakeChild {
  const child = new FakeChild();
  h.spawn.mockReturnValueOnce(child);
  return child;
}

/**
 * offerFailureHandoff awaits ensureClaudeReady + p.confirm before reaching
 * spawnInteractiveClaude's synchronous spawn() call, so emitting on the fake
 * child right after invoking the function under test races those microtasks.
 * Wait for spawn() to have actually been called first.
 */
async function waitForSpawnCalls(n: number): Promise<void> {
  await vi.waitFor(() => {
    if (h.spawn.mock.calls.length < n) throw new Error(`waiting for spawn call #${n}`);
  });
}

beforeEach(() => {
  h.execSyncOk = true;
  h.execSync.mockClear();
  h.spawn.mockReset();
  h.confirms.length = 0;
  h.warnings.length = 0;
  h.notes.length = 0;
});

afterEach(() => {
  delete process.env.NANOCLAW_SKIP_CLAUDE_ASSIST;
});

describe('offerClaudeHandoff', () => {
  it('warns and returns false when claude is not on PATH', async () => {
    h.execSyncOk = false;
    const result = await offerClaudeHandoff({ channel: 'teams', step: 'portal', stepDescription: 'Create the app' });
    expect(result).toBe(false);
    expect(h.warnings).toHaveLength(1);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('notes the handoff, spawns interactive claude, and resolves true on a clean exit', async () => {
    const child = nextChild();
    const p = offerClaudeHandoff({
      channel: 'teams',
      step: 'portal',
      stepDescription: 'Create the app',
      completedSteps: ['Registered the app', 'Set the manifest'],
      collectedValues: { appId: 'abcd-1234' },
      files: ['setup/channels/teams-manifest-build.ts'],
    });
    child.emit('close');
    expect(await p).toBe(true);
    expect(h.notes[0]?.title).toBe('Handing off to Claude');
    const args = h.spawn.mock.calls[0];
    expect(args[0]).toBe('claude');
    const spawnArgs = args[1] as string[];
    expect(spawnArgs).toContain('--permission-mode');
    expect(spawnArgs).toContain('auto');
    const prompt = spawnArgs[0];
    expect(prompt).toContain('teams');
    expect(prompt).toContain('"portal" (Create the app)');
    expect(prompt).toContain('✓ Registered the app');
    expect(prompt).toContain('✓ Set the manifest');
    expect(prompt).toContain('appId: abcd-1234');
    expect(prompt).toContain('setup/channels/teams-manifest-build.ts');
    expect(prompt).toContain('.claude/skills/add-teams/SKILL.md');
    expect(args[2]).toEqual({ stdio: 'inherit' });
  });

  it('builds a minimal prompt when completedSteps/collectedValues/files are all omitted', async () => {
    const child = nextChild();
    const p = offerClaudeHandoff({ channel: 'slack', step: 'token', stepDescription: 'Paste bot token' });
    child.emit('close');
    await p;
    const prompt = (h.spawn.mock.calls[0][1] as string[])[0];
    expect(prompt).not.toContain("Steps I've already completed");
    expect(prompt).not.toContain('Values collected so far');
    expect(prompt).toContain('.claude/skills/add-slack/SKILL.md');
  });

  it('resolves false and logs an error when the child process errors', async () => {
    const child = nextChild();
    const p = offerClaudeHandoff({ channel: 'teams', step: 'portal', stepDescription: 'Create the app' });
    child.emit('error', new Error('ENOENT'));
    expect(await p).toBe(false);
  });
});

describe('validateWithHelpEscape / isHelpEscape', () => {
  it('lets a bare "?" through as undefined (accepted) regardless of the inner validator', () => {
    const wrapped = validateWithHelpEscape((v) => (v === 'ok' ? undefined : 'bad'));
    expect(wrapped('?')).toBeUndefined();
    expect(wrapped(' ? ')).toBeUndefined(); // trims before comparing
  });

  it('delegates to the inner validator for a normal value', () => {
    const wrapped = validateWithHelpEscape((v) => (v === 'ok' ? undefined : 'bad'));
    expect(wrapped('ok')).toBeUndefined();
    expect(wrapped('nope')).toBe('bad');
  });

  it('accepts anything when no inner validator is supplied', () => {
    const wrapped = validateWithHelpEscape();
    expect(wrapped('anything')).toBeUndefined();
  });

  it('treats a nullish value as empty (never throws, never mistaken for "?")', () => {
    const wrapped = validateWithHelpEscape((v) => (v ? undefined : 'required'));
    expect(wrapped(undefined as unknown as string)).toBe('required');
  });

  it('isHelpEscape matches a trimmed "?" and rejects everything else', () => {
    expect(isHelpEscape('?')).toBe(true);
    expect(isHelpEscape(' ? ')).toBe(true);
    expect(isHelpEscape('??')).toBe(false);
    expect(isHelpEscape(42)).toBe(false);
    expect(isHelpEscape(undefined)).toBe(false);
  });

  it('HELP_ESCAPE_SENTINEL is a stable string constant', () => {
    expect(typeof HELP_ESCAPE_SENTINEL).toBe('string');
  });
});

describe('offerFailureHandoff (via offerClaudeOnFailure, no provider picked, default assist mode)', () => {
  it('declining "Want to debug this with Claude?" returns false without spawning', async () => {
    h.confirms.push(false);
    const result = await offerClaudeOnFailure({ stepName: 'container', msg: 'boom' }, '/tmp/proj');
    expect(result).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('accepting spawns interactive claude with a failure prompt referencing STEP_FILES + hint + rawLogPath', async () => {
    h.confirms.push(true);
    const child = nextChild();
    const p = offerClaudeOnFailure(
      {
        stepName: 'container',
        msg: 'docker not found',
        hint: 'install docker first',
        rawLogPath: '/tmp/proj/logs/setup-steps/container.log',
      },
      '/tmp/proj',
    );
    await waitForSpawnCalls(1);
    child.emit('close');
    const result = await p;
    expect(result).toBe(true);
    expect(h.notes.some((n) => n.title === 'Handing off to Claude')).toBe(true);
    const prompt = (h.spawn.mock.calls[0][1] as string[])[0];
    expect(prompt).toContain('Failed step: container');
    expect(prompt).toContain('Error: docker not found');
    expect(prompt).toContain('Hint shown to me: install docker first');
    expect(prompt).toContain('setup/container.ts'); // from STEP_FILES['container']
    expect(prompt).toContain('logs/setup-steps/container.log'); // relative rawLogPath, not the generic dir
  });

  it('omits the hint line and falls back to the generic log dir when hint/rawLogPath are absent', async () => {
    h.confirms.push(true);
    const child = nextChild();
    const p = offerClaudeOnFailure({ stepName: 'totally-unknown-step', msg: 'boom' }, '/tmp/proj');
    await waitForSpawnCalls(1);
    child.emit('close');
    await p;
    const prompt = (h.spawn.mock.calls[0][1] as string[])[0];
    expect(prompt).not.toContain('Hint shown to me');
    expect(prompt).toContain('logs/setup-steps/'); // generic fallback, unknown step has no STEP_FILES entry
  });

  it('ensureClaudeReady failing (claude not installed, install declined) short-circuits before any confirm', async () => {
    h.execSyncOk = false; // isClaudeInstalled() throws
    // No confirm queued: ensureClaudeReady's own "Install it now?" defaults to false.
    const result = await offerClaudeOnFailure({ stepName: 'container', msg: 'boom' }, '/tmp/proj');
    expect(result).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('NANOCLAW_SKIP_CLAUDE_ASSIST=1 short-circuits before any confirm', async () => {
    process.env.NANOCLAW_SKIP_CLAUDE_ASSIST = '1';
    const result = await offerClaudeOnFailure({ stepName: 'container', msg: 'boom' }, '/tmp/proj');
    expect(result).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });
});

describe('spawnInteractiveClaude session pinning (isolated module instance)', () => {
  it('pins --session-id on the first spawn and --resume the same id on the second', async () => {
    vi.resetModules();
    const fresh = await import('./claude-handoff.js');
    const child1 = nextChild();
    const p1 = fresh.offerClaudeHandoff({ channel: 'teams', step: 'a', stepDescription: 'A' });
    child1.emit('close');
    await p1;

    const child2 = nextChild();
    const p2 = fresh.offerClaudeHandoff({ channel: 'teams', step: 'b', stepDescription: 'B' });
    child2.emit('close');
    await p2;

    const firstArgs = h.spawn.mock.calls[0][1] as string[];
    const secondArgs = h.spawn.mock.calls[1][1] as string[];
    const sessionIdIdx = firstArgs.indexOf('--session-id');
    expect(sessionIdIdx).toBeGreaterThan(-1);
    const sessionId = firstArgs[sessionIdIdx + 1];

    const resumeIdx = secondArgs.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(secondArgs[resumeIdx + 1]).toBe(sessionId);
  });
});

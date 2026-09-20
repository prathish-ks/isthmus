/**
 * Coverage for claude-assist.ts: the non-interactive `claude -p` failure
 * debugger (install/sign-in gating, stream-json parsing, REASON/COMMAND
 * extraction, and the run-suggested handoff). child_process is mocked
 * (execSync/spawn/spawnSync) so no real `claude`/`bash`/`script` process
 * ever runs; @clack/prompts is mocked so no real TTY prompt is needed.
 *
 * Only offerClaudeAssist, ensureClaudeReady and isClaudeReady are exported;
 * the stream-json parsing, tool-use formatting and prompt-building
 * internals are exercised indirectly through offerClaudeAssist.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  installed: false,
  authenticated: false,
  utilLinux: false,
  scriptVersionThrows: false,
  execSync: vi.fn((cmd: string) => {
    if (cmd.includes('command -v claude')) {
      if (!h.installed) throw new Error('not found');
      return '';
    }
    if (cmd.includes('claude auth status')) {
      if (!h.authenticated) throw new Error('not authed');
      return '';
    }
    if (cmd.includes('script --version')) {
      if (h.scriptVersionThrows) throw new Error('script: command not found');
      if (h.utilLinux) return 'script from util-linux 2.36';
      return 'script for macOS';
    }
    return '';
  }),
  spawnSync: vi.fn(() => ({ status: 0 }) as { status: number | null }),
  spawn: vi.fn(),
  confirms: [] as boolean[],
  warnings: [] as string[],
  errors: [] as string[],
  successes: [] as string[],
  notes: [] as Array<{ message: string; title?: string }>,
}));

vi.mock('child_process', () => ({ execSync: h.execSync, spawn: h.spawn, spawnSync: h.spawnSync }));

vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    confirm: vi.fn(async () => h.confirms.shift() ?? false),
    log: {
      ...actual.log,
      warn: vi.fn((m: string) => h.warnings.push(m)),
      error: vi.fn((m: string) => h.errors.push(m)),
      success: vi.fn((m: string) => h.successes.push(m)),
      message: vi.fn(),
    },
    note: vi.fn((message: string, title?: string) => {
      h.notes.push({ message, title });
    }),
  };
});

import { offerClaudeAssist, ensureClaudeReady, isClaudeReady } from './claude-assist.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
}

function nextSpawnChild(): FakeChild {
  const child = new FakeChild();
  h.spawn.mockReturnValueOnce(child);
  return child;
}

/**
 * offerClaudeAssist/ensureClaudeReady go through real `await`s (ensureClaudeReady,
 * p.confirm) before queryClaudeUnderSpinner's synchronous `spawn(...)` call, so
 * emitting on the fake child immediately after invoking the function under test
 * races those microtasks and silently drops the event. Wait for the Nth spawn()
 * call to have actually happened first.
 */
async function waitForSpawnCalls(n: number): Promise<void> {
  await vi.waitFor(() => {
    if (h.spawn.mock.calls.length < n) throw new Error(`waiting for spawn call #${n}`);
  });
}

let stdoutWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.installed = false;
  h.authenticated = false;
  h.utilLinux = false;
  h.scriptVersionThrows = false;
  h.execSync.mockClear();
  h.spawnSync.mockReset();
  h.spawnSync.mockReturnValue({ status: 0 });
  h.spawn.mockReset();
  h.confirms.length = 0;
  h.warnings.length = 0;
  h.errors.length = 0;
  h.successes.length = 0;
  h.notes.length = 0;
  // queryClaudeUnderSpinner writes raw ANSI redraw sequences directly to
  // stdout — silence them so the test log stays readable.
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stdoutWrite.mockRestore();
  delete process.env.NANOCLAW_SKIP_CLAUDE_ASSIST;
});

function streamJson(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

const REASON_COMMAND = streamJson({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'REASON: disk full\nCOMMAND: rm -rf /tmp/junk\n' }] },
});

describe('isClaudeReady', () => {
  it('is true only when both installed and authenticated', () => {
    h.installed = false;
    h.authenticated = false;
    expect(isClaudeReady()).toBe(false);
    h.installed = true;
    expect(isClaudeReady()).toBe(false);
    h.authenticated = true;
    expect(isClaudeReady()).toBe(true);
  });
});

describe('ensureClaudeReady', () => {
  it('returns true immediately when already installed and authenticated (no prompts, no spawnSync)', async () => {
    h.installed = true;
    h.authenticated = true;
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(true);
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('declining the install offer returns false', async () => {
    h.confirms.push(false);
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false);
    expect(h.spawnSync).not.toHaveBeenCalled();
  });

  it('install script failing (non-zero status) logs an error and returns false', async () => {
    h.confirms.push(true); // install
    h.spawnSync.mockReturnValue({ status: 1 });
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false);
    expect(h.errors).toContain("Couldn't install the Claude CLI.");
  });

  it('install script succeeding but claude still not on PATH logs an error and returns false', async () => {
    h.confirms.push(true);
    h.spawnSync.mockReturnValue({ status: 0 }); // install "succeeds" but h.installed stays false
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false);
    expect(h.errors).toContain("Couldn't install the Claude CLI.");
  });

  it('install succeeds, then declining sign-in returns false', async () => {
    h.confirms.push(true); // install
    h.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'bash') h.installed = true;
      return { status: 0 };
    });
    h.confirms.push(false); // decline sign-in
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false);
    expect(h.successes).toContain('Claude CLI installed.');
  });

  it('already installed, sign-in flow (util-linux script variant) succeeds when the script itself completes auth', async () => {
    h.installed = true;
    h.utilLinux = true;
    h.confirms.push(true); // sign-in
    const tmpfile = path.join(os.tmpdir(), `claude-setup-token-${process.pid}`);
    h.spawnSync.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === 'script') {
        // Auth succeeds through the script itself (real OAuth flow) — no
        // tmpfile token needed, so the extraction branch is never entered.
        h.authenticated = true;
        expect(args[1]).toBe('-c'); // util-linux variant: -q -c "claude setup-token" <tmpfile>
      }
      return { status: 0 };
    });
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(true);
    expect(h.successes).toContain('Claude CLI signed in.');
    expect(fs.existsSync(tmpfile)).toBe(false); // best-effort cleanup still ran (nothing to remove)
  });

  it('extracts and sets CLAUDE_CODE_OAUTH_TOKEN from the tmpfile when `claude auth status` still fails after the script step', async () => {
    h.installed = true;
    h.confirms.push(true);
    const TOKEN = `sk-ant-oat01-${'a'.repeat(90)}AA`;
    const tmpfile = path.join(os.tmpdir(), `claude-setup-token-${process.pid}`);
    h.spawnSync.mockImplementation((cmd: string) => {
      // h.authenticated deliberately stays false: `claude auth status` never
      // succeeds in this mock, exercising the tmpfile-token fallback path.
      if (cmd === 'script') fs.writeFileSync(tmpfile, `Your token:\n${TOKEN}\n`);
      return { status: 0 };
    });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false); // still fails cleanly — this mock never reports auth success
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN); // but the fallback token was extracted + set
    expect(fs.existsSync(tmpfile)).toBe(false); // cleaned up regardless
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('a `script --version` probe that throws (script not on PATH) is swallowed, falling back to the BSD arg form', async () => {
    h.installed = true;
    h.scriptVersionThrows = true;
    h.confirms.push(true);
    h.spawnSync.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === 'script') {
        h.authenticated = true;
        expect(args[0]).toBe('-q'); // BSD form used despite the probe failing, not util-linux
        expect(args[2]).toBe('claude');
      }
      return { status: 0 };
    });
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(true);
  });

  it('sign-in flow (BSD script variant) still succeeds when the tmpfile has no token but auth check passes', async () => {
    h.installed = true;
    h.utilLinux = false;
    h.confirms.push(true);
    h.spawnSync.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === 'script') {
        h.authenticated = true; // auth succeeded through some other path; no tmpfile written
        expect(args[0]).toBe('-q'); // BSD variant: -q <tmpfile> claude setup-token
        expect(args[2]).toBe('claude');
      }
      return { status: 0 };
    });
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(true);
  });

  it('sign-in flow that never authenticates (no tmpfile at all) logs an error and returns false', async () => {
    h.installed = true;
    h.confirms.push(true);
    // script runs but nothing sets h.authenticated and no tmpfile is written
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false);
    expect(h.errors).toContain("Couldn't complete Claude sign-in.");
  });

  it('tmpfile exists but has no extractable token: still not authenticated, still fails cleanly', async () => {
    h.installed = true;
    h.confirms.push(true);
    const tmpfile = path.join(os.tmpdir(), `claude-setup-token-${process.pid}`);
    h.spawnSync.mockImplementation((cmd: string) => {
      if (cmd === 'script') fs.writeFileSync(tmpfile, 'no token in here\n');
      return { status: 0 };
    });
    const ok = await ensureClaudeReady('/proj');
    expect(ok).toBe(false);
    expect(fs.existsSync(tmpfile)).toBe(false); // still cleaned up despite failure
  });
});

describe('offerClaudeAssist', () => {
  beforeEach(() => {
    h.installed = true;
    h.authenticated = true;
  });

  it('NANOCLAW_SKIP_CLAUDE_ASSIST=1 short-circuits before ensureClaudeReady', async () => {
    process.env.NANOCLAW_SKIP_CLAUDE_ASSIST = '1';
    const ok = await offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    expect(ok).toBe(false);
    expect(h.execSync).not.toHaveBeenCalled();
  });

  it('returns false when ensureClaudeReady fails (not installed, decline)', async () => {
    h.installed = false;
    h.confirms.push(false);
    const ok = await offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    expect(ok).toBe(false);
  });

  it('declining "Want me to ask Claude to diagnose this?" returns false without spawning', async () => {
    h.confirms.push(false);
    const ok = await offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    expect(ok).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('a child spawn error yields a null response and offerClaudeAssist returns false', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.emit('error', new Error('ENOENT'));
    expect(await p).toBe(false);
    expect(h.errors.some((m) => m.includes("Claude couldn't help here."))).toBe(true);
  });

  it('a non-zero close code with no text yields finish("error") and returns false', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.stderr.emit('data', Buffer.from('line1\nline2\nline3\nline4\n'));
    child.emit('close', 1);
    expect(await p).toBe(false);
  });

  it('a zero close code with only whitespace text still yields finish("error")', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.stdout.emit(
      'data',
      Buffer.from(streamJson({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } })),
    );
    child.emit('close', 0);
    expect(await p).toBe(false);
  });

  it('ignores a close event after an error already settled the promise', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.emit('error', new Error('boom'));
    child.emit('close', 0);
    expect(await p).toBe(false);
  });

  it('ignores an error event after a close event already settled the promise', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.emit('close', 0);
    child.emit('error', new Error('late'));
    expect(await p).toBe(false);
  });

  it('ignores malformed/blank stdout lines while parsing the stream', async () => {
    h.confirms.push(true);
    h.confirms.push(true); // run confirm, reached only if parse succeeds
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.stdout.emit('data', Buffer.from('\n   \nnot json at all\n'));
    child.stdout.emit('data', Buffer.from(REASON_COMMAND));
    child.emit('close', 0);
    await p;
    // Reaching the run-confirm proves the malformed lines were skipped, not fatal.
    expect(h.notes.some((n) => n.title === "Claude's suggestion")).toBe(true);
  });

  it('a well-formed response with no parseable REASON/COMMAND logs a warn with a truncated preview', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    const longText = 'no structured fields here, just prose. '.repeat(20);
    child.stdout.emit(
      'data',
      Buffer.from(streamJson({ type: 'assistant', message: { content: [{ type: 'text', text: longText }] } })),
    );
    child.emit('close', 0);
    expect(await p).toBe(false);
    expect(h.warnings.some((m) => m.includes("couldn't parse a command"))).toBe(true);
  });

  it('COMMAND: none parses to null (declining fix) and is treated the same as unparseable', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.stdout.emit(
      'data',
      Buffer.from(
        streamJson({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'REASON: unclear\nCOMMAND: NONE\n' }] },
        }),
      ),
    );
    child.emit('close', 0);
    expect(await p).toBe(false);
  });

  it('declining to run the parsed command returns false without invoking run-suggested', async () => {
    h.confirms.push(true); // want to ask claude
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.stdout.emit('data', Buffer.from(REASON_COMMAND));
    child.emit('close', 0);
    h.confirms.push(false); // decline "Run this command?" — pushed after close so it's next in queue
    const ok = await p;
    expect(ok).toBe(false);
  });

  it('accepting runs the suggested command via setup/run-suggested.sh and returns true', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-assist-'));
    fs.mkdirSync(path.join(root, 'setup'));
    fs.writeFileSync(path.join(root, 'setup/run-suggested.sh'), '#!/bin/sh\n');
    try {
      h.confirms.push(true, true); // want to ask claude, then run the command
      const queryChild = nextSpawnChild();
      const runChild = nextSpawnChild();
      const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, root);
      await waitForSpawnCalls(1);
      queryChild.stdout.emit('data', Buffer.from(REASON_COMMAND));
      queryChild.emit('close', 0);
      await waitForSpawnCalls(2); // wait for the second spawn (run-suggested)
      runChild.emit('close', 0);
      expect(await p).toBe(true);
      expect(h.spawn).toHaveBeenCalledTimes(2);
      expect(h.spawn.mock.calls[1][0]).toBe('bash');
      expect((h.spawn.mock.calls[1][1] as string[])[1]).toBe('rm -rf /tmp/junk');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepting when setup/run-suggested.sh is missing logs an error but still returns true', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-assist-noscript-'));
    try {
      h.confirms.push(true, true);
      const queryChild = nextSpawnChild();
      const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, root);
      await waitForSpawnCalls(1);
      queryChild.stdout.emit('data', Buffer.from(REASON_COMMAND));
      queryChild.emit('close', 0);
      expect(await p).toBe(true);
      expect(h.errors.some((m) => m.includes('Missing helper'))).toBe(true);
      expect(h.spawn).toHaveBeenCalledTimes(1); // only the query spawn — run-suggested never spawned
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runSuggested resolves on a child error too (best-effort)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-assist-runerr-'));
    fs.mkdirSync(path.join(root, 'setup'));
    fs.writeFileSync(path.join(root, 'setup/run-suggested.sh'), '#!/bin/sh\n');
    try {
      h.confirms.push(true, true);
      const queryChild = nextSpawnChild();
      const runChild = nextSpawnChild();
      const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, root);
      await waitForSpawnCalls(1);
      queryChild.stdout.emit('data', Buffer.from(REASON_COMMAND));
      queryChild.emit('close', 0);
      await waitForSpawnCalls(2);
      runChild.emit('error', new Error('ENOENT'));
      expect(await p).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('formats tool_use breadcrumbs for Read/Bash/Grep/Glob/unknown tools', async () => {
    h.confirms.push(true, true); // want to ask, then run
    const child = nextSpawnChild();
    const p = offerClaudeAssist(
      {
        stepName: 'unknown-step-not-in-STEP_FILES',
        msg: 'boom',
        hint: 'try again',
        rawLogPath: '/proj/logs/setup-steps/x.log',
      },
      '/proj',
    );
    await waitForSpawnCalls(1);
    child.stdout.emit(
      'data',
      Buffer.from(
        streamJson({ type: 'system', subtype: 'init', session_id: 'sess-123' }) +
          streamJson({
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', name: 'Read', input: { file_path: `${process.cwd()}/setup/index.ts` } }, // within cwd -> shortenPath's "strip root" branch
                { type: 'tool_use', name: 'Read', input: {} }, // no file_path -> `?? ''` fallback
                { type: 'tool_use', name: 'Bash', input: { command: 'echo '.padEnd(80, 'x') } },
                { type: 'tool_use', name: 'Bash', input: {} }, // no command -> `?? ''` fallback
                { type: 'tool_use', name: 'Grep', input: { pattern: 'needle' } },
                { type: 'tool_use', name: 'Grep', input: {} }, // no pattern -> `?? ''` fallback
                { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
                { type: 'tool_use', name: 'WebFetch', input: {} },
                { type: 'something_else' }, // neither text nor tool_use -> falls through untouched
              ],
            },
          }) +
          REASON_COMMAND,
      ),
    );
    child.emit('close', 0);
    await p;
    expect(h.successes.some((m) => m.includes('Claude replied.'))).toBe(true);
  });

  it('redraws on the periodic frame tick and restores the cursor if the process exits mid-query', async () => {
    vi.useFakeTimers();
    try {
      h.confirms.push(true);
      const child = nextSpawnChild();
      const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
      // Flush the ensureClaudeReady + confirm microtasks under fake timers.
      await vi.advanceTimersByTimeAsync(0);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      // One periodic redraw tick (setInterval(…, 250)).
      await vi.advanceTimersByTimeAsync(250);
      // Simulate a Ctrl-C mid-query: the 'exit' hook must still run and show the cursor
      // (finish() never gets a chance to remove the listener first).
      process.emit('exit' as never, 0 as never);
      child.stdout.emit('data', Buffer.from(REASON_COMMAND));
      child.emit('close', 0);
      await vi.advanceTimersByTimeAsync(0);
      await p;
      expect(stdoutWrite.mock.calls.some((c) => c[0] === '\x1b[?25h')).toBe(true); // SHOW_CURSOR written
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores assistant events with no content array', async () => {
    h.confirms.push(true);
    const child = nextSpawnChild();
    const p = offerClaudeAssist({ stepName: 'container', msg: 'boom' }, '/proj');
    await waitForSpawnCalls(1);
    child.stdout.emit('data', Buffer.from(streamJson({ type: 'assistant' })));
    child.stdout.emit('data', Buffer.from(streamJson({ type: 'other-event-type' })));
    child.emit('close', 0);
    expect(await p).toBe(false); // no text ever accumulated
  });
});

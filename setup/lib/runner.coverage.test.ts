/**
 * Coverage for runner.ts: StatusStream parsing, spawnStep/spawnQuiet (raw
 * log tee + status-block parsing), runQuietStep/runQuietChild (spinner +
 * progression-log wiring), writeStepEntry/summariseTerminalFields,
 * startSpinner, dumpTranscriptOnFailure, fail(), and ensureAnswer().
 *
 * child_process is mocked (spawn/spawnSync) so no real setup step or pnpm
 * process ever runs; raw logs are written to real temp files (fs itself
 * isn't mocked — these are plain local file writes, not network/Docker).
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  confirmAnswers: [] as boolean[],
  isCancelValue: undefined as unknown,
  logError: vi.fn(),
  logMessage: vi.fn(),
  cancel: vi.fn(),
  spinnerStart: vi.fn(),
  spinnerMessage: vi.fn(),
  spinnerStop: vi.fn(),
  offerClaudeOnFailure: vi.fn(async () => false),
  setupAbort: vi.fn(),
  setupStep: vi.fn(),
  completedStepNames: vi.fn(() => [] as string[]),
  stepRawLog: vi.fn(() => '/tmp/runner-coverage-fake.log'),
  phEmit: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: h.spawn, spawnSync: h.spawnSync }));
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: h.offerClaudeOnFailure }));
vi.mock('./diagnostics.js', () => ({ emit: h.phEmit }));
vi.mock('../logs.js', () => ({
  abort: h.setupAbort,
  step: h.setupStep,
  completedStepNames: h.completedStepNames,
  stepRawLog: h.stepRawLog,
}));
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    isCancel: (v: unknown) => v === h.isCancelValue && h.isCancelValue !== undefined,
    confirm: vi.fn(async () => h.confirmAnswers.shift() ?? false),
    log: { ...actual.log, error: h.logError, message: h.logMessage },
    cancel: h.cancel,
    spinner: () => ({ start: h.spinnerStart, message: h.spinnerMessage, stop: h.spinnerStop }),
  };
});

import {
  StatusStream,
  spawnStep,
  spawnQuiet,
  runQuietStep,
  runQuietChild,
  writeStepEntry,
  summariseTerminalFields,
  startSpinner,
  dumpTranscriptOnFailure,
  fail,
  ensureAnswer,
  type StepResult,
  type Block,
} from './runner.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function nextChild(): FakeChild {
  const child = new FakeChild();
  h.spawn.mockReturnValueOnce(child);
  return child;
}

let tmpFiles: string[] = [];
function tmpLogPath(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cov-')), 'raw.log');
  tmpFiles.push(p);
  return p;
}

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.spawn.mockReset();
  h.spawnSync.mockReset();
  h.confirmAnswers.length = 0;
  h.isCancelValue = undefined;
  h.logError.mockClear();
  h.logMessage.mockClear();
  h.cancel.mockClear();
  h.spinnerStart.mockClear();
  h.spinnerMessage.mockClear();
  h.spinnerStop.mockClear();
  h.offerClaudeOnFailure.mockReset();
  h.offerClaudeOnFailure.mockResolvedValue(false);
  h.setupAbort.mockClear();
  h.setupStep.mockClear();
  h.completedStepNames.mockReset();
  h.completedStepNames.mockReturnValue([]);
  h.phEmit.mockClear();
  tmpFiles = [];
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`__exit_${code ?? 0}__`);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
});

// Cleanup deliberately deferred to afterAll rather than afterEach: the raw
// log is written through fs.createWriteStream, whose actual disk flush is
// async and not awaited by spawnStep/spawnQuiet's resolve() — removing a raw
// log's tmp dir right after its own test can race a still-in-flight write
// and throw an unhandled 'error' on the stream (no listener attached in the
// source), which crashes the whole worker. Deleting once at the very end
// gives every stream from every test time to settle first.
afterAll(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe('StatusStream', () => {
  it('parses a full block delivered in one chunk', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    s.write('=== NANOCLAW SETUP: CONTAINER ===\nSTATUS: success\nRUNTIME: docker\n=== END ===\n');
    expect(blocks).toEqual([{ type: 'CONTAINER', fields: { STATUS: 'success', RUNTIME: 'docker' } }]);
    expect(s.blocks).toEqual(blocks);
  });

  it('parses a block split across multiple write() calls', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    s.write('=== NANOCLAW SETUP: CONT');
    s.write('AINER ===\nSTATUS: suc');
    s.write('cess\n=== END ===\n');
    expect(blocks).toEqual([{ type: 'CONTAINER', fields: { STATUS: 'success' } }]);
  });

  it('accumulates the full transcript regardless of block state', () => {
    const s = new StatusStream(() => {});
    s.write('noise before\n=== NANOCLAW SETUP: X ===\nA: 1\n=== END ===\nnoise after\n');
    expect(s.transcript).toBe('noise before\n=== NANOCLAW SETUP: X ===\nA: 1\n=== END ===\nnoise after\n');
  });

  it('ignores field lines outside any open block, and lines with no colon', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    s.write('ORPHAN: field\nno-colon-line\n=== NANOCLAW SETUP: X ===\nno-colon-either\nA: 1\n=== END ===\n');
    expect(blocks).toEqual([{ type: 'X', fields: { A: '1' } }]);
  });

  it('trims the field key and value', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    s.write('=== NANOCLAW SETUP: X ===\n  KEY  :   value with spaces  \n=== END ===\n');
    expect(blocks[0].fields).toEqual({ KEY: 'value with spaces' });
  });

  it('a field line with an empty key is dropped', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    s.write('=== NANOCLAW SETUP: X ===\n: novalue\nA: 1\n=== END ===\n');
    expect(blocks[0].fields).toEqual({ A: '1' });
  });

  it('=== END === with no open block is a harmless no-op', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    expect(() => s.write('=== END ===\n')).not.toThrow();
    expect(blocks).toEqual([]);
  });

  it('starting a new block discards an unterminated previous one', () => {
    const blocks: Block[] = [];
    const s = new StatusStream((b) => blocks.push(b));
    s.write('=== NANOCLAW SETUP: FIRST ===\nA: 1\n=== NANOCLAW SETUP: SECOND ===\nB: 2\n=== END ===\n');
    expect(blocks).toEqual([{ type: 'SECOND', fields: { B: '2' } }]);
  });
});

describe('spawnStep', () => {
  it('parses stdout blocks, tees to the raw log, and reports ok on a clean success', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: CONTAINER ===\nSTATUS: success\n=== END ===\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.terminal).toEqual({ type: 'CONTAINER', fields: { STATUS: 'success' } });
    expect(h.spawn).toHaveBeenCalledWith('pnpm', ['exec', 'tsx', 'setup/index.ts', '--step', 'container'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // fs.createWriteStream's actual disk write is async and not awaited by
    // spawnStep's resolve() — poll instead of reading synchronously right
    // after, to avoid a flush race (and the ENOENT it can otherwise throw).
    await vi.waitFor(() => {
      const logged = fs.existsSync(rawLog) ? fs.readFileSync(rawLog, 'utf8') : '';
      if (!logged.includes('=== NANOCLAW SETUP: CONTAINER ===')) throw new Error('raw log not flushed yet');
    });
    const logged = fs.readFileSync(rawLog, 'utf8');
    expect(logged).toContain('# container —');
  });

  it('forwards extra args after the step name via `--`', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('channel', ['--only', 'telegram'], () => {}, rawLog);
    child.emit('close', 0);
    await p;
    expect(h.spawn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'tsx', 'setup/index.ts', '--step', 'channel', '--', '--only', 'telegram'],
      expect.any(Object),
    );
  });

  it('a "skipped" STATUS with exit 0 still counts as ok', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: CONTAINER ===\nSTATUS: skipped\n=== END ===\n'));
    child.emit('close', 0);
    expect((await p).ok).toBe(true);
  });

  it('a non-success/skipped STATUS is not ok even with exit 0', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: CONTAINER ===\nSTATUS: failed\n=== END ===\n'));
    child.emit('close', 0);
    expect((await p).ok).toBe(false);
  });

  it('a non-zero exit code is never ok, regardless of STATUS', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: CONTAINER ===\nSTATUS: success\n=== END ===\n'));
    child.emit('close', 1);
    expect((await p).ok).toBe(false);
  });

  it('a null exit code (signal kill) reports exitCode 1 and terminal null when no block closed', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    child.emit('close', null);
    const result = await p;
    expect(result.exitCode).toBe(1);
    expect(result.terminal).toBeNull();
    expect(result.ok).toBe(false);
  });

  it('the terminal block is the LAST one with a STATUS field, not necessarily the last block', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    child.stdout.emit(
      'data',
      Buffer.from(
        '=== NANOCLAW SETUP: A ===\nSTATUS: success\n=== END ===\n=== NANOCLAW SETUP: B ===\nNOSTATUS: x\n=== END ===\n',
      ),
    );
    child.emit('close', 0);
    const result = await p;
    expect(result.terminal?.type).toBe('A');
  });

  it('onLine fires per line, excluding status-control lines and blanks, from both stdout and stderr', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const lines: string[] = [];
    const p = spawnStep(
      'container',
      [],
      () => {},
      rawLog,
      (l) => lines.push(l),
    );
    child.stdout.emit(
      'data',
      Buffer.from('=== NANOCLAW SETUP: X ===\nfield line stays raw\n=== END ===\nhello stdout\n\n'),
    );
    child.stderr.emit('data', Buffer.from('hello stderr\r\n'));
    child.emit('close', 0);
    await p;
    expect(lines).toContain('hello stdout');
    expect(lines).toContain('hello stderr');
    expect(lines.some((l) => l.startsWith('=== NANOCLAW SETUP:'))).toBe(false);
    expect(lines.some((l) => l.startsWith('=== END ==='))).toBe(false);
    expect(lines.some((l) => l === '')).toBe(false);
  });

  it('with no onLine callback, stdout/stderr data never touches the line feed (no throw)', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnStep('container', [], () => {}, rawLog);
    expect(() => {
      child.stdout.emit('data', Buffer.from('some output\n'));
      child.stderr.emit('data', Buffer.from('some error output\n'));
    }).not.toThrow();
    child.emit('close', 0);
    await p;
  });

  it('onBlock fires as each block closes (mid-stream), not just at the end', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const seen: string[] = [];
    const p = spawnStep('container', [], (b) => seen.push(b.type), rawLog);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: FIRST ===\nSTATUS: success\n=== END ===\n'));
    expect(seen).toEqual(['FIRST']);
    child.emit('close', 0);
    await p;
  });
});

describe('spawnQuiet', () => {
  it('reports ok purely from the exit code (no STATUS gating)', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnQuiet('docker', ['build', '.'], rawLog);
    child.stdout.emit('data', Buffer.from('building...\n'));
    child.stderr.emit('data', Buffer.from('a warning\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.transcript).toContain('building...');
    expect(result.transcript).toContain('a warning');
    expect(h.spawn).toHaveBeenCalledWith('docker', ['build', '.'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  });

  it('merges an env override onto process.env rather than replacing it', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnQuiet('docker', [], rawLog, { FOO: 'bar' });
    child.emit('close', 0);
    await p;
    const call = h.spawn.mock.calls[0];
    expect(call[2].env).toEqual({ ...process.env, FOO: 'bar' });
  });

  it('is not ok on a non-zero exit, and a null code reports exitCode 1', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnQuiet('docker', [], rawLog);
    child.emit('close', null);
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('parses status blocks from stdout into `blocks` + `terminal`', async () => {
    const child = nextChild();
    const rawLog = tmpLogPath();
    const p = spawnQuiet('cmd', [], rawLog);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: X ===\nSTATUS: success\n=== END ===\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result.blocks).toHaveLength(1);
    expect(result.terminal?.fields.STATUS).toBe('success');
  });
});

describe('summariseTerminalFields', () => {
  it('returns {} for a null block', () => {
    expect(summariseTerminalFields(null)).toEqual({});
  });

  it('strips STATUS and LOG, keeps other fields', () => {
    const block: Block = { type: 'X', fields: { STATUS: 'success', LOG: '/path', RUNTIME: 'docker' } };
    expect(summariseTerminalFields(block)).toEqual({ RUNTIME: 'docker' });
  });

  it('drops oversize values (>120 chars) but keeps the rest', () => {
    const long = 'x'.repeat(121);
    const block: Block = { type: 'X', fields: { HUGE: long, SMALL: 'ok' } };
    expect(summariseTerminalFields(block)).toEqual({ SMALL: 'ok' });
  });

  it('keeps a value at exactly the 120-char boundary', () => {
    const exact = 'y'.repeat(120);
    const block: Block = { type: 'X', fields: { EXACT: exact } };
    expect(summariseTerminalFields(block)).toEqual({ EXACT: exact });
  });
});

describe('writeStepEntry', () => {
  const rawLog = '/tmp/fake-raw.log';

  it('classifies failed/skipped/success and forwards the summarised fields', () => {
    writeStepEntry('container', { ok: false, exitCode: 1, blocks: [], transcript: '', terminal: null }, 1234, rawLog);
    expect(h.setupStep).toHaveBeenCalledWith('container', 'failed', 1234, {}, rawLog);

    h.setupStep.mockClear();
    const skippedTerminal: Block = { type: 'X', fields: { STATUS: 'skipped', REASON: 'already done' } };
    writeStepEntry(
      'onecli',
      { ok: true, exitCode: 0, blocks: [], transcript: '', terminal: skippedTerminal },
      50,
      rawLog,
    );
    expect(h.setupStep).toHaveBeenCalledWith('onecli', 'skipped', 50, { REASON: 'already done' }, rawLog);

    h.setupStep.mockClear();
    const okTerminal: Block = { type: 'X', fields: { STATUS: 'success', RUNTIME: 'docker' } };
    writeStepEntry(
      'container',
      { ok: true, exitCode: 0, blocks: [], transcript: '', terminal: okTerminal },
      99,
      rawLog,
    );
    expect(h.setupStep).toHaveBeenCalledWith('container', 'success', 99, { RUNTIME: 'docker' }, rawLog);
  });
});

describe('startSpinner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('starts with the running label and ticks the elapsed suffix every second', () => {
    const spinner = startSpinner({ running: 'Building…', done: 'Built' });
    expect(h.spinnerStart).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(h.spinnerMessage).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(h.spinnerMessage).toHaveBeenCalledTimes(2);
    spinner.stop({ ok: true });
    vi.advanceTimersByTime(2000);
    expect(h.spinnerMessage).toHaveBeenCalledTimes(2); // interval cleared by stop()
  });

  it('stop({ok:true}) uses the done label; skipped uses the skipped label when provided', () => {
    startSpinner({ running: 'Building…', done: 'Built', skipped: 'Already built' }).stop({ ok: true, skipped: true });
    expect(h.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('Already built'));
  });

  it('stop({ok:true, skipped:true}) falls back to done when no skipped label is set', () => {
    startSpinner({ running: 'Building…', done: 'Built' }).stop({ ok: true, skipped: true });
    expect(h.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('Built'));
  });

  it('stop({ok:false}) uses the failed label and dumps the transcript tail when given', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    startSpinner({ running: 'Building…', done: 'Built', failed: 'Build blew up' }).stop({
      ok: false,
      transcript: 'line one\nline two\n',
    });
    expect(h.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('Build blew up'), 1);
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('stop({ok:false}) with no explicit failed label derives "<running minus ellipsis> failed"', () => {
    startSpinner({ running: 'Building…', done: 'Built' }).stop({ ok: false });
    expect(h.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('Building failed'), 1);
  });
});

describe('dumpTranscriptOnFailure', () => {
  it('strips status-control lines, keeps the last 40, and prints via console.log', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i}`);
    const transcript = ['=== NANOCLAW SETUP: X ===', ...lines, '=== END ==='].join('\n');
    dumpTranscriptOnFailure(transcript);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).not.toContain('=== NANOCLAW SETUP:');
    expect(printed).not.toContain('=== END ===');
    expect(printed).toContain('line 44');
    expect(printed).not.toContain('line 0\n'); // trimmed to the last 40
    logSpy.mockRestore();
  });

  it('prints nothing when the filtered tail is empty', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    dumpTranscriptOnFailure('=== NANOCLAW SETUP: X ===\n=== END ===\n');
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('ensureAnswer', () => {
  it('returns the value unchanged when not cancelled', () => {
    expect(ensureAnswer('hello')).toBe('hello');
    expect(ensureAnswer(42)).toBe(42);
  });

  it("cancels and exits 0 when the value is clack's cancel symbol", () => {
    const CANCEL = Symbol('cancel');
    h.isCancelValue = CANCEL;
    expect(() => ensureAnswer(CANCEL)).toThrow('__exit_0__');
    expect(h.cancel).toHaveBeenCalledWith('Setup cancelled.');
  });
});

describe('fail', () => {
  it('logs the message + hint + log locations, offers Claude, then cancels and exits 1 on decline', async () => {
    h.offerClaudeOnFailure.mockResolvedValue(false);
    await expect(fail('container', 'boom', 'try again')).rejects.toThrow('__exit_1__');
    expect(h.setupAbort).toHaveBeenCalledWith('container', 'boom');
    expect(h.phEmit).toHaveBeenCalledWith('setup_aborted', { step: 'container', reason: 'boom' });
    expect(h.logError).toHaveBeenCalledWith('boom');
    expect(h.logMessage).toHaveBeenCalledWith(expect.stringContaining('try again'));
    expect(h.cancel).toHaveBeenCalledWith('Setup aborted.');
  });

  it('omits the hint line when none is given', async () => {
    h.offerClaudeOnFailure.mockResolvedValue(false);
    await expect(fail('container', 'boom')).rejects.toThrow('__exit_1__');
    // Only the "Logs: ..." message line, never a hint line.
    expect(h.logMessage).toHaveBeenCalledTimes(1);
  });

  it('Claude fixed it but the operator declines the retry: still cancels and exits 1', async () => {
    h.offerClaudeOnFailure.mockResolvedValue(true);
    h.confirmAnswers.push(false);
    await expect(fail('container', 'boom')).rejects.toThrow('__exit_1__');
    expect(h.spawnSync).not.toHaveBeenCalled();
    expect(h.cancel).toHaveBeenCalledWith('Setup aborted.');
  });

  it('Claude fixed it and the operator accepts the retry: re-execs setup:auto with a merged NANOCLAW_SKIP', async () => {
    h.offerClaudeOnFailure.mockResolvedValue(true);
    h.confirmAnswers.push(true);
    h.completedStepNames.mockReturnValue(['bootstrap', 'environment']);
    h.spawnSync.mockReturnValue({ status: 3 });
    const prevSkip = process.env.NANOCLAW_SKIP;
    process.env.NANOCLAW_SKIP = 'preexisting';
    try {
      await expect(fail('container', 'boom')).rejects.toThrow('__exit_3__');
      expect(h.spawnSync).toHaveBeenCalledWith(
        'pnpm',
        ['--silent', 'run', 'setup:auto'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({ NANOCLAW_SKIP: 'preexisting,bootstrap,environment' }),
        }),
      );
      expect(h.cancel).not.toHaveBeenCalled(); // exits from inside the retry branch, never reaches cancel
    } finally {
      if (prevSkip === undefined) delete process.env.NANOCLAW_SKIP;
      else process.env.NANOCLAW_SKIP = prevSkip;
    }
  });

  it('retry re-exec exits 0 when spawnSync reports a null status', async () => {
    h.offerClaudeOnFailure.mockResolvedValue(true);
    h.confirmAnswers.push(true);
    h.spawnSync.mockReturnValue({ status: null });
    delete process.env.NANOCLAW_SKIP;
    await expect(fail('container', 'boom')).rejects.toThrow('__exit_0__');
  });

  it('de-duplicates NANOCLAW_SKIP entries between the existing list and completed steps', async () => {
    h.offerClaudeOnFailure.mockResolvedValue(true);
    h.confirmAnswers.push(true);
    h.completedStepNames.mockReturnValue(['bootstrap']);
    h.spawnSync.mockReturnValue({ status: 0 });
    process.env.NANOCLAW_SKIP = 'bootstrap, environment';
    try {
      await expect(fail('container', 'boom')).rejects.toThrow('__exit_0__');
      const env = h.spawnSync.mock.calls[0][2].env as Record<string, string>;
      expect(env.NANOCLAW_SKIP).toBe('bootstrap,environment');
    } finally {
      delete process.env.NANOCLAW_SKIP;
    }
  });
});

describe('runQuietStep', () => {
  it('wraps spawnStep in a spinner, writes the progression entry, and emits diagnostics both sides', async () => {
    const child = nextChild();
    const p = runQuietStep('container', { running: 'Building…', done: 'Built' });
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: CONTAINER ===\nSTATUS: success\n=== END ===\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.rawLog).toBe('/tmp/runner-coverage-fake.log');
    expect(typeof result.durationMs).toBe('number');
    expect(h.phEmit).toHaveBeenCalledWith('step_started', { step: 'container' });
    expect(h.phEmit).toHaveBeenCalledWith(
      'step_completed',
      expect.objectContaining({ step: 'container', status: 'success' }),
    );
    expect(h.setupStep).toHaveBeenCalledOnce();
    expect(h.spinnerStart).toHaveBeenCalledOnce();
    expect(h.spinnerStop).toHaveBeenCalledOnce();
  });

  it('forwards `extra` args and reports a "skipped" outcome to diagnostics', async () => {
    const child = nextChild();
    const p = runQuietStep('channel', { running: 'Wiring…', done: 'Wired' }, ['--only', 'telegram']);
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: CHANNEL ===\nSTATUS: skipped\n=== END ===\n'));
    child.emit('close', 0);
    await p;
    expect(h.spawn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'tsx', 'setup/index.ts', '--step', 'channel', '--', '--only', 'telegram'],
      expect.any(Object),
    );
    expect(h.phEmit).toHaveBeenCalledWith('step_completed', expect.objectContaining({ status: 'skipped' }));
  });

  it('reports "failed" to diagnostics when the step doesn\'t come back ok', async () => {
    const child = nextChild();
    const p = runQuietStep('container', { running: 'Building…', done: 'Built' });
    child.emit('close', 1);
    await p;
    expect(h.phEmit).toHaveBeenCalledWith('step_completed', expect.objectContaining({ status: 'failed' }));
  });
});

describe('runQuietChild', () => {
  it('wraps spawnQuiet, merges extraFields into the progression entry, and classifies success/skipped/failed', async () => {
    const child = nextChild();
    const p = runQuietChild(
      'docker-build',
      'docker',
      ['build', '.'],
      { running: 'Building…', done: 'Built' },
      {
        extraFields: { RUNTIME: 'docker' },
      },
    );
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: X ===\nSTATUS: success\nARCH: arm64\n=== END ===\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result.ok).toBe(true);
    expect(h.setupStep).toHaveBeenCalledWith(
      'docker-build',
      'success',
      expect.any(Number),
      { ARCH: 'arm64', RUNTIME: 'docker' },
      '/tmp/runner-coverage-fake.log',
    );
  });

  it('classifies "skipped" when ok and the terminal block says STATUS: skipped', async () => {
    const child = nextChild();
    const p = runQuietChild('docker-build', 'docker', [], { running: 'Building…', done: 'Built' });
    child.stdout.emit('data', Buffer.from('=== NANOCLAW SETUP: X ===\nSTATUS: skipped\n=== END ===\n'));
    child.emit('close', 0);
    await p;
    expect(h.setupStep).toHaveBeenCalledWith('docker-build', 'skipped', expect.any(Number), {}, expect.any(String));
  });

  it('classifies "failed" when the child result is not ok, regardless of any STATUS block', async () => {
    const child = nextChild();
    const p = runQuietChild('docker-build', 'docker', [], { running: 'Building…', done: 'Built' });
    child.emit('close', 1);
    await p;
    expect(h.setupStep).toHaveBeenCalledWith('docker-build', 'failed', expect.any(Number), {}, expect.any(String));
  });

  it('passes an env override through to spawnQuiet', async () => {
    const child = nextChild();
    const p = runQuietChild('x', 'docker', [], { running: 'r…', done: 'd' }, { env: { FOO: 'bar' } });
    child.emit('close', 0);
    await p;
    expect(h.spawn.mock.calls[0][2].env).toEqual(expect.objectContaining({ FOO: 'bar' }));
  });
});

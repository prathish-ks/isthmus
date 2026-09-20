/**
 * Coverage for windowed-runner.ts: the rolling-tail render loop and the
 * stall detector. `runner.js`'s `spawnStep` is mocked (spread actual +
 * override) so the step's line feed and terminal result are fully test-
 * controlled — no real child_process spawn, no real 60s wait (fake timers
 * drive the stall threshold instead).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { StepResult, SpinnerLabels } from './runner.js';

const h = vi.hoisted(() => ({
  spawnStep: vi.fn(),
  brightSelect: vi.fn(async () => 'wait' as 'wait' | 'help'),
  offerClaudeOnFailure: vi.fn(async () => false),
  phEmit: vi.fn(),
  logSuccess: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  setupLogStep: vi.fn(),
  stepRawLog: vi.fn(() => '/tmp/windowed-runner-coverage-fake.log'),
}));

vi.mock('./runner.js', async (importActual) => {
  const actual = await importActual<typeof import('./runner.js')>();
  return { ...actual, spawnStep: h.spawnStep, ensureAnswer: (v: unknown) => v };
});
vi.mock('./bright-select.js', () => ({ brightSelect: h.brightSelect }));
vi.mock('./claude-handoff.js', () => ({ offerClaudeOnFailure: h.offerClaudeOnFailure }));
vi.mock('./diagnostics.js', () => ({ emit: h.phEmit }));
vi.mock('../logs.js', () => ({
  stepRawLog: h.stepRawLog,
  step: h.setupLogStep,
  abort: vi.fn(),
  completedStepNames: vi.fn(() => []),
}));
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return { ...actual, log: { ...actual.log, success: h.logSuccess, warn: h.logWarn, error: h.logError } };
});

import { runWindowedStep } from './windowed-runner.js';

type Capture = { onLine?: (line: string) => void; resolve?: (r: StepResult) => void };
let cap: Capture;
let stdoutWrite: ReturnType<typeof vi.spyOn>;
let writtenChunks: string[];

const LABELS: SpinnerLabels = { running: 'Building…', done: 'Built', failed: 'Build failed' };

function okResult(overrides: Partial<StepResult> = {}): StepResult {
  return { ok: true, exitCode: 0, blocks: [], transcript: 'all good\n', terminal: null, ...overrides };
}

beforeEach(() => {
  cap = {};
  h.spawnStep.mockReset();
  h.spawnStep.mockImplementation(
    (_step: string, _extra: string[], _onBlock: unknown, _rawLog: string, onLine?: (l: string) => void) => {
      cap.onLine = onLine;
      return new Promise<StepResult>((resolve) => {
        cap.resolve = resolve;
      });
    },
  );
  h.brightSelect.mockReset();
  h.brightSelect.mockResolvedValue('wait');
  h.offerClaudeOnFailure.mockReset();
  h.offerClaudeOnFailure.mockResolvedValue(false);
  h.phEmit.mockClear();
  h.logSuccess.mockClear();
  h.logWarn.mockClear();
  h.logError.mockClear();
  h.setupLogStep.mockClear();
  writtenChunks = [];
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writtenChunks.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutWrite.mockRestore();
  vi.useRealTimers();
});

describe('runWindowedStep — happy path', () => {
  it('emits step_started/step_completed, logs success, and returns the enriched result', async () => {
    const p = runWindowedStep('container', LABELS);
    await vi.waitFor(() => expect(cap.resolve).toBeDefined());
    cap.resolve!(okResult());
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.rawLog).toBe('/tmp/windowed-runner-coverage-fake.log');
    expect(typeof result.durationMs).toBe('number');
    expect(h.phEmit).toHaveBeenCalledWith('step_started', { step: 'container' });
    expect(h.phEmit).toHaveBeenCalledWith(
      'step_completed',
      expect.objectContaining({ step: 'container', status: 'success' }),
    );
    expect(h.logSuccess).toHaveBeenCalledOnce();
    expect(h.setupLogStep).toHaveBeenCalledOnce();
  });

  it('reports "skipped" status when the terminal block says so', async () => {
    const p = runWindowedStep('container', { ...LABELS, skipped: 'Already built' });
    await vi.waitFor(() => expect(cap.resolve).toBeDefined());
    cap.resolve!(okResult({ terminal: { type: 'BUILD', fields: { STATUS: 'skipped' } } }));
    const result = await p;
    expect(result.ok).toBe(true);
    expect(h.logSuccess).toHaveBeenCalledWith(expect.stringContaining('Already built'));
  });

  it('a failing step logs the failure headline and dumps the transcript tail', async () => {
    const p = runWindowedStep('container', LABELS);
    await vi.waitFor(() => expect(cap.resolve).toBeDefined());
    cap.resolve!({ ok: false, exitCode: 1, blocks: [], transcript: 'boom line 1\nboom line 2\n', terminal: null });
    const result = await p;
    expect(result.ok).toBe(false);
    expect(h.logError).toHaveBeenCalledOnce();
    expect(h.phEmit).toHaveBeenCalledWith('step_completed', expect.objectContaining({ status: 'failed' }));
  });

  it('falls back to "<running> failed" when no explicit failed label is given', async () => {
    const p = runWindowedStep('container', { running: 'Building…', done: 'Built' });
    await vi.waitFor(() => expect(cap.resolve).toBeDefined());
    cap.resolve!({ ok: false, exitCode: 1, blocks: [], transcript: '', terminal: null });
    await p;
    expect(h.logError).toHaveBeenCalledWith(expect.stringContaining('Building failed'));
  });
});

describe('runWindowedStep — the rolling line window', () => {
  it('feeds onLine through the redraw loop, stripping ANSI and dropping blank lines', async () => {
    const p = runWindowedStep('container', LABELS);
    await vi.waitFor(() => expect(cap.onLine).toBeDefined());
    cap.onLine!('\x1b[32mStep 1/5 : FROM node\x1b[0m');
    cap.onLine!('   '); // blank after trim -> not pushed as an action
    cap.onLine!('Step 2/5 : RUN npm install');
    cap.onLine!('Step 3/5 : COPY .');
    cap.onLine!('Step 4/5 : RUN build'); // window is 3 lines — oldest scrolls off
    cap.resolve!(okResult());
    await p;
    const rendered = writtenChunks.join('');
    expect(rendered).not.toContain('\x1b[32m'); // color code stripped before rendering
    expect(rendered).toContain('Step 2/5');
    expect(rendered).toContain('RUN build');
  });
});

describe('runWindowedStep — stall detection', () => {
  it('after 60s of silence, pauses the render and offers a choice; "wait" resumes without calling Claude', async () => {
    vi.useFakeTimers();
    const p = runWindowedStep('container', LABELS);
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.onLine).toBeDefined();
    h.brightSelect.mockResolvedValue('wait');
    await vi.advanceTimersByTimeAsync(65_000); // past the 60s threshold + a 5s poll tick
    expect(h.logWarn).toHaveBeenCalledWith(expect.stringContaining('looks stuck'));
    expect(h.phEmit).toHaveBeenCalledWith('step_stalled', { step: 'container' });
    expect(h.brightSelect).toHaveBeenCalledOnce();
    expect(h.offerClaudeOnFailure).not.toHaveBeenCalled();
    cap.resolve!(okResult());
    await p;
  });

  it('"help" routes to offerClaudeOnFailure with the raw log path, then still resumes', async () => {
    vi.useFakeTimers();
    const p = runWindowedStep('container', LABELS);
    await vi.advanceTimersByTimeAsync(0);
    h.brightSelect.mockResolvedValue('help');
    await vi.advanceTimersByTimeAsync(65_000);
    expect(h.offerClaudeOnFailure).toHaveBeenCalledWith(
      expect.objectContaining({ stepName: 'container', rawLogPath: '/tmp/windowed-runner-coverage-fake.log' }),
    );
    cap.resolve!(okResult());
    await p;
  });

  it('only offers the stall prompt once even if silence continues past the next poll', async () => {
    vi.useFakeTimers();
    const p = runWindowedStep('container', LABELS);
    await vi.advanceTimersByTimeAsync(0);
    h.brightSelect.mockResolvedValue('wait');
    await vi.advanceTimersByTimeAsync(65_000);
    expect(h.brightSelect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); // two more 5s polls with continued silence
    expect(h.brightSelect).toHaveBeenCalledTimes(1); // handledStall guard — no repeat offer
    cap.resolve!(okResult());
    await p;
  });

  it('a fresh line after the stall resets the silence clock — no repeat prompt at the old threshold', async () => {
    vi.useFakeTimers();
    const p = runWindowedStep('container', LABELS);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50_000); // under the 60s threshold
    cap.onLine!('still going'); // resets lastLineAt
    await vi.advanceTimersByTimeAsync(50_000); // would have tripped at 60s from start, but not from the reset line
    expect(h.brightSelect).not.toHaveBeenCalled();
    cap.resolve!(okResult());
    await p;
  });
});

describe('runWindowedStep — process exit cleanup', () => {
  it('restores the cursor if the process exits mid-step', async () => {
    const p = runWindowedStep('container', LABELS);
    await vi.waitFor(() => expect(cap.resolve).toBeDefined());
    process.emit('exit' as never, 0 as never);
    expect(writtenChunks.some((c) => c === '\x1b[?25h')).toBe(true);
    cap.resolve!(okResult());
    await p;
  });
});

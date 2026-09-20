/**
 * bright-select re-implements clack's select render() against
 * @clack/core's SelectPrompt. We mock SelectPrompt itself (no real TTY
 * interaction) to capture the options it's constructed with — in
 * particular the `render` function — and drive that function directly
 * with a fake `this` to exercise every render branch. `.prompt()` is
 * stubbed to resolve/reject with values the test controls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type RenderFn = (this: unknown) => string;
type CapturedOpts = { render: RenderFn; options: Array<{ value: unknown; label?: string; hint?: string }> };

const h = vi.hoisted(() => ({
  captured: undefined as CapturedOpts | undefined,
  promptResult: undefined as unknown,
}));

vi.mock('@clack/core', () => ({
  SelectPrompt: vi.fn(function (this: unknown, opts: CapturedOpts) {
    h.captured = opts;
    return { prompt: vi.fn(async () => h.promptResult) };
  }),
}));

import { brightSelect, flushStdin } from './bright-select.js';

function render(state: string, extra: Record<string, unknown> = {}): string {
  const ctx = { state, value: undefined, cursor: 0, ...extra };
  return h.captured!.render.call(ctx);
}

describe('brightSelect', () => {
  beforeEach(() => {
    h.captured = undefined;
    h.promptResult = 'picked';
  });

  it('flushes stdin (non-TTY: resolves immediately) then resolves to whatever SelectPrompt.prompt() returns', async () => {
    const result = await brightSelect({
      message: 'Pick one',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta', hint: 'the second' },
      ],
    });
    expect(result).toBe('picked');
    expect(h.captured).toBeDefined();
  });

  it('propagates the cancel symbol untouched', async () => {
    const CANCEL = Symbol('clack.cancel');
    h.promptResult = CANCEL;
    const result = await brightSelect({ message: 'Pick', options: [{ value: 'x' }] });
    expect(result).toBe(CANCEL);
  });

  describe('render()', () => {
    const options = [
      { value: 'a', label: 'Alpha', hint: 'first' },
      { value: 'b' }, // no label -> falls back to String(value)
    ];

    beforeEach(async () => {
      await brightSelect({ message: 'Choose', options, initialValue: 'a' });
    });

    it('renders the initial/active list with active cursor, hint and inactive rows', () => {
      const out = render('active', { cursor: 0 });
      expect(out).toContain('Choose');
      expect(out).toContain('Alpha');
      expect(out).toContain('(first)');
      expect(out).toContain('b'); // fallback label for the hint-less, label-less option
    });

    it('renders a non-zero cursor position (inactive-vs-active branch flip)', () => {
      const out = render('active', { cursor: 1 });
      expect(out).toContain('Alpha');
    });

    it('renders the submit state using the selected option label', () => {
      const out = render('submit', { value: 'a' });
      expect(out).toContain('Alpha');
    });

    it('renders the submit state falling back to String(value) when no matching option label', () => {
      const out = render('submit', { value: 'z' });
      expect(out).toContain('z');
    });

    it('renders the submit state falling back to the empty string when value is nullish and unmatched', () => {
      const out = render('submit', { value: undefined });
      expect(out).toContain('Choose');
    });

    it('renders the cancel state with strikethrough styling applied to the selected label', () => {
      const out = render('cancel', { value: 'b' });
      expect(out).toContain('b');
    });

    it('renders the error state using the default (cyan) header branch', () => {
      const out = render('error', { cursor: 0 });
      expect(out).toContain('Choose');
    });

    it('renders the initial state (default header icon branch)', () => {
      const out = render('initial', { cursor: 0 });
      expect(out).toContain('Choose');
    });
  });
});

describe('flushStdin', () => {
  const orig = process.stdin;

  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: orig, configurable: true });
  });

  it('resolves immediately when stdin is not a TTY', async () => {
    Object.defineProperty(process, 'stdin', { value: { isTTY: false }, configurable: true });
    await expect(flushStdin(5)).resolves.toBeUndefined();
  });

  it('drains buffered data for the window then resolves, restoring raw mode when it was off', async () => {
    const listeners: Record<string, (...a: unknown[]) => void> = {};
    const setRawMode = vi.fn();
    const fake = {
      isTTY: true,
      isRaw: false,
      setRawMode,
      on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
        listeners[ev] = cb;
      }),
      off: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    await flushStdin(5);
    expect(fake.on).toHaveBeenCalledWith('data', expect.any(Function));
    expect(fake.resume).toHaveBeenCalled();
    expect(fake.pause).toHaveBeenCalled();
    expect(setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(setRawMode).toHaveBeenNthCalledWith(2, false);
  });

  it('leaves raw mode enabled afterward when it was already on', async () => {
    const setRawMode = vi.fn();
    const fake = {
      isTTY: true,
      isRaw: true,
      setRawMode,
      on: vi.fn(),
      off: vi.fn(),
      resume: vi.fn(),
      pause: vi.fn(),
    };
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    await flushStdin(5);
    expect(setRawMode).toHaveBeenCalledTimes(1); // only the initial `true`, no restore-to-false
  });
});

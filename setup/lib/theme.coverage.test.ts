/**
 * Coverage for theme.ts. USE_ANSI/TRUECOLOR are computed ONCE at module
 * load from process.stdout.isTTY / NO_COLOR / COLORTERM, so each
 * combination needs a fresh module instance: set the env/TTY state, then
 * vi.resetModules() + dynamic import before asserting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// kleur computes its own `enabled` flag once, at its OWN module load time,
// by reading process.stdout.isTTY directly — and that load is effectively
// process-wide (vi.resetModules() doesn't reliably force a re-require of a
// node_modules dependency across every test file in the run). So the real
// kleur can't be trusted to reflect a per-test isTTY override here; mock it
// with distinguishable wrapper tags instead, purely to prove theme.ts calls
// the right kleur function for each branch.
vi.mock('kleur', () => {
  const wrap =
    (tag: string) =>
    (s: string): string =>
      `[${tag}]${s}[/${tag}]`;
  const k = {
    cyan: wrap('cyan'),
    bold: wrap('bold'),
    bgCyan: wrap('bgCyan'),
    black: wrap('black'),
    green: wrap('green'),
  };
  return { default: k, ...k };
});

const origIsTTY = process.stdout.isTTY;
const origColumns = process.stdout.columns;
const origNoColor = process.env.NO_COLOR;
const origColorterm = process.env.COLORTERM;

async function loadTheme(opts: {
  isTTY: boolean;
  colorterm?: string;
  noColor?: string;
}): Promise<typeof import('./theme.js')> {
  process.stdout.isTTY = opts.isTTY;
  if (opts.noColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = opts.noColor;
  if (opts.colorterm === undefined) delete process.env.COLORTERM;
  else process.env.COLORTERM = opts.colorterm;
  vi.resetModules();
  return import('./theme.js');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.stdout.isTTY = origIsTTY;
  process.stdout.columns = origColumns;
  if (origNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = origNoColor;
  if (origColorterm === undefined) delete process.env.COLORTERM;
  else process.env.COLORTERM = origColorterm;
  vi.resetModules();
});

describe('color gating', () => {
  it('no TTY: every colorizer returns the plain string, untouched', async () => {
    const theme = await loadTheme({ isTTY: false });
    expect(theme.brand('x')).toBe('x');
    expect(theme.brandBold('x')).toBe('x');
    expect(theme.brandChip('x')).toBe('x');
    expect(theme.accentGreen('x')).toBe('x');
    expect(theme.brandBody('x')).toBe('x');
  });

  it('NO_COLOR set (even with a TTY) forces plain output', async () => {
    const theme = await loadTheme({ isTTY: true, noColor: '1' });
    expect(theme.brand('x')).toBe('x');
  });

  it('TTY + no COLORTERM: uses kleur, not raw 24-bit escapes', async () => {
    const theme = await loadTheme({ isTTY: true });
    expect(theme.brand('x')).toBe('[cyan]x[/cyan]');
    expect(theme.brand('x')).not.toContain('38;2;43;183;206'); // not the truecolor sequence
    expect(theme.brandBold('x')).toBe('[bold][cyan]x[/cyan][/bold]');
    expect(theme.brandChip('x')).toBe('[bgCyan][black][bold]x[/bold][/black][/bgCyan]');
    expect(theme.accentGreen('x')).toBe('[green]x[/green]');
    expect(theme.brandBody('x')).toBe('[cyan]x[/cyan]');
  });

  it('TTY + COLORTERM=truecolor: uses the exact 24-bit brand-cyan escape', async () => {
    const theme = await loadTheme({ isTTY: true, colorterm: 'truecolor' });
    expect(theme.brand('x')).toBe('\x1b[38;2;43;183;206mx\x1b[0m');
    expect(theme.brandBold('x')).toBe('\x1b[1;38;2;43;183;206mx\x1b[0m');
    expect(theme.brandChip('x')).toBe('\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1mx\x1b[0m');
    expect(theme.accentGreen('x')).toBe('\x1b[38;2;63;186;80mx\x1b[39m');
  });

  it('TTY + COLORTERM=24bit is treated the same as truecolor', async () => {
    const theme = await loadTheme({ isTTY: true, colorterm: '24bit' });
    expect(theme.brand('x')).toBe('\x1b[38;2;43;183;206mx\x1b[0m');
  });

  it('brandBody colors each line independently in truecolor mode, leaving blank lines untouched', async () => {
    const theme = await loadTheme({ isTTY: true, colorterm: 'truecolor' });
    const out = theme.brandBody('one\n\ntwo');
    expect(out).toBe('\x1b[38;2;43;183;206mone\x1b[39m\n\n\x1b[38;2;43;183;206mtwo\x1b[39m');
  });

  it('brandBody colors each line independently in kleur mode too, leaving blank lines untouched', async () => {
    const theme = await loadTheme({ isTTY: true });
    expect(theme.brandBody('one\n\ntwo')).toBe('[cyan]one[/cyan]\n\n[cyan]two[/cyan]');
  });
});

describe('fmtDuration', () => {
  it('sub-minute durations stay in plain seconds', async () => {
    const { fmtDuration } = await loadTheme({ isTTY: false });
    expect(fmtDuration(0)).toBe('0s');
    expect(fmtDuration(47_000)).toBe('47s');
    expect(fmtDuration(59_499)).toBe('59s');
  });

  it('60s and above switch to "Xm Ys", consistent even at whole minutes', async () => {
    const { fmtDuration } = await loadTheme({ isTTY: false });
    expect(fmtDuration(60_000)).toBe('1m 0s');
    expect(fmtDuration(154_000)).toBe('2m 34s');
    expect(fmtDuration(240_000)).toBe('4m 0s');
  });
});

describe('note', () => {
  it('delegates to p.note with brandBody as the line formatter', async () => {
    const theme = await loadTheme({ isTTY: false });
    const clackNote = vi.fn();
    vi.doMock('@clack/prompts', async (importActual) => {
      const actual = await importActual<typeof import('@clack/prompts')>();
      return { ...actual, note: clackNote };
    });
    vi.resetModules();
    const fresh = await import('./theme.js');
    fresh.note('body text', 'A Title');
    expect(clackNote).toHaveBeenCalledWith('body text', 'A Title', { format: fresh.brandBody });
    vi.doUnmock('@clack/prompts');
  });
});

describe('fitToWidth', () => {
  it('returns the label unchanged when it fits the budget', async () => {
    const { fitToWidth } = await loadTheme({ isTTY: false });
    process.stdout.columns = 80;
    expect(fitToWidth('short label', ' (5s)')).toBe('short label');
  });

  it('truncates with an ellipsis when the label + suffix would overflow', async () => {
    const { fitToWidth } = await loadTheme({ isTTY: false });
    process.stdout.columns = 40;
    const long = 'a'.repeat(60);
    const out = fitToWidth(long, ' (99m 59s)');
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it('falls back to 80 columns when process.stdout.columns is unset', async () => {
    const { fitToWidth } = await loadTheme({ isTTY: false });
    process.stdout.columns = undefined as unknown as number;
    expect(fitToWidth('short', '')).toBe('short');
  });
});

describe('wrapForGutter / dimWrap', () => {
  it('leaves short lines alone', async () => {
    const { wrapForGutter } = await loadTheme({ isTTY: false });
    process.stdout.columns = 80;
    expect(wrapForGutter('a short line', 4)).toBe('a short line');
  });

  it('word-wraps a long line at the gutter-adjusted width', async () => {
    const { wrapForGutter } = await loadTheme({ isTTY: false });
    process.stdout.columns = 40;
    const text = Array.from({ length: 12 }, (_, i) => `word${i}`).join(' ');
    const out = wrapForGutter(text, 4);
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(36);
  });

  it('wraps multi-line input independently, and never splits a single overlong word', async () => {
    const { wrapForGutter } = await loadTheme({ isTTY: false });
    process.stdout.columns = 40;
    const overlong = 'x'.repeat(100);
    const out = wrapForGutter(`short\n${overlong}`, 4);
    const lines = out.split('\n');
    expect(lines[0]).toBe('short');
    expect(lines.some((l) => l === overlong)).toBe(true); // one unbroken word, even past the width
  });

  it('dimWrap is an alias for wrapForGutter', async () => {
    const { wrapForGutter, dimWrap } = await loadTheme({ isTTY: false });
    process.stdout.columns = 50;
    const text = 'the quick brown fox jumps over the lazy dog many times over';
    expect(dimWrap(text, 6)).toBe(wrapForGutter(text, 6));
  });

  it('respects a minimum width floor of 30 columns even in a very narrow terminal', async () => {
    const { wrapForGutter } = await loadTheme({ isTTY: false });
    process.stdout.columns = 10; // cols - gutter would go negative without the floor
    const text = 'aaaaaaaaaa bbbbbbbbbb cccccccccc';
    const out = wrapForGutter(text, 4);
    expect(out.split('\n').length).toBeGreaterThan(1);
  });
});

import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  isHeadless: vi.fn(() => false),
  confirm: vi.fn(async () => true),
  logInfo: vi.fn(),
  ensureAnswer: vi.fn((v: unknown) => v),
}));

vi.mock('child_process', () => ({ spawn: h.spawn }));
vi.mock('../platform.js', () => ({ isHeadless: h.isHeadless }));
vi.mock('./runner.js', () => ({ ensureAnswer: h.ensureAnswer }));
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return { ...actual, confirm: h.confirm, log: { ...actual.log, info: h.logInfo } };
});

import { openUrl, formatNoteLink, confirmThenOpen } from './browser.js';

class FakeChild extends EventEmitter {
  unref = vi.fn();
}

let child: FakeChild;

beforeEach(() => {
  child = new FakeChild();
  h.spawn.mockReset();
  h.spawn.mockReturnValue(child);
  h.isHeadless.mockReturnValue(false);
  h.confirm.mockClear();
  h.confirm.mockResolvedValue(true);
  h.logInfo.mockClear();
  h.ensureAnswer.mockClear();
  h.ensureAnswer.mockImplementation((v: unknown) => v);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openUrl', () => {
  it('spawns "open" on darwin, detached and ignored, then unrefs', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      openUrl('https://example.com');
      expect(h.spawn).toHaveBeenCalledWith('open', ['https://example.com'], { stdio: 'ignore', detached: true });
      expect(child.unref).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('spawns "xdg-open" on non-darwin platforms', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      openUrl('https://example.com');
      expect(h.spawn).toHaveBeenCalledWith('xdg-open', ['https://example.com'], { stdio: 'ignore', detached: true });
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });

  it('swallows a child error event silently', () => {
    expect(() => {
      openUrl('https://example.com');
      child.emit('error', new Error('ENOENT'));
    }).not.toThrow();
  });

  it('swallows a synchronous spawn throw', () => {
    h.spawn.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => openUrl('https://example.com')).not.toThrow();
  });
});

describe('formatNoteLink', () => {
  it('returns a labeled line on headless devices', () => {
    h.isHeadless.mockReturnValue(true);
    expect(formatNoteLink('https://example.com')).toBe('\nGet started: https://example.com');
  });

  it('returns null on GUI devices (URL surfaces elsewhere)', () => {
    h.isHeadless.mockReturnValue(false);
    expect(formatNoteLink('https://example.com')).toBeNull();
  });
});

describe('confirmThenOpen', () => {
  it('on headless devices: prints the URL raw to stdout and never confirms or opens', async () => {
    h.isHeadless.mockReturnValue(true);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await confirmThenOpen('https://example.com');
    expect(h.logInfo).toHaveBeenCalledWith('Open this URL in a browser on any device:');
    expect(write).toHaveBeenCalledWith('\nhttps://example.com\n\n');
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('on GUI devices: confirms with the fallback line, then opens on accept', async () => {
    h.isHeadless.mockReturnValue(false);
    h.confirm.mockResolvedValue(true);
    await confirmThenOpen('https://example.com', 'Continue?');
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Continue?'),
        initialValue: true,
      }),
    );
    expect(String(h.confirm.mock.calls[0][0].message)).toContain('https://example.com');
    expect(h.spawn).toHaveBeenCalledWith(expect.any(String), ['https://example.com'], expect.any(Object));
  });

  it('still opens even when ensureAnswer unwraps a falsy confirm (proceed-on-cancel semantics live in ensureAnswer)', async () => {
    h.isHeadless.mockReturnValue(false);
    h.confirm.mockResolvedValue(false);
    h.ensureAnswer.mockReturnValue(false);
    await confirmThenOpen('https://example.com');
    // openUrl runs unconditionally after ensureAnswer resolves in the source —
    // confirm() gates the pause, not whether the browser opens.
    expect(h.spawn).toHaveBeenCalled();
  });
});

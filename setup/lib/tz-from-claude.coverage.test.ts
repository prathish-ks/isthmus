import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spinnerStart: vi.fn(),
  spinnerMessage: vi.fn(),
  spinnerStop: vi.fn(),
}));

vi.mock('child_process', () => ({ execSync: h.execSync, spawn: h.spawn }));
vi.mock('@clack/prompts', async (importActual) => {
  const actual = await importActual<typeof import('@clack/prompts')>();
  return {
    ...actual,
    spinner: () => ({ start: h.spinnerStart, message: h.spinnerMessage, stop: h.spinnerStop }),
  };
});

import { claudeCliAvailable, resolveTimezoneViaClaude } from './tz-from-claude.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stdin = { end: vi.fn() };
}

function nextChild(): FakeChild {
  const child = new FakeChild();
  h.spawn.mockReturnValueOnce(child);
  return child;
}

async function waitForSpawn(): Promise<void> {
  await vi.waitFor(() => {
    if (h.spawn.mock.calls.length === 0) throw new Error('not yet');
  });
}

beforeEach(() => {
  h.execSync.mockReset();
  h.spawn.mockReset();
  h.spinnerStart.mockClear();
  h.spinnerMessage.mockClear();
  h.spinnerStop.mockClear();
});

describe('claudeCliAvailable', () => {
  it('true when `command -v claude` succeeds', () => {
    h.execSync.mockReturnValue('');
    expect(claudeCliAvailable()).toBe(true);
  });

  it('false when it throws (not on PATH)', () => {
    h.execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(claudeCliAvailable()).toBe(false);
  });
});

describe('resolveTimezoneViaClaude', () => {
  it('returns null immediately when claude is not installed, never spawning', async () => {
    h.execSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const result = await resolveTimezoneViaClaude('eastern');
    expect(result).toBeNull();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('resolves a valid IANA zone Claude replies with, stops the spinner with a success message', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('NYC');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.stdout.emit('data', Buffer.from('America/New_York\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result).toBe('America/New_York');
    expect(h.spinnerStart).toHaveBeenCalled();
    expect(h.spinnerStop).toHaveBeenCalledWith(expect.stringContaining('Interpreted as America/New_York.'));
  });

  it('strips quote/backtick wrapping and skips leading non-zone lines', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('NYC');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.stdout.emit('data', Buffer.from('here you go:\n`America/New_York`\n'));
    child.emit('close', 0);
    expect(await p).toBe('America/New_York');
  });

  it('returns null and stops the spinner with a failure code when Claude replies UNKNOWN', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('the moon');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.stdout.emit('data', Buffer.from('UNKNOWN\n'));
    child.emit('close', 0);
    expect(await p).toBeNull();
    expect(h.spinnerStop).toHaveBeenCalledWith(expect.stringContaining("Couldn't interpret"), 1);
  });

  it('returns null when every line is bogus (not a valid IANA zone, not UNKNOWN)', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('nonsense');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.stdout.emit('data', Buffer.from('Not A Real Zone\n'));
    child.emit('close', 0);
    expect(await p).toBeNull();
  });

  it('returns null on a non-zero close code (empty/failed reply)', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('NYC');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.emit('close', 1);
    expect(await p).toBeNull();
  });

  it('returns null when the child emits an error', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('NYC');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.emit('error', new Error('ENOENT'));
    expect(await p).toBeNull();
  });

  it('ignores a close event after an error already settled the promise', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('NYC');
    await waitForSpawn();
    const child = h.spawn.mock.results[0].value as FakeChild;
    child.emit('error', new Error('boom'));
    child.emit('close', 0);
    expect(await p).toBeNull();
  });

  it('pipes the built prompt to the child stdin', async () => {
    h.execSync.mockReturnValue('');
    nextChild();
    const p = resolveTimezoneViaClaude('NYC');
    await waitForSpawn();
    expect(h.spawn).toHaveBeenCalledWith('claude', ['-p', '--output-format', 'text'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = h.spawn.mock.results[0].value as FakeChild;
    expect(child.stdin.end).toHaveBeenCalledWith(expect.stringContaining("User's description: NYC"));
    child.emit('close', 1);
    await p;
  });
});

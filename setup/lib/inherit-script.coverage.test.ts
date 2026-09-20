import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: h.spawn }));

import { runInheritScript } from './inherit-script.js';

class FakeChild extends EventEmitter {}

const origStdin = process.stdin;

function stubStdin(overrides: Partial<{ isTTY: boolean; isRaw: boolean }>): {
  setRawMode: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
} {
  const setRawMode = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  Object.defineProperty(process, 'stdin', {
    value: { isTTY: false, isRaw: false, ...overrides, setRawMode, pause, resume },
    configurable: true,
  });
  return { setRawMode, pause, resume };
}

beforeEach(() => {
  h.spawn.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
});

describe('runInheritScript', () => {
  it('non-TTY: pauses stdin without touching raw mode, spawns with inherited stdio + the wizard env flag, resumes on close', async () => {
    const { setRawMode, pause, resume } = stubStdin({ isTTY: false });
    const child = new FakeChild();
    h.spawn.mockReturnValue(child);
    const p = runInheritScript('bash', ['script.sh', 'arg1']);
    expect(pause).toHaveBeenCalled();
    expect(setRawMode).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledWith('bash', ['script.sh', 'arg1'], {
      stdio: 'inherit',
      env: expect.objectContaining({ NANOCLAW_SETUP_WIZARD: '1' }),
    });
    child.emit('close', 0);
    expect(await p).toBe(0);
    expect(resume).toHaveBeenCalled();
  });

  it('TTY + raw mode active: disables raw mode before spawning', async () => {
    const { setRawMode } = stubStdin({ isTTY: true, isRaw: true });
    const child = new FakeChild();
    h.spawn.mockReturnValue(child);
    const p = runInheritScript('bash', []);
    expect(setRawMode).toHaveBeenCalledWith(false);
    child.emit('close', 0);
    await p;
  });

  it('TTY but not raw: leaves raw mode alone', async () => {
    const { setRawMode } = stubStdin({ isTTY: true, isRaw: false });
    const child = new FakeChild();
    h.spawn.mockReturnValue(child);
    const p = runInheritScript('bash', []);
    expect(setRawMode).not.toHaveBeenCalled();
    child.emit('close', 0);
    await p;
  });

  it('resolves 1 when the child closes with a null exit code (signal kill)', async () => {
    stubStdin({ isTTY: false });
    const child = new FakeChild();
    h.spawn.mockReturnValue(child);
    const p = runInheritScript('bash', []);
    child.emit('close', null);
    expect(await p).toBe(1);
  });

  it('propagates a non-zero exit code', async () => {
    stubStdin({ isTTY: false });
    const child = new FakeChild();
    h.spawn.mockReturnValue(child);
    const p = runInheritScript('bash', []);
    child.emit('close', 7);
    expect(await p).toBe(7);
  });
});

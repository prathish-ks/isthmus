/**
 * Coverage for pingCliAgent — the spawn/timeout/error wiring around
 * classifyPingResult (already covered by agent-ping.test.ts).
 */
import { EventEmitter } from 'node:events';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn: h.spawn }));

import { pingCliAgent } from './agent-ping.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

let child: FakeChild;

beforeEach(() => {
  child = new FakeChild();
  h.spawn.mockReset();
  h.spawn.mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pingCliAgent', () => {
  it('spawns pnpm run chat ping with piped stdio', async () => {
    const p = pingCliAgent();
    child.stdout.emit('data', Buffer.from('pong\n'));
    child.emit('close', 0);
    const result = await p;
    expect(result).toBe('ok');
    expect(h.spawn).toHaveBeenCalledWith('pnpm', ['run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('accumulates stdout + stderr chunks and classifies via close code', async () => {
    const p = pingCliAgent();
    child.stdout.emit('data', Buffer.from(''));
    child.stderr.emit('data', Buffer.from('Authentication error'));
    child.emit('close', 1);
    expect(await p).toBe('auth_error');
  });

  it('resolves socket_error on close code 2', async () => {
    const p = pingCliAgent();
    child.emit('close', 2);
    expect(await p).toBe('socket_error');
  });

  it('resolves no_reply on empty output with a zero close code', async () => {
    const p = pingCliAgent();
    child.emit('close', 0);
    expect(await p).toBe('no_reply');
  });

  it('resolves socket_error when the child emits an error event', async () => {
    const p = pingCliAgent();
    child.emit('error', new Error('ENOENT'));
    expect(await p).toBe('socket_error');
  });

  it('ignores a close event after an error already settled the promise', async () => {
    const p = pingCliAgent();
    child.emit('error', new Error('ENOENT'));
    child.emit('close', 0); // must not throw or change the resolution
    expect(await p).toBe('socket_error');
  });

  it('kills the child and resolves no_reply when the timeout fires first', async () => {
    vi.useFakeTimers();
    const p = pingCliAgent(1000);
    vi.advanceTimersByTime(1000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(await p).toBe('no_reply');
  });

  it('ignores a late close after the timeout already settled the promise', async () => {
    vi.useFakeTimers();
    const p = pingCliAgent(1000);
    vi.advanceTimersByTime(1000);
    child.emit('close', 0); // must not throw or double-resolve
    expect(await p).toBe('no_reply');
  });

  it('ignores an error event after close already settled the promise', async () => {
    const p = pingCliAgent();
    child.emit('close', 0);
    child.emit('error', new Error('late')); // must not throw or change the resolution
    expect(await p).toBe('no_reply');
  });
});

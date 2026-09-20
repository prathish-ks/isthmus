/**
 * Typing refresh — the lifecycle the instance-forwarding suite leaves open:
 * the heartbeat gate after the grace window (fresh → keep typing, stale →
 * self-stop), the post-delivery pause, stop/pause on unknown sessions, and
 * best-effort tolerance of a throwing or absent setTyping.
 *
 * Fake timers drive the 4s interval; the heartbeat file lives under a temp
 * DATA_DIR and its mtime is pinned to the faked clock.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DIR = '/tmp/nanoclaw-test-typing-cov';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-typing-cov' };
});

import { heartbeatPath } from '../../session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter, startTypingRefresh, stopTypingRefresh } from './index.js';

type Call = { channelType: string; platformId: string; threadId: string | null; instance?: string };

function captureAdapter(): Call[] {
  const calls: Call[] = [];
  setTypingAdapter({
    async setTyping(channelType, platformId, threadId, instance) {
      calls.push({ channelType, platformId, threadId, instance });
    },
  });
  return calls;
}

/** Touch the session heartbeat so its mtime equals the (faked) current time. */
function touchHeartbeat(): void {
  const hb = heartbeatPath('ag-1', 'sess-1');
  fs.mkdirSync(path.dirname(hb), { recursive: true });
  fs.writeFileSync(hb, '');
  const t = new Date(Date.now());
  fs.utimesSync(hb, t, t);
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.useFakeTimers();
});

afterEach(() => {
  stopTypingRefresh('sess-1');
  stopTypingRefresh('sess-2');
  vi.useRealTimers();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('heartbeat gate after the grace window', () => {
  it('stops refreshing once the grace window passes with no heartbeat file', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // 15s grace = ticks at 4, 8, 12s fire; the 16s tick sees no heartbeat.
    await vi.advanceTimersByTimeAsync(16_500);
    expect(calls).toHaveLength(3);
    // Refresher removed itself: no further ticks...
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(3);
    // ...and a new start creates a fresh refresher (immediate tick).
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(4);
  });

  it('keeps refreshing while the heartbeat is fresh, then stops when it goes stale', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', 'T1', 'slack-a');
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    // Past the grace window with a heartbeat touched just now → still typing.
    await vi.advanceTimersByTimeAsync(14_000);
    touchHeartbeat();
    await vi.advanceTimersByTimeAsync(2_500); // 16s tick: 2.5s-old heartbeat is fresh
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toEqual({ channelType: 'slack', platformId: 'C1', threadId: 'T1', instance: 'slack-a' });

    // 20s tick: heartbeat is now 6.5s old → stale → stop.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(calls).toHaveLength(4);
  });
});

describe('post-delivery pause', () => {
  it('skips ticks for 10s after a delivery, then resumes', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    pauseTypingRefreshAfterDelivery('sess-1');
    await vi.advanceTimersByTimeAsync(8_500); // 4s, 8s ticks fall inside the pause
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4_000); // 12s tick: pause over, still in grace
    expect(calls).toHaveLength(1);
  });

  it('a new inbound message on the same session clears the pause immediately', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;

    pauseTypingRefreshAfterDelivery('sess-1');
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1); // immediate re-trigger tick
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls).toHaveLength(2); // interval tick no longer paused
  });

  it('is a no-op for a session with no active refresher', () => {
    expect(() => pauseTypingRefreshAfterDelivery('sess-unknown')).not.toThrow();
  });
});

describe('stopTypingRefresh', () => {
  it('clears the interval so no more ticks fire', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(12_500);
    expect(calls).toHaveLength(1);
  });

  it('is a no-op for a session with no active refresher', () => {
    expect(() => stopTypingRefresh('sess-unknown')).not.toThrow();
  });

  it('only stops the named session', async () => {
    const calls = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    startTypingRefresh('sess-2', 'ag-1', 'slack', 'C2', null);
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    stopTypingRefresh('sess-1');
    await vi.advanceTimersByTimeAsync(4_500);
    expect(calls).toHaveLength(1);
    expect(calls[0].platformId).toBe('C2');
  });
});

describe('best-effort adapter calls', () => {
  it('swallows a throwing setTyping and keeps the refresher alive', async () => {
    let attempts = 0;
    setTypingAdapter({
      async setTyping() {
        attempts++;
        throw new Error('rate limited');
      },
    });
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(attempts).toBe(2);
  });

  it('tolerates an adapter without setTyping and keeps the refresher alive', async () => {
    setTypingAdapter({});
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(4_500); // immediate + one interval tick, both no-ops
    // Still refreshing: a capable adapter bound afterwards gets the next tick.
    const calls = captureAdapter();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toHaveLength(1);
  });

  it('a replacement adapter is used by the next tick of an active refresher', async () => {
    const first = captureAdapter();
    startTypingRefresh('sess-1', 'ag-1', 'slack', 'C1', null);
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveLength(1);
    const second = captureAdapter();
    await vi.advanceTimersByTimeAsync(4_500);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});

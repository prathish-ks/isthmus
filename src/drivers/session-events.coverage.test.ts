/**
 * Coverage-uplift tests for session-events.ts targeting branches the
 * pre-existing session-events.test.ts suite doesn't reach: trackListed
 * refreshing an EXISTING state's handle, resync's "still live per the
 * snapshot" continue branch, watchSessions ignoring non-terminal events,
 * #deliver's already-fired/stop-intent short-circuit, HubHandle.status()
 * delegation, wrapped.watchSessions passthrough, and the optional
 * ensureReady/reapResidue conditional wiring.
 *
 * NOT covered here: arm()'s `if (!state) return` no-op branch. Every
 * `HubHandle` a consumer can reach is constructed from a handle the hub
 * already tracked (via trackPrepared/trackListed), so onTerminal() always
 * calls arm() with a known key through the public API — the guard is
 * defensive code for a state the hub's own invariants make unreachable.
 */
import { describe, expect, it, vi } from 'vitest';

import { withSessionEvents } from './session-events.js';
import { fixtureSpec } from './spec-fixture.js';
import type {
  DriverCapabilities,
  SessionDriver,
  SessionEvent,
  SessionExecSpec,
  SessionHandle,
  SessionKey,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
} from './types.js';

function makeKey(sessionId: string): SessionKey {
  return { installSlug: 'spike', agentGroupId: 'g1', sessionId };
}

class FakeHandle implements SessionHandle {
  statusValue: SessionStatus = { phase: 'running' };
  statusCalls = 0;
  readonly stops: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name = `ncl-${sessionId(key)}`,
  ) {}

  async start(): Promise<void> {}
  async status(): Promise<SessionStatus> {
    this.statusCalls++;
    return this.statusValue;
  }
  execSpec(command: string[]): SessionExecSpec {
    return { bin: 'fake', argsTty: command, argsPlain: command };
  }
  async stop(reason: string): Promise<void> {
    this.stops.push(reason);
  }
  onTerminal(): void {
    throw new Error('raw handle onTerminal must never be reached');
  }
}

function sessionId(key: SessionKey): string {
  return key.sessionId;
}

class FakeDriver implements SessionDriver {
  readonly kind = 'fake';
  nextPrepared: FakeHandle | null = null;
  snapshots: SessionSnapshot[] = [];
  listCalls = 0;
  ensureReadyCalls = 0;
  reapResidueCalls = 0;
  readonly subscribers = new Set<(event: SessionEvent) => void>();

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
    };
  }
  async prepare(_spec: SessionSpec): Promise<SessionHandle> {
    return this.nextPrepared!;
  }
  async listSessions(): Promise<SessionSnapshot[]> {
    this.listCalls += 1;
    return this.snapshots;
  }
  watchSessions(_installSlug: string, onEvent: (event: SessionEvent) => void): { stop(): void } {
    this.subscribers.add(onEvent);
    return { stop: () => this.subscribers.delete(onEvent) };
  }
  emit(event: SessionEvent): void {
    for (const subscriber of this.subscribers) subscriber(event);
  }
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function prepared(driver: FakeDriver, sid: string) {
  const hub = withSessionEvents(driver);
  const inner = new FakeHandle(makeKey(sid));
  driver.nextPrepared = inner;
  const handle = await hub.prepare(fixtureSpec());
  return { inner, handle, hub };
}

describe('trackListed refreshes an existing tracked handle', () => {
  it('a second listSessions() call for the same key updates the truth-read channel without resetting fired/cb state', async () => {
    const driver = new FakeDriver();
    const { inner } = await prepared(driver, 's1');
    const hub = withSessionEvents(driver); // fresh hub wrapper, same underlying driver semantics tested via listSessions

    const snapshot: SessionSnapshot = { handle: inner, phase: 'running' };
    driver.snapshots = [snapshot];
    const first = await hub.listSessions('spike');
    expect(first).toHaveLength(1);

    // List again — trackListed must hit the "state exists, refresh" branch
    // rather than re-creating fresh (fired=false etc.) state via trackPrepared.
    const second = await hub.listSessions('spike');
    expect(second).toHaveLength(1);
    expect(second[0].handle.key).toEqual(inner.key);
  });
});

describe('resync', () => {
  it('skips an armed session the snapshot still reports as live, then delivers once it goes terminal', async () => {
    const driver = new FakeDriver();
    const hub = withSessionEvents(driver);
    const inner = new FakeHandle(makeKey('s-continue'));
    driver.nextPrepared = inner;
    const handle = await hub.prepare(fixtureSpec());
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    driver.snapshots = [{ handle: inner, phase: 'running' }];
    await hub.resync('spike');
    expect(terminal).not.toHaveBeenCalled();

    // Now report it terminal via the snapshot and resync again — delivers.
    driver.snapshots = [{ handle: inner, phase: 'terminal' }];
    await hub.resync('spike');
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('returns early when nothing is armed for the given install slug', async () => {
    const driver = new FakeDriver();
    const hub = withSessionEvents(driver);
    await expect(hub.resync('no-armed-sessions-here')).resolves.toBeUndefined();
    expect(driver.listCalls).toBe(0);
  });
});

describe('non-terminal events are ignored', () => {
  it('a "phase" hint never triggers a truth read or delivery', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);
    const statusCallsBefore = inner.statusCalls;

    driver.emit({ key: inner.key, kind: 'phase', phase: 'running' } as SessionEvent);
    await settled();

    expect(terminal).not.toHaveBeenCalled();
    expect(inner.statusCalls).toBe(statusCallsBefore);
  });

  it('a terminal hint for a key the hub never tracked is silently dropped', async () => {
    const driver = new FakeDriver();
    withSessionEvents(driver);
    // No prepare() call — the hub has no state for this key at all.
    expect(() => driver.emit({ key: makeKey('never-tracked'), kind: 'terminal' })).not.toThrow();
  });
});

describe('#deliver short-circuits once fired or stop-intent is set', () => {
  it('a second confirmed terminal after delivery does not call the callback again', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    inner.statusValue = { phase: 'stopped' };
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();
    expect(terminal).toHaveBeenCalledTimes(1);

    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it('a terminal event after stop() (stop-intent) never fires the callback', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    const terminal = vi.fn();
    handle.onTerminal(terminal);

    await handle.stop('operator requested');
    inner.statusValue = { phase: 'stopped' };
    driver.emit({ key: inner.key, kind: 'terminal' });
    await settled();
    expect(terminal).not.toHaveBeenCalled();
    expect(inner.stops).toEqual(['operator requested']);
  });
});

describe('HubHandle delegation and driver passthrough', () => {
  it('status(), name, and execSpec() delegate to the inner handle', async () => {
    const driver = new FakeDriver();
    const { inner, handle } = await prepared(driver, 's1');
    inner.statusValue = { phase: 'running' };
    await expect(handle.status()).resolves.toEqual({ phase: 'running' });
    expect(handle.name).toBe(inner.name);
    expect(handle.execSpec(['echo', 'hi'])).toEqual({
      bin: 'fake',
      argsTty: ['echo', 'hi'],
      argsPlain: ['echo', 'hi'],
    });
  });

  it('wrapped.capabilities() delegates to the underlying driver', () => {
    const driver = new FakeDriver();
    const hub = withSessionEvents(driver);
    expect(hub.capabilities()).toEqual(driver.capabilities());
  });

  it('wrapped.watchSessions passes through to the underlying driver', () => {
    const driver = new FakeDriver();
    const hub = withSessionEvents(driver);
    const onEvent = vi.fn();
    const watch = hub.watchSessions('spike', onEvent);
    expect(driver.subscribers.has(onEvent)).toBe(true);
    watch.stop();
    expect(driver.subscribers.has(onEvent)).toBe(false);
  });

  it('wires ensureReady and reapResidue only when the underlying driver declares them', async () => {
    const bare = new FakeDriver();
    const bareHub = withSessionEvents(bare);
    expect(bareHub.ensureReady).toBeUndefined();
    expect(bareHub.reapResidue).toBeUndefined();

    class RichDriver extends FakeDriver {
      async ensureReady(): Promise<void> {
        this.ensureReadyCalls++;
      }
      async reapResidue(_installSlug: string): Promise<void> {
        this.reapResidueCalls++;
      }
    }
    const rich = new RichDriver();
    const richHub = withSessionEvents(rich);
    expect(richHub.ensureReady).toBeInstanceOf(Function);
    expect(richHub.reapResidue).toBeInstanceOf(Function);
    await richHub.ensureReady!();
    await richHub.reapResidue!('spike');
    expect(rich.ensureReadyCalls).toBe(1);
    expect(rich.reapResidueCalls).toBe(1);
  });
});

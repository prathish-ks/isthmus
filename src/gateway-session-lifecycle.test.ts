import { describe, expect, it, vi } from 'vitest';

import { releaseGatewaySession, type GatewaySessionControl } from './gateway-session-lifecycle.js';
import type { GatewayContribution } from './gateway-providers/gateway-provider-registry.js';

const CONTRIBUTION: GatewayContribution = {
  networkAccess: { endpoint: 'none', target: { kind: 'host' } },
};

function makeControl(release?: (event: { kind: string; reason: string }) => Promise<void>): GatewaySessionControl {
  return {
    lease: { contribution: CONTRIBUTION, release },
    controller: new AbortController(),
  };
}

describe('releaseGatewaySession', () => {
  it('aborts the controller and awaits the lease release', async () => {
    const release = vi.fn(async () => {});
    const control = makeControl(release);
    const abortListener = vi.fn();
    control.controller.signal.addEventListener('abort', abortListener);

    await releaseGatewaySession(control, { kind: 'session-ended', reason: 'test' });

    expect(abortListener).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'test' });
  });

  it('is a no-op-safe when the lease declares no release', async () => {
    const control = makeControl(undefined);
    await expect(
      releaseGatewaySession(control, { kind: 'host-detached', reason: 'takeover' }),
    ).resolves.toBeUndefined();
  });

  it('is idempotent: calling twice never aborts or releases twice, and both calls resolve the same promise', async () => {
    const release = vi.fn(async () => {});
    const control = makeControl(release);
    const abortListener = vi.fn();
    control.controller.signal.addEventListener('abort', abortListener);

    const first = releaseGatewaySession(control, { kind: 'session-ended', reason: 'first' });
    const second = releaseGatewaySession(control, { kind: 'session-ended', reason: 'second' });

    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(abortListener).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    // The event from the second, ignored call never reaches the lease.
    expect(release).toHaveBeenCalledWith({ kind: 'session-ended', reason: 'first' });
  });

  it('installs the returned promise before any synchronous abort listener runs, so a listener can await it', async () => {
    const release = vi.fn(async () => {});
    const control = makeControl(release);
    let sawReleasingFromListener: Promise<void> | undefined;
    control.controller.signal.addEventListener('abort', () => {
      sawReleasingFromListener = control.releasing;
    });

    const returned = releaseGatewaySession(control, { kind: 'session-ended', reason: 'test' });
    await returned;

    expect(sawReleasingFromListener).toBe(returned);
  });
});

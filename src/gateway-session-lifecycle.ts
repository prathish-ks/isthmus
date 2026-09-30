/**
 * Per-session gateway lease control.
 *
 * v2.4.0 promotion, Workstream C7: mirrors upstream's own
 * `gateway-session-lifecycle.ts` exactly — pure plumbing, no NanoClaw- or
 * provider-specific behavior belongs here. `GatewaySessionControl` pairs a
 * provider's lease with the `AbortSignal` that stops this host's observation
 * of it; `releaseGatewaySession` is the one place that signal gets aborted
 * and the lease's cleanup gets awaited, so a session can never be released
 * twice or have its abort and its cleanup race each other.
 */
import { log } from './log.js';
import type { GatewaySessionLease, GatewaySessionRelease } from './gateway-providers/gateway-provider-registry.js';

export interface GatewaySessionControl {
  lease: GatewaySessionLease;
  controller: AbortController;
  releasing?: Promise<void>;
  /** The event actually dispatched to `lease.release`, once a release has started. */
  releasedWith?: GatewaySessionRelease;
}

/**
 * One awaited release, including when shutdown races a terminal event. Only
 * the first caller's `event` is ever dispatched — a concurrent second caller
 * (e.g. a container's own natural termination racing this process's
 * shutdown-time detach for the same lease) gets back the same in-flight
 * promise. When the two callers disagree on `kind`, that disagreement is
 * real (one of them has the wrong picture of whether the session is ending
 * for good or surviving for a successor host) and is logged rather than
 * silently discarded, since there is no way to retract the already-dispatched
 * call to `lease.release`.
 */
export function releaseGatewaySession(control: GatewaySessionControl, event: GatewaySessionRelease): Promise<void> {
  if (!control.releasing) {
    control.releasedWith = event;
    // Queue cleanup so the promise is installed before synchronous abort listeners run.
    control.releasing = Promise.resolve().then(async () => {
      control.controller.abort(event.reason);
      await control.lease.release?.(event);
    });
  } else if (control.releasedWith?.kind !== event.kind) {
    log.warn('Gateway session release requested twice with different kinds — first dispatch wins', {
      dispatched: control.releasedWith?.kind,
      discarded: event.kind,
    });
  }
  return control.releasing;
}

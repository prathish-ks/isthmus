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
import type { GatewaySessionLease, GatewaySessionRelease } from './gateway-providers/gateway-provider-registry.js';

export interface GatewaySessionControl {
  lease: GatewaySessionLease;
  controller: AbortController;
  releasing?: Promise<void>;
}

/** One awaited release, including when shutdown races a terminal event. */
export function releaseGatewaySession(control: GatewaySessionControl, event: GatewaySessionRelease): Promise<void> {
  if (!control.releasing) {
    // Queue cleanup so the promise is installed before synchronous abort listeners run.
    control.releasing = Promise.resolve().then(async () => {
      control.controller.abort(event.reason);
      await control.lease.release?.(event);
    });
  }
  return control.releasing;
}

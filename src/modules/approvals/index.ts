/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     resolves in-memory gateway credential approvals (v2.4.0 promotion,
 *     Workstream C7: generic across whichever provider is installed, not
 *     OneCLI-specific).
 *   - A message-interceptor (via ./reason-capture.js) that captures an admin's
 *     one-line reply after they click "Reject with reason…".
 *   - An adapter-ready callback that starts the gateway approval coordinator
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops it cleanly.
 *
 * Exposes `sweepAwaitingReasonRejects` for the host sweep to finalize ghosted
 * reject-with-reason holds (re-exported here, which also loads reason-capture
 * so its interceptor registers).
 *
 * Self-mod flows (install_packages, add_mcp_server) moved out to
 * `src/modules/self-mod/` in PR #7 — they now register delivery actions
 * + approval handlers via this module's public API.
 */
import { onDeliveryAdapterReady } from '../../delivery.js';
import { startGatewayApprovalCoordinator, stopGatewayApprovalCoordinator } from '../../gateway-approval-coordinator.js';
import { onHostShutdown } from '../../host-lifecycle.js';
import { registerResponseHandler } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';
// Host-sweep hook for ghosted "Reject with reason…" holds. The re-export also
// loads reason-capture.js, registering its message-interceptor on import.
export { sweepAwaitingReasonRejects } from './reason-capture.js';

registerResponseHandler(handleApprovalsResponse);

onDeliveryAdapterReady((adapter) => {
  startGatewayApprovalCoordinator(adapter);
});

onHostShutdown(() => {
  stopGatewayApprovalCoordinator();
});

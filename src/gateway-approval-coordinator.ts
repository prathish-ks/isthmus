/**
 * Gateway approval coordinator.
 *
 * v2.4.0 promotion, Workstream C7: the one human-approval flow every gateway
 * provider gets, so the flow cannot differ by provider (`docs/gateway-seam.md`).
 * This module owns everything OneCLI's own `onecli-approvals.ts` used to own
 * directly — approver resolution, delivery, the `pending_approvals` row, the
 * card, the click, expiry, and the startup sweep — generalized so a future
 * provider (Iron Proxy, Workstream C8) reuses it instead of re-implementing
 * its own copy. A provider's `approvals.subscribe` never touches any of this:
 * it only translates its native protocol into a `GatewayApprovalRequest` and
 * hands it to `decide()` below.
 *
 * Extracted behavior-for-behavior from `onecli-approvals.ts` (short approval
 * ids for Telegram's 64-byte `callback_data` limit, the row-created-before-
 * delivery ordering, the expiry timer firing ahead of the gateway's own TTL,
 * the startup sweep) — nothing about how an approval reaches an admin or
 * expires has changed for OneCLI; only the request's origin is now generic.
 */
import {
  type GatewayApprovalDecision,
  type GatewayApprovalRequest,
  type GatewayApprovalScope,
} from './gateway-providers/gateway-provider-registry.js';
import { getGatewayProvider } from './gateway-providers/index.js';
import { pickApprovalDelivery, pickApprover } from './modules/approvals/primitive.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApprovalsByAction,
  setPendingApprovalPlatformMessageId,
  transitionPendingApprovalStatus,
} from './db/sessions.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { log } from './log.js';
import type { MessagingGroup, PendingApproval } from './types.js';

/** Only one gateway provider is ever active per install, so one action name suffices. */
export const GATEWAY_APPROVAL_ACTION = 'gateway_credential';

type Decision = 'approve' | 'deny';
type ExpiryReason = 'no response' | 'host restarted';

/**
 * A pending ceiling capped independently of what the provider asked for
 * (`docs/gateway-seam.md`'s own words) — a misconfigured or malicious
 * `expiresAt` far in the future must not leave a card, and the promise
 * blocking the provider's native request, alive indefinitely.
 */
const MAX_APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;
/** Applied when a request carries no `expiresAt` at all. */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingState {
  resolve: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingState>();
let adapterRef: ChannelDeliveryAdapter | null = null;
let controller: AbortController | null = null;

/**
 * Generate a short approval id for card buttons.
 *
 * A provider's native request id may be arbitrarily long (a UUID, 36 bytes).
 * Put into a card button's action id as `ncq:<id>:Approve`, Chat SDK's
 * Telegram adapter serializes both `id` and `value` into the Telegram
 * `callback_data` field, which has a hard 64-byte limit. Generating a
 * 10-byte id (`ga-` + 8 base36 chars) for the card, and keeping the
 * provider's own request id in the persisted payload for audit, keeps every
 * provider's requests card-safe regardless of its native id shape.
 */
function shortApprovalId(): string {
  return `ga-${Math.random().toString(36).slice(2, 10)}`;
}

/** Called from the approvals response handler when a card button is clicked. */
export async function resolveGatewayApproval(approvalId: string, selectedOption: string): Promise<boolean> {
  const state = pending.get(approvalId);
  if (!state) return false;

  const decision: Decision = selectedOption === 'approve' ? 'approve' : 'deny';
  const claimed = await transitionPendingApprovalStatus(
    approvalId,
    'pending',
    decision === 'approve' ? 'approved' : 'rejected',
  );
  if (!claimed) return false;
  pending.delete(approvalId);
  clearTimeout(state.timer);
  // Card is auto-edited to "✅ <option>" by chat-sdk-bridge's onAction handler,
  // so we don't need to deliver an edit here.
  await deletePendingApproval(approvalId);

  state.resolve(decision);
  log.info('Gateway approval resolved', { approvalId, decision });
  return true;
}

/**
 * Start the coordinator against whichever gateway provider is installed.
 * Idempotent — a second call while a subscription is already running is a
 * no-op.
 */
export function startGatewayApprovalCoordinator(deliveryAdapter: ChannelDeliveryAdapter): void {
  if (controller) return;
  adapterRef = deliveryAdapter;
  controller = new AbortController();

  // Sweep any rows left over from a previous process.
  sweepStaleApprovals().catch((err) => log.error('Gateway approval sweep failed', { err }));

  const provider = getGatewayProvider();
  const scope: GatewayApprovalScope = {
    ownsAgentGroup: async (agentGroupId) => (await getAgentGroup(agentGroupId)) !== undefined,
  };
  provider.approvals
    .subscribe(decide, controller.signal, async () => {}, scope)
    .catch((err: unknown) => {
      // Ending while the signal is still active — cleanly or by rejection —
      // is the bridge going down, not an intentional stop. Every in-flight
      // hold fails closed; there is no partial-trust state to preserve.
      if (controller?.signal.aborted) return;
      log.error('Gateway approval subscription ended unexpectedly', { gatewayProvider: provider.kind, err });
      for (const [approvalId, state] of pending) {
        clearTimeout(state.timer);
        state.resolve('deny');
        pending.delete(approvalId);
      }
    });
  log.info('Gateway approval coordinator started', { gatewayProvider: provider.kind });
}

export function stopGatewayApprovalCoordinator(): void {
  controller?.abort('host-shutdown');
  controller = null;
  for (const state of pending.values()) {
    clearTimeout(state.timer);
    // Resolve any in-flight decide() promise so its awaiting provider
    // callback returns instead of hanging forever — the provider's own
    // connection may already be gone, but the caller still needs a decision
    // to unblock.
    state.resolve('deny');
  }
  pending.clear();
  adapterRef = null;
}

/**
 * Core's own decision function, passed to `provider.approvals.subscribe`.
 * Never called directly by anything else — a provider's translation layer
 * is the only caller, and it never decides anything itself.
 */
async function decide(request: GatewayApprovalRequest): Promise<GatewayApprovalDecision> {
  if (!adapterRef) return 'unavailable';

  // '' is this codebase's existing sentinel for "no known scope" (see
  // `MountPolicy.gatewayTrustRoot`) — a request that never carried an origin
  // group falls straight to the global-admin approver path below, exactly
  // like `pickApprover(null)`'s own contract. Only a NAMED group that no
  // longer exists is an actual validation failure.
  const agentGroupId = request.agentGroupId || null;
  if (agentGroupId && !(await getAgentGroup(agentGroupId))) {
    log.warn('Gateway approval auto-denied: agent group no longer exists', { id: request.id, agentGroupId });
    return 'deny';
  }

  const approvers = request.approverUserId ? [request.approverUserId] : await pickApprover(agentGroupId);
  if (approvers.length === 0) {
    log.warn('Gateway approval auto-denied: no eligible approver', { id: request.id, host: request.destination?.host });
    return 'deny';
  }

  // A provider-supplied `delivery` carries only ids (never a full
  // MessagingGroup — that would leak core's own row shape across the seam),
  // so it's re-resolved to the same targetable shape `pickApprovalDelivery`
  // already returns.
  let resolvedTarget: { userId: string; messagingGroup: MessagingGroup } | null;
  if (request.delivery) {
    const messagingGroup = await getMessagingGroup(request.delivery.messagingGroupId);
    resolvedTarget = messagingGroup ? { userId: approvers[0], messagingGroup } : null;
  } else {
    resolvedTarget = await pickApprovalDelivery(approvers, '');
  }
  if (!resolvedTarget) {
    log.warn('Gateway approval auto-denied: no delivery destination for any approver', { id: request.id, approvers });
    return 'deny';
  }

  const approvalId = shortApprovalId();
  const kind = getGatewayProvider().kind;

  const options = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' as const },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' as const },
  ];

  // Row created BEFORE delivery: if the insert itself throws, no card has
  // gone out yet, so nothing is left live with buttons that resolve nothing.
  await createPendingApproval({
    approval_id: approvalId,
    session_id: request.sessionId ?? null,
    request_id: request.id,
    action: GATEWAY_APPROVAL_ACTION,
    payload: JSON.stringify({
      gatewayKind: kind,
      nativeRequestId: request.id,
      approver: resolvedTarget.userId,
      ...(request.audit ?? {}),
    }),
    created_at: request.createdAt,
    agent_group_id: agentGroupId,
    channel_type: resolvedTarget.messagingGroup.channel_type,
    platform_id: resolvedTarget.messagingGroup.platform_id,
    instance: resolvedTarget.messagingGroup.instance ?? null,
    platform_message_id: null,
    expires_at: request.expiresAt ?? null,
    status: 'pending',
    title: request.title,
    question: request.question,
    options_json: JSON.stringify(options),
  });

  let platformMessageId: string | undefined;
  try {
    platformMessageId = await adapterRef.deliver(
      resolvedTarget.messagingGroup.channel_type,
      resolvedTarget.messagingGroup.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title: request.title,
        question: request.question,
        options,
      }),
      undefined,
      // ensureUserDm may resolve the DM through a named instance; dispatch
      // here is exact-key, so the card must be addressed to the instance
      // that owns the conversation or it cannot be posted at all.
      resolvedTarget.messagingGroup.instance,
    );
  } catch (err) {
    log.error('Failed to deliver gateway approval card', { approvalId, id: request.id, err });
    await deletePendingApproval(approvalId);
    return 'deny';
  }

  if (platformMessageId) {
    await setPendingApprovalPlatformMessageId(approvalId, platformMessageId);
  }

  // Expiry timer fires just before the provider's own TTL so our decision
  // lands in time to be recorded, capped independently of what the provider
  // asked for.
  const requestedMs = request.expiresAt
    ? new Date(request.expiresAt).getTime() - Date.now() - 1000
    : DEFAULT_APPROVAL_TIMEOUT_MS;
  const timeoutMs = Math.max(1000, Math.min(requestedMs, MAX_APPROVAL_TIMEOUT_MS));

  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      if (!pending.has(approvalId)) return;
      pending.delete(approvalId);
      expireApproval(approvalId, 'no response').catch((err) =>
        log.error('Failed to mark gateway approval expired', { approvalId, err }),
      );
      resolve('deny');
    }, timeoutMs);

    pending.set(approvalId, { resolve, timer });
  });
}

async function expireApproval(approvalId: string, reason: ExpiryReason): Promise<void> {
  const rows = (await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)).filter(
    (r) => r.approval_id === approvalId,
  );
  const row = rows[0];
  if (!row) return;

  if (!(await transitionPendingApprovalStatus(approvalId, 'pending', 'expired'))) return;
  await editCardExpired(row, reason);
  await deletePendingApproval(approvalId);
  log.info('Gateway approval expired', { approvalId, reason });
}

/** Exported for tests — the sweep and the expiry timer are its only callers. */
export async function editCardExpired(row: PendingApproval, reason: ExpiryReason): Promise<void> {
  if (!adapterRef || !row.platform_message_id || !row.channel_type || !row.platform_id) return;
  const resolution =
    reason === 'no response' ? '⏱️ Timed out — no response' : '⏱️ Timed out — host restarted before resolution';
  try {
    await adapterRef.deliver(
      row.channel_type,
      row.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        operation: 'edit',
        messageId: row.platform_message_id,
        text: [row.title, row.question, resolution].filter(Boolean).join('\n\n'),
        terminalCard: {
          title: row.title,
          question: row.question,
          resolution,
        },
      }),
      undefined,
      row.instance ?? row.channel_type,
    );
  } catch (err) {
    log.error('Failed to edit expired gateway approval card', { approvalId: row.approval_id, err });
  }
}

async function sweepStaleApprovals(): Promise<void> {
  const rows = await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION);
  if (rows.length === 0) return;
  log.info('Sweeping stale gateway approvals from previous process', { count: rows.length });
  for (const row of rows) {
    await editCardExpired(row, 'host restarted');
    await deletePendingApproval(row.approval_id);
  }
}

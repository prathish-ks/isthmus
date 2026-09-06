/**
 * The guard-consult path for privileged delivery actions.
 *
 * The registry itself — registration, lookup, approved-replay re-entry —
 * stays in delivery.ts, close to main's shape. This file holds the new
 * guard logic: the spec a privileged registration carries, and runGuarded,
 * the precheck → guard → deny/hold/allow pipeline every consult runs.
 */
import { guard, type GuardedAction } from './guard/index.js';
import { log } from './log.js';
import type { PendingApproval, Session } from './types.js';

/**
 * Handler shape for guard-wrapped actions — must not touch inDb (replays run
 * without one).
 *
 * The optional third parameter (EC-02, Phase 9) is the approval that
 * satisfied this action's hold — `runGuarded`'s own `grant`, passed straight
 * through. Non-null exactly when this run IS an approved replay (a fresh
 * dispatch passes `grant=null`); a handler that never needs it (today:
 * `applyAddMcpServer`, which never rebuilds an image) can ignore the
 * parameter entirely — TypeScript's rule that a function accepting fewer
 * parameters satisfies a type expecting more keeps its existing two-param
 * signature valid here with no change.
 */
export type GuardedDeliveryHandler = (
  content: Record<string, unknown>,
  session: Session,
  approval: PendingApproval | null,
) => Promise<void>;

export interface DeliveryGuardSpec {
  /** Guard action consulted before the handler runs — the defined value, not a name. */
  guardAction: GuardedAction;
  /**
   * Domain validation that runs before the guard — malformed requests are
   * answered (notify) without ever creating a hold. Return false to stop.
   */
  precheck?: (content: Record<string, unknown>, session: Session) => boolean | Promise<boolean>;
  /** Create the hold (the domain's requestApproval call — card text lives with the domain). */
  requestHold: (content: Record<string, unknown>, session: Session) => Promise<void>;
  /** Tell the requester about a deny. */
  onDeny?: (content: Record<string, unknown>, session: Session, reason: string) => void | Promise<void>;
}

/**
 * Run a guarded delivery action: precheck, consult the guard, then route the
 * decision — deny → onDeny, hold → requestHold, allow → handler. A fresh
 * dispatch passes grant=null; an approved replay passes the approval row,
 * which satisfies a hold but never a deny (the structural checks re-run
 * live, so approve-then-revoke does not execute).
 */
export async function runGuarded(
  action: string,
  spec: DeliveryGuardSpec,
  handler: GuardedDeliveryHandler,
  content: Record<string, unknown>,
  session: Session,
  grant: PendingApproval | null,
): Promise<void> {
  if (spec.precheck && !(await spec.precheck(content, session))) return;

  const decision = await guard(spec.guardAction, {
    actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
    payload: content,
    grant,
  });

  if (decision.effect === 'deny') {
    log.warn('Delivery action denied by guard', { action, reason: decision.reason });
    await spec.onDeny?.(content, session, decision.reason);
    return;
  }
  if (decision.effect === 'hold') {
    await spec.requestHold(content, session);
    return;
  }
  await handler(content, session, grant);
}

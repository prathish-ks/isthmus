/**
 * Normalization helpers for ParityResult construction.
 *
 * Implements the "Normalization rules" table in docs/parity-schema.md:
 * generated ids get stable, first-seen-order placeholders (so the SAME
 * underlying id normalizes to the SAME placeholder everywhere it appears in
 * one ParityResult); timestamps collapse to a presence marker; container
 * names drop their Date.now() suffix; mount hostPaths are stripped entirely.
 */

export const TIMESTAMP_PRESENT = '<TIMESTAMP>';

/**
 * Assigns stable placeholders to raw ids in first-seen order, scoped by a
 * caller-chosen kind (e.g. 'SESSION', 'MSG', 'MG'). One instance is meant to
 * live for the lifetime of a single fixture's ParityResult construction —
 * create a fresh one per `it()` block, never share across fixtures.
 */
export class IdNormalizer {
  private readonly seen = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  normalize(kind: string, raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const cached = this.seen.get(raw);
    if (cached) return cached;
    const next = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, next);
    const placeholder = `${kind}_${next}`;
    this.seen.set(raw, placeholder);
    return placeholder;
  }
}

/** created_at / last_active / granted_at / etc. — presence, never literal value. */
export function normalizeTimestamp(value: string | null | undefined): string | null {
  return value ? TIMESTAMP_PRESENT : null;
}

/** Strips the `-<Date.now()>` suffix container-runner.ts appends to container names. */
export function normalizeContainerName(name: string): string {
  return name.replace(/-\d{10,}$/, '');
}

export interface NormalizableMount {
  class: string;
  hostPath: string;
  containerPath: string;
  mode: 'rw' | 'ro';
  groupScope: string;
}

/** hostPath is environment-specific by design (see docs/parity-schema.md) — never compared. */
export function normalizeMount(mount: NormalizableMount): Omit<NormalizableMount, 'hostPath'> {
  const { class: cls, containerPath, mode, groupScope } = mount;
  return { class: cls, containerPath, mode, groupScope };
}

/**
 * `GuardDecision.reason` is a human-readable sentence, not a stable enum —
 * see docs/parity-schema.md's "GuardDecision.reason free text" normalization
 * rule. This lookup table is the "explicit lookup table maintained alongside
 * the fixtures" that rule calls for: each known reason (grounded in the
 * `decide` functions that produce it) maps to a stable category. An
 * unmapped reason throws rather than silently comparing free text, so a
 * wording change that carries no behavioral meaning doesn't silently pass
 * while a real new category goes uncategorized.
 *
 * Extended at P2-04 from the original 4 (senders.admit only) to cover every
 * guarded action in the catalog exercised by
 * src/differential/fixtures-guard-catalog.test.ts: channels.register,
 * agents.create, a2a.send, self_mod.install_packages/add_mcp_server, the
 * CLI-derived restart-style guard (src/cli/guard.ts's commandDecide), and
 * guard.ts's own two generic outcomes that apply to every action with a
 * grantActionName (a satisfied hold, an invalid/mismatched replay) plus its
 * two fail-closed backstops (malformed action, throwing decide).
 */
export type NormalizedGuardReasonCategory =
  // senders.admit (src/modules/permissions/guard.ts)
  | 'unknown-sender-public-allowed'
  | 'unknown-sender-request-approval-hold'
  | 'unknown-sender-decline-notify-denied'
  | 'unknown-sender-strict-denied'
  // channels.register (src/modules/permissions/guard.ts) — the decide fn
  // returns the SAME 'delivered approver or anchor-group admin' ALLOW
  // string for both the delivered-approver and anchor-group-admin branches
  // (see the fixture's comment on this), so there is only one allowed
  // category here, not two.
  | 'channels-register-non-human-denied'
  | 'channels-register-no-pending-denied'
  | 'channels-register-allowed'
  | 'channels-register-ineligible-denied'
  // agents.create (src/modules/agent-to-agent/guard.ts)
  | 'agents-create-non-agent-denied'
  | 'agents-create-global-scope-allowed'
  | 'agents-create-group-scope-hold'
  // a2a.send (src/modules/agent-to-agent/guard.ts)
  | 'a2a-send-non-agent-denied'
  | 'a2a-send-no-destination-denied'
  | 'a2a-send-target-not-found-denied'
  | 'a2a-send-self-send-allowed'
  | 'a2a-send-policy-hold'
  | 'a2a-send-no-policy-allowed'
  // self_mod.install_packages / self_mod.add_mcp_server (src/modules/self-mod/guard.ts)
  | 'self-mod-non-agent-denied'
  | 'self-mod-image-build-unavailable-denied'
  | 'self-mod-admin-approval-hold'
  // CLI-derived restart-style guard (src/cli/guard.ts's commandDecide)
  | 'cli-host-caller-allowed'
  | 'cli-non-host-non-agent-denied'
  | 'cli-host-only-command-denied'
  | 'cli-scope-disabled-denied'
  | 'cli-scope-resource-not-allowlisted-denied'
  | 'cli-scope-cross-group-denied'
  | 'cli-scope-wiring-update-args-denied'
  | 'cli-scope-mutation-denied'
  | 'cli-approval-required-hold'
  | 'cli-open-command-allowed'
  // guard.ts's own generic grant outcomes — apply to any action with a grantActionName
  | 'grant-satisfied-hold-allowed'
  | 'grant-invalid-or-mismatched-denied'
  // guard.ts's fail-closed backstops (src/guard/guard.ts)
  | 'guard-malformed-action-denied'
  | 'guard-throwing-decide-denied';

const GUARD_REASON_CATEGORIES: Array<{ category: NormalizedGuardReasonCategory; test: (reason: string) => boolean }> = [
  // senders.admit
  { category: 'unknown-sender-public-allowed', test: (r) => r === 'public messaging group' },
  {
    category: 'unknown-sender-request-approval-hold',
    test: (r) => r.startsWith('unknown sender requires admin approval on messaging group'),
  },
  { category: 'unknown-sender-decline-notify-denied', test: (r) => r.startsWith('unknown sender declined') },
  { category: 'unknown-sender-strict-denied', test: (r) => r === 'unknown sender on a strict messaging group' },
  // channels.register — order matters: the non-human check's exact string
  // must be tried before the more generic ineligible-approver string below.
  {
    category: 'channels-register-non-human-denied',
    test: (r) => r === 'channel registration resolves via human clicks/replies',
  },
  { category: 'channels-register-no-pending-denied', test: (r) => r.startsWith('no pending channel registration for') },
  // Both the delivered-approver and anchor-group-admin branches return this
  // exact same string — see the type union comment above and the fixture's
  // own note on this. One category, deliberately, not an oversight.
  { category: 'channels-register-allowed', test: (r) => r === 'delivered approver or anchor-group admin' },
  {
    category: 'channels-register-ineligible-denied',
    test: (r) => r === 'not an eligible channel-registration approver',
  },
  // agents.create — exact strings, so they never collide with self-mod's
  // near-identical "is a container-originated action." suffix below.
  { category: 'agents-create-non-agent-denied', test: (r) => r === 'create_agent is a container-originated action.' },
  { category: 'agents-create-global-scope-allowed', test: (r) => r === 'trusted global-scope agent group' },
  {
    category: 'agents-create-group-scope-hold',
    test: (r) => r === 'agent-initiated create_agent requires admin approval',
  },
  // a2a.send
  {
    category: 'a2a-send-non-agent-denied',
    test: (r) => r === 'agent-to-agent send requires an agent actor',
  },
  { category: 'a2a-send-no-destination-denied', test: (r) => r.startsWith('unauthorized agent-to-agent:') },
  {
    category: 'a2a-send-target-not-found-denied',
    test: (r) => r.startsWith('target agent group') && r.includes('not found for message'),
  },
  { category: 'a2a-send-self-send-allowed', test: (r) => r === 'self-send' },
  { category: 'a2a-send-policy-hold', test: (r) => r.includes('a2a message policy') && r.includes('holds for') },
  { category: 'a2a-send-no-policy-allowed', test: (r) => r === 'destination grant exists' },
  // self_mod.install_packages / self_mod.add_mcp_server — both actions share
  // selfModDecide's templated wording, so one category covers both labels.
  {
    category: 'self-mod-non-agent-denied',
    test: (r) =>
      r === 'install_packages is a container-originated action.' ||
      r === 'add_mcp_server is a container-originated action.',
  },
  {
    category: 'self-mod-image-build-unavailable-denied',
    test: (r) => r.includes("'imageBuild'") && r.includes('cannot be installed on this runtime'),
  },
  {
    category: 'self-mod-admin-approval-hold',
    test: (r) => r.endsWith('always requires admin approval from the container path'),
  },
  // CLI-derived restart-style guard (commandDecide) — command-name-agnostic
  // matchers, since these strings interpolate the specific cmd.name/resource.
  { category: 'cli-host-caller-allowed', test: (r) => r === 'host caller (trusted socket)' },
  { category: 'cli-non-host-non-agent-denied', test: (r) => r === 'CLI commands accept host or agent callers only.' },
  {
    category: 'cli-host-only-command-denied',
    test: (r) => r.includes('is operator-only and cannot be run from inside a container.'),
  },
  { category: 'cli-scope-disabled-denied', test: (r) => r === 'CLI access is disabled for this agent group.' },
  {
    category: 'cli-scope-resource-not-allowlisted-denied',
    test: (r) => r.startsWith('CLI access is scoped to this agent group. Cannot access'),
  },
  { category: 'cli-scope-cross-group-denied', test: (r) => r === 'CLI access is scoped to this agent group.' },
  {
    category: 'cli-scope-wiring-update-args-denied',
    test: (r) => r === 'Group-scoped wiring updates may only change engage_mode or engage_pattern.',
  },
  {
    category: 'cli-scope-mutation-denied',
    test: (r) => r === 'Cannot change cli_scope from a group-scoped agent.',
  },
  // Must be tried before agents-create-group-scope-hold's unquoted variant —
  // the CLI version always quotes the command name, agents.create never does.
  { category: 'cli-approval-required-hold', test: (r) => r.startsWith('agent-initiated "') },
  { category: 'cli-open-command-allowed', test: (r) => r === 'open command' },
  // guard.ts's own generic outcomes (src/guard/guard.ts) — apply to ANY
  // action defined with a grantActionName, not specific to one action.
  { category: 'grant-satisfied-hold-allowed', test: (r) => r.startsWith('hold satisfied by approval ') },
  {
    category: 'grant-invalid-or-mismatched-denied',
    test: (r) => r === 'replay carried an invalid or mismatched grant',
  },
  {
    category: 'guard-malformed-action-denied',
    test: (r) => r === 'guard consulted with an undefined action (failing closed)',
  },
  { category: 'guard-throwing-decide-denied', test: (r) => r === 'guard failure (failing closed)' },
];

export function normalizeGuardReason(reason: string): NormalizedGuardReasonCategory {
  const match = GUARD_REASON_CATEGORIES.find((entry) => entry.test(reason));
  if (!match) {
    throw new Error(
      `normalizeGuardReason: unmapped guard reason "${reason}" — add a category to GUARD_REASON_CATEGORIES ` +
        'in src/differential/normalize.ts (see docs/parity-schema.md\'s "GuardDecision.reason free text" rule) ' +
        "before trusting this fixture's snapshot.",
    );
  }
  return match.category;
}

# Normalized Parity Output Schema (P2-02)

Recorded: 2026-08-31, against the pinned baseline (`go-host-experiment` branch, NanoClaw v2.3.0, commit `54d9d9a50c0e572fa3969d63ab87a4dd3d75cc6f`).

Prerequisite: P2-01 (`docs/test-inventory.md`). This document specifies *what* a differential test compares between the TypeScript host and a future Go host — a normalized result structure — not the fixture harness itself (that's P2-03).

## Design principle: compare observable contracts, not implementation internals

A differential test that asserts on internal call sequences or object shapes private to the TypeScript implementation would fail the moment the Go port organizes its internals differently, even when the two hosts behave identically from the outside — that's noise, not signal. Everything in this schema is deliberately restricted to what a caller outside the host process can observe: what got written to the shared SQLite mailbox files, what the driver seam was asked to realize, what reached (or didn't reach) the channel adapter. This mirrors the same seam `docs/host-decomposition.md` and `docs/compatibility-contract.md` already draw around the host/container boundary, applied here to the differential-testing boundary instead. It's also the same reasoning behind `docs/design-laws.md`'s LAW-07/OBJ-04 annotation: a port only counts as equivalent if its *externally enforced effect* matches, not its internal decision path.

Six comparison axes are named in the workbook (P2-02): routing decision, session semantics, DB rows/state, container wake intent, delivery target, and error category. Each is grounded below against the actual TypeScript source that produces it today, so the schema fields aren't invented — they're read off real function contracts.

## The six axes, grounded in code

### 1. Routing decision — `src/router.ts`

`routeInbound` doesn't return a value (`Promise<void>`) — its decision is observable only through side effects: which agents received the message, with what disposition, and why. Reading `deliverToAgent`'s call sites and the two `recordDroppedMessage` calls in `routeInbound` gives the exact vocabulary:

- Per-wired-agent disposition: `'engaged'` (accessOk && scopeOk && engages — writes the message with `trigger: true`, wakes the container), `'accumulated'` (engagement didn't fire but `ignored_message_policy='accumulate'` — writes with `trigger: false`, no wake), or `'dropped'` (drop policy, or engaged-but-refused-by-gate).
- Message-level outcome when zero agents engaged or accumulated: an `unregistered_senders` row (via `recordDroppedMessage` — see the corrected table name in axis 3 below) with `reason` ∈ `{'no_agent_wired', 'no_agent_engaged'}` (the two literal reason strings in `router.ts`; the permissions module contributes its own reasons — `unknown_sender_<policy>` — via the same `recordDroppedMessage` call in `src/modules/permissions/index.ts`). **Correction from P2-03**: because `recordDroppedMessage` upserts keyed by `(channel_type, platform_id)` rather than inserting one row per drop, a message that is both gated by the permissions module AND ends up with zero engaged/accumulated agents triggers *two* `recordDroppedMessage` calls against the *same* key — router.ts's own end-of-loop call runs after the permissions module's, so its `reason` (`no_agent_engaged`) is what survives, not the module's `unknown_sender_<policy>` reason. The P2-03 "unknown-sender" fixture (`src/differential/fixtures-unknown-sender.test.ts`) exists specifically to characterize this rather than assume it — a full harness should enumerate every `recordDroppedMessage` call site before treating this axis as complete.
- The resolved `engage_mode` evaluation itself: which of `'pattern' | 'mention' | 'mention-sticky'` fired and why (`evaluateEngage`'s return is a bare boolean today — the harness needs to capture the *reason* alongside it by instrumenting or replaying the same inputs, since the function itself doesn't expose one).
- The resolved delivery address (`deliveryAddr`): `{channelType, platformId, threadId}`, and whether it came from `event.replyTo` or was derived from the inbound event.
- Whether a channel-registration escalation fired (`channelRequestGate` invoked) when a mention lands on a completely unwired, non-denied messaging group.

### 2. Session semantics — `src/session-manager.ts`

`resolveSession` is the ground truth: `Promise<{ session: Session; created: boolean }>`. The normalized comparison is exactly this pair, plus:

- Which `sessionMode` (`'shared' | 'per-thread' | 'agent-shared'`) resolution path was taken, and the `sessionCreationKey` it produced (structurally, not the literal string — see normalization rules below).
- The unique-violation race path: whether a `createSession` call raced another and fell back to `findSessionForAgent`/`findSessionByAgentGroup` (observable as `created: false` on what looked like a fresh key).
- Container-status transitions on the `sessions` row: `'stopped' → 'running'` (`markContainerRunning`), `'running' → 'idle'` (`markContainerIdle`), `'* → 'stopped'` (`markContainerStopped`) — these three functions are the complete vocabulary; there is no fourth transition function.
- `last_active` gets touched on every `writeSessionMessage` and `markContainerRunning` call — comparable structurally (touched/not-touched) but never by literal value (see timestamp normalization below).

### 3. DB rows/state — `src/db/schema.ts`

The schema itself (reproduced in full in `docs/compatibility-contract.md`'s Part A, and not repeated here) is the row shape ground truth. For parity purposes, the relevant tables per scenario are a subset, not the whole schema — a differential test snapshots only the tables the scenario actually touches:

| Table | Touched by |
|---|---|
| `sessions` | every routing/wake scenario |
| `messaging_groups` | new-messaging-group auto-create scenarios |
| `messaging_group_agents` | wiring-dependent engage/accumulate/drop scenarios |
| `users` / `user_roles` | sender-resolution and permission-gated scenarios |
| `pending_sender_approvals` | unknown-sender `request_approval` scenarios |
| `unregistered_senders` | any scenario where a message is dropped (structurally, or by the permissions module's unknown-sender gate) — **corrected from an earlier draft of this table, which named a nonexistent `dropped_messages` table.** The real table (`src/db/dropped-messages.ts`) is an aggregated per-`(channel_type, platform_id)` upsert-counter (`message_count`, `first_seen`, `last_seen`), not a per-message drop log — see the P2-03 correction under axis 1 above for the behavioral consequence of that upsert semantics. |
| `pending_questions` | interactive-question scenarios (Phase 2's later expansion, not the first 10 fixtures) |

A snapshot is the full row set for the touched tables, normalized (below), compared as an unordered set keyed by primary key — column order and row insertion order are implementation details, not contract.

### 4. Container wake intent — `src/container-runner.ts` + `src/drivers/types.ts`

This axis has two layers, and the schema keeps them separate because they're genuinely different questions:

**Composition** (does the host decide to build the same container?): `composeSessionSpec` produces a `SessionSpec` — the driver-agnostic, already-designed seam type (`src/drivers/types.ts`). Its fields are the natural normalized representation: `containers[].image`, `containers[].env`/`contributedEnv`, `containers[].mounts[]` (each `{class, hostPath, containerPath, mode, groupScope}`), `network`, `hardening`, `resources`, `runtimeTier`, `stopGraceSeconds`. This is not a schema this document invents — it's the exact type the codebase already uses as the host/driver contract, which makes it the correct comparison point: a Go port that composes an equivalent `SessionSpec` has proven composition parity regardless of what driver eventually realizes it.

**Realization** (does the driver call the runtime the same way?): the `Cli` interface's `FakeCli` (`src/drivers/fake-cli.ts`) already exists as exactly the seam a differential test needs — it records every `run()`/`start()` argv call instead of executing them. `FakeCli.joined()` gives the literal `docker ...` argv strings. The composition layer above should be preferred as the primary comparison (it's driver-independent and already normalized), with the realization layer as a secondary check that a driver correctly translates a given `SessionSpec` into runtime calls — useful for validating the Go port's own driver implementation, not for comparing TS-vs-Go composition logic.

**Outcome**: `wakeContainer(session): Promise<boolean>` — by contract, never throws; `true` on successful spawn, `false` on transient failure (host-sweep retries). `killContainer(sessionId, reason, onExit?): void` — fire-and-forget; its effect is observed via the session's container-status transition and, for the realization layer, the argv passed to the driver's stop path. `buildAgentGroupImage(agentGroupId): Promise<void>` — succeeds or throws; a differential test compares success/failure, not the image build log.

### 5. Delivery target and error category — `src/delivery.ts`

`deliverMessage` resolves to a `platformMsgId: string | null` on success or throws on failure — there's no richer built-in taxonomy in TypeScript today (a plain `catch (err)` around the whole delivery attempt). The normalized schema below introduces a small taxonomy the harness needs (since TypeScript's own code doesn't expose one to reuse), grounded in the actual retry logic:

- `outcome`: `'delivered'` (platformMsgId captured, `markDelivered` called, fan-out + post-delivery hooks ran) | `'retryable-failure'` (attempt count `< MAX_DELIVERY_ATTEMPTS` = 3, will retry) | `'permanent-failure'` (attempt count reached 3, `markDeliveryFailed` called).
- `target`: the resolved `{channelType, platformId, threadId}` the message was delivered to — same shape as the routing axis's `deliveryAddr`, deliberately reused rather than redefined.
- For container-spawn failures specifically (a different failure surface from message delivery), reuse the existing `SessionFailure` taxonomy from `src/drivers/types.ts` verbatim rather than inventing a parallel one: `'spec-invalid' | 'denied-by-policy' | 'image-unavailable' | 'runtime-unavailable' | 'resources-exhausted' | 'started-then-died' | 'unknown'`, each carrying its own `retryable: boolean`. This is already a well-designed, driver-agnostic error vocabulary — the harness should treat it as authoritative for that surface.
- For guard-gated actions, reuse `GuardDecision` from `src/guard/types.ts` verbatim: `{effect: 'allow'|'hold'|'deny', reason: string, approverUserId?: string}`. **Expanded at P2-04**: `src/differential/fixtures-guard-catalog.test.ts` exercises every action in the guarded-action catalog directly through `guard()` — `senders.admit`, `channels.register`, `agents.create`, `a2a.send`, `self_mod.install_packages`, `self_mod.add_mcp_server`, the CLI-derived restart-style guard (`src/cli/guard.ts`'s `commandDecide`), and `guard()`'s own two action-agnostic behaviors (a satisfied/mismatched grant replay, and its two fail-closed backstops against a malformed action value or a throwing `decide` fn). **A genuine finding from that work**: `channels.register`'s `decide` fn returns the *identical* ALLOW reason string (`'delivered approver or anchor-group admin'`) for two structurally different conditions — the delivered approver clicking, and a separate anchor-group admin clicking — so `normalizeGuardReason` collapses them into one category (`channels-register-allowed`) rather than inventing a distinction the source text doesn't make. This is the same class of finding as axis 1's `unregistered_senders` upsert-collision above: characterized empirically from the real `decide` fn, not assumed from its name.

## The normalized `ParityResult` schema

```ts
interface ParityResult {
  /** Which fixture scenario produced this result (P2-03's fixture id). */
  scenario: string;

  routing?: {
    dispositions: Array<{
      agentGroupId: NormalizedId;
      outcome: 'engaged' | 'accumulated' | 'dropped';
      engageMode: 'pattern' | 'mention' | 'mention-sticky';
      accessOk: boolean;
      scopeOk: boolean;
    }>;
    messageOutcome: 'routed' | 'dropped';
    dropReason?: 'no_agent_wired' | 'no_agent_engaged' | string; // permissions-module reasons TBD, see axis 1
    deliveryAddr?: { channelType: string; platformId: string; threadId: string | null };
    channelRegistrationEscalated: boolean;
  };

  session?: {
    sessionId: NormalizedId;
    created: boolean;
    sessionMode: 'shared' | 'per-thread' | 'agent-shared';
    containerStatus: 'stopped' | 'running' | 'idle';
    lastActiveTouched: boolean;
  };

  dbState?: {
    // one entry per table touched by the scenario (see axis 3's table list)
    tables: Record<string, NormalizedRow[]>;
  };

  containerWake?: {
    attempted: boolean;
    outcome: boolean | null; // wakeContainer's return; null when not attempted
    spec?: {
      image: string;
      env: Record<string, string>;
      mounts: Array<{ class: string; containerPath: string; mode: 'rw' | 'ro'; groupScope: string }>; // hostPath normalized out, see below
      network: 'shared-private' | 'none';
      resources: { memoryMb?: number; cpus?: string; pidsLimit?: number; shmSizeMb?: number };
    };
    failure?: {
      kind: 'spec-invalid' | 'denied-by-policy' | 'image-unavailable' | 'runtime-unavailable' | 'resources-exhausted' | 'started-then-died' | 'unknown';
      retryable: boolean;
    };
  };

  delivery?: {
    outcome: 'delivered' | 'retryable-failure' | 'permanent-failure';
    target: { channelType: string; platformId: string; threadId: string | null };
    attempts: number;
  };

  guard?: {
    effect: 'allow' | 'hold' | 'deny';
    reasonCategory: NormalizedReason; // free-text `reason` normalized to a stable category, see below
  };
}

type NormalizedId = string;   // see ID normalization below
type NormalizedRow = Record<string, unknown>;
type NormalizedReason = string;
```

A fixture only populates the axes it actually exercises — a plain routing-only scenario has no `containerWake` or `delivery` key at all, rather than a null-filled shape. This keeps P2-03's first 10 fixtures (several of which are pure routing/session scenarios) from having to fabricate values for axes they don't touch. The P2-04 guard-catalog fixtures go further in the same direction — most populate `guard` alone, with no `routing`/`session`/`dbState` at all, since `guard()` is consulted directly rather than through a full router/session round trip.

## Normalization rules

This is the part the workbook specifically calls out ("normalize timestamps/random IDs") and the part that determines whether the schema is actually useful — an unnormalized comparison would fail on every run even between two invocations of the *same* TypeScript host, since IDs and timestamps are freshly generated every time.

| Source of nondeterminism | Where it comes from | Normalization rule |
|---|---|---|
| Session IDs | `session-manager.ts`'s `generateId()`: `` `sess-${Date.now()}-${Math.random().toString(36).slice(2,8)}` `` | Replace with a stable placeholder assigned in first-seen order within one `ParityResult` (`SESSION_1`, `SESSION_2`, ...) — not blanked out, because a test needs to confirm the *same* id reappears across `routing.dispositions[].sessionId` and `dbState.tables.sessions[].id`. |
| Message IDs | `router.ts`'s `generateId()` (`` `msg-${Date.now()}-${Math.random()...}` ``) and `messageIdForAgent`'s `:agentGroupId` suffix | Same first-seen-order placeholder scheme (`MSG_1`, `MSG_2`, ...), scoped per `ParityResult`. |
| Messaging-group IDs | `router.ts`'s inline `` `mg-${Date.now()}-...}` `` | Same scheme (`MG_1`, ...). |
| Container names | `container-runner.ts`: `` `nanoclaw-v2-${agentGroup.folder}-${Date.now()}` `` | The `agentGroup.folder` segment is meaningful (fixture-controlled) and stays; the `Date.now()` suffix is stripped entirely rather than placeholder-substituted, since no test needs to confirm two container names match — only that the folder segment is correct. |
| All `created_at` / `last_active` / `granted_at` / any ISO-8601 column | Every table in `db/schema.ts` | Replace with a boolean presence check (`<TIMESTAMP>` placeholder) by default. A scenario that specifically tests time-ordering (e.g. "session's `last_active` advances after a second message") compares *relative* order (`before < after`) using the real captured values internally, never the literal string, and reports only the boolean comparison outcome in the normalized result. |
| Host filesystem paths (`hostPath` on any `MountSpec`) | `buildMounts` in `container-runner.ts`, resolved against `DATA_DIR`/`GROUPS_DIR`, which differ per machine/checkout | Strip `hostPath` from the normalized `containerWake.spec.mounts[]` entries entirely (see the schema above — only `containerPath`/`mode`/`class`/`groupScope` survive). `groupScope` and `containerPath` are checkout-independent and carry the actual contract; `hostPath` is environment-specific by design. |
| `GuardDecision.reason` free text | `src/guard/*.ts` decide functions | These are human-readable sentences, not a stable enum, and will drift with wording edits that carry no behavioral meaning. The harness maps each known reason string to a stable category label (`NormalizedReason`) via an explicit lookup table maintained alongside the fixtures — new unmapped reasons fail the harness loudly (forcing the table to be updated) rather than silently comparing free text. **Extended at P2-04** (`src/differential/normalize.ts`'s `GUARD_REASON_CATEGORIES`) from 4 categories (senders.admit only) to 32, covering every guarded action in the catalog — see axis 5 above for the one genuine ambiguity that extension surfaced. |

## What this deliberately does not cover yet

Two things the workbook's later Phase 2 tasks handle, not this one: the actual fixture scenarios that produce these `ParityResult` values (P2-03: the first 10; P2-04: expansion to 30-50) and the one-command runner that executes them against the baseline (P2-05). This document is the contract those tasks build against — get the shape and normalization rules agreed here, and P2-03's fixtures become "run scenario X, capture a `ParityResult`, assert it equals the recorded golden value" rather than each fixture reinventing its own comparison logic.

One open design question, flagged rather than resolved: when Phase 3 eventually runs a real differential test (TypeScript host vs. Go host, same fixture, same inputs), *something* has to capture two `ParityResult` values and diff them. That's a harness-side concern, not a schema concern. It's worth noting here, though, that the schema above is written to be equally producible by instrumenting the TypeScript host directly (test-only hooks) or by black-box observation (reading the mailbox DBs and driver calls from outside the process) — the latter is preferable once Go exists, since it's the only method that doesn't require symmetric instrumentation hooks in both languages.

## Next step

P2-03 implemented the first 10 baseline fixtures (new session, existing session, mention, non-mention, unknown sender, message persistence, duplicate input, running container, stopped container, outbound delivery) against the existing TypeScript host — done and confirmed stable across two consecutive runs. P2-04 (`src/differential/fixtures-guard-catalog.test.ts`) added 43 more, covering the guard axis's full catalog — pending the same repeated-run stability confirmation before P2-05 (a one-command baseline verification script) closes out Phase 2.

# P4-06 Differential Parity Report

**Task:** P4-06 (reach differential parity milestone), Milestone C — Value Preservation
**Date:** 2026-09-02
**Result:** 20/20 in-scope fixtures pass. 0 unapproved divergences. 3 previously-known divergences formalized as ADR entries (see ADR-002). 2 golden-value fields excluded with cited justification (see below).

## Comparison mechanism

There is no live dual-execution of the TS and Go hosts in this project's development environment. Instead, the TypeScript side of every comparison below is the already-frozen, `pnpm run verify:baseline`-approved Vitest snapshot committed at `src/differential/__snapshots__/*.snap`. The Go side is a new test package, `go-host/internal/parity`, containing one test per fixture that reconstructs the fixture's exact inputs and asserts the already-ported Go decision functions (P4-01 through P4-05) against the literal golden value extracted from the corresponding snapshot export.

## Scope: 20 of 65 fixtures

| Category | Count | In scope? | Why |
|---|---|---|---|
| `fixtures.test.ts` (P2-03 core) | 8 | Yes | Session + routing decision logic, all ported (P4-01/P4-02) |
| `fixtures-batch2.test.ts` (P2-04 batch 2) | 9 | Yes | Session-mode + routing + container-wake decision logic, all ported |
| `fixtures-outbound-delivery.test.ts` (P2-03 + P2-04) | 3 | Yes | Delivery decision logic, ported (P4-04/P4-05) |
| `fixtures-guard-catalog.test.ts` | 43 | No | Exercises `guard.ts` — Phase 5 (Security Kernel) scope, not yet ported |
| `fixtures-unknown-sender.test.ts` + `fixtures-channel-registration.test.ts` | 2 | No, permanently | Exercise the permissions module, classified KEEP TYPESCRIPT FOREVER by P1-01's `docs/host-decomposition.md` — no future task ports this |

This task's own prompt guidance ("produce a parity report grouped by sessions/routing/mailbox/runtime/delivery") names five axes and conspicuously omits "guard" — read as confirmation the guard axis is intentionally deferred to Phase 5, not an oversight.

## Results by axis

### Routing (7 fixtures)

All assert `routing.EvaluateEngage` + `routing.DecideWiringOutcome` + `routing.NoAgentEngaged` + `routing.DecideUnwiredChannel` against the golden disposition/outcome/dropReason fields.

| Fixture | Snapshot export | Go test | Result |
|---|---|---|---|
| mention | `fixtures.test.ts.snap` | `TestParity_Mention` | PASS |
| non-mention | `fixtures.test.ts.snap` | `TestParity_NonMention` | PASS |
| message-persistence | `fixtures.test.ts.snap` | `TestParity_MessagePersistence` | PASS |
| mention-sticky-follow-up-engages | `fixtures-batch2.test.ts.snap` | `TestParity_MentionStickyFollowUpEngages` | PASS |
| mention-sticky-dm-never-engages | `fixtures-batch2.test.ts.snap` | `TestParity_MentionStickyDMNeverEngages` | PASS |
| no-agent-wired-no-gate | `fixtures-batch2.test.ts.snap` | `TestParity_NoAgentWiredNoGate` | PASS |
| no-agent-wired-denied-channel | `fixtures-batch2.test.ts.snap` | `TestParity_NoAgentWiredDeniedChannel` | PASS |

### Sessions (9 fixtures)

All assert `session.ResolveSession`/`Create`/`IsUniqueViolation`/`MarkContainerRunning` against the golden `created`/`sessionMode`/`containerStatus` fields.

| Fixture | Snapshot export | Go test | Result |
|---|---|---|---|
| new-session | `fixtures.test.ts.snap` | `TestParity_NewSession` | PASS |
| existing-session | `fixtures.test.ts.snap` | `TestParity_ExistingSession` | PASS |
| running-container | `fixtures.test.ts.snap` | `TestParity_RunningContainer` | PASS |
| stopped-container | `fixtures.test.ts.snap` | `TestParity_StoppedContainer` | PASS |
| session-mode-per-thread | `fixtures-batch2.test.ts.snap` | `TestParity_SessionModePerThread` | PASS |
| session-mode-agent-shared | `fixtures-batch2.test.ts.snap` | `TestParity_SessionModeAgentShared` | PASS |
| session-id-collision-classified | `fixtures-batch2.test.ts.snap` | `TestParity_SessionIDCollisionClassified` | PASS |
| container-wake-failure | `fixtures-batch2.test.ts.snap` | `TestParity_ContainerWakeFailure` | PASS |
| accumulate-stores-without-waking | `fixtures-batch2.test.ts.snap` | `TestParity_AccumulateStoresWithoutWaking` | PASS |

### Mailbox (1 fixture)

| Fixture | Snapshot export | Go test | Result |
|---|---|---|---|
| duplicate-input | `fixtures.test.ts.snap` | `TestParity_DuplicateInput` | PASS |

### Delivery (3 fixtures)

All assert `delivery.Deliver`/`ResolveDeliveryTarget`/`NextAttempt` + `delivery.FakeAdapter`, and `outbound-delivery` additionally exercises `restart.FilterUndelivered` (P4-05) for the "delivered exactly once" contract.

| Fixture | Snapshot export | Go test | Result |
|---|---|---|---|
| outbound-delivery | `fixtures-outbound-delivery.test.ts.snap` | `TestParity_OutboundDelivery` | PASS |
| delivery-permanent-failure | `fixtures-outbound-delivery.test.ts.snap` | `TestParity_DeliveryPermanentFailure` | PASS |
| delivery-retry-then-recovers | `fixtures-outbound-delivery.test.ts.snap` | `TestParity_DeliveryRetryThenRecovers` | PASS |

### Runtime (container wake)

No separate axis of fixtures targets container-wake *composition* (mounts/spec) — none of the 20 in-scope fixtures exercise `SessionSpec`/driver-level wake composition, only the boolean wake outcome, which is covered inline within the session fixtures above (`running-container`, `container-wake-failure`) via `lifecycle.Registry.Wake`.

## Fields deliberately excluded from parity assertions

1. **`session.lastActiveTouched`** (all session/routing fixtures that include a `session` object). Grounded in `src/session-manager.ts:312`: `writeSessionMessage` unconditionally calls `updateSession(sessionId, { last_active: ... })` on every delivered *or* accumulated message. This is `deliverToAgent`/`writeSessionMessage` orchestration — router.ts's own BOUNDARY/KEEP-TYPESCRIPT composition — not something any ported Go decision function (including `session.ResolveSession`) owns today. Asserting a fabricated Go equivalent would mean inventing uncited composition logic rather than porting real source, which this project's standing practice forbids.
2. **`containerWake.attempted` in the `accumulate-stores-without-waking` fixture only**. Grounded in `src/differential/fixtures-batch2.test.ts:240`: the field is computed as `wakeContainer.mock.calls.length > 0` against a `vi.fn()` that Vitest keeps alive for the whole test *file* (no `clearMocks`/`restoreMocks` in `vitest.config.ts`, no explicit `mockClear` in this file's `beforeEach`). Because `mention-sticky-follow-up-engages` (declared earlier in the same file) already invokes `wakeContainer` once, this field's golden value of `true` is an artifact of cross-test mock-instance lifetime and declaration order — not a real accumulate-branch behavior. `router.ts`'s own wake branch (`if (wake) { ... wakeContainer ... }`, line 645) is never entered when `wake=false`, which the ported `routing.DecideWiringOutcome` correctly reproduces (`Wake:false` for the accumulate outcome). This field is excluded to avoid deliberately reproducing test-order noise as though it were a business rule.

Both exclusions are also recorded in the `internal/parity` package's own doc comment (`go-host/internal/parity/doc.go`).

## Verification

Sandbox (vendor-complete checkout): `go build -v ./...`, `go vet ./...`, `go test -race -v ./...`, `gofmt -l .` — all clean; 20/20 new parity tests pass; zero regressions across `config`, `hostinfo`, `session`, `routing`, `lifecycle`, `delivery`, `mailbox`, `restart`.

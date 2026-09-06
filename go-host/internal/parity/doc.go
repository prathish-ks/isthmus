// Package parity is P4-06's differential-parity harness: it proves that the
// Go decision logic ported in P4-01 (internal/session), P4-02
// (internal/routing), P4-03 (internal/lifecycle), P4-04 (internal/delivery),
// and P3-03/P3-05 (internal/mailbox) reproduces the exact outcomes the
// TypeScript host's own committed differential-fixture suite already proved
// for itself — without silently changing any user-visible behavior.
//
// # Comparison mechanism
//
// There is no live dual-execution here: the sandbox this project develops in
// cannot run the TS/Bun host and the Go host side by side, and building a
// harness that could would itself be a multi-day undertaking, not a 3-hour
// task. Instead, the TS side of the comparison is the already-frozen,
// `pnpm run verify:baseline`-approved Vitest snapshot files committed at
// src/differential/__snapshots__/*.snap (P2-03 and P2-04's own work) — the
// project's existing golden record of "what TypeScript actually does" for
// each named fixture. Every assertion below embeds the literal golden value
// extracted from one specific snapshot export, cited by file and export
// name, so a reviewer can diff this file against that snapshot directly
// without re-deriving anything.
//
// # Scope: 20 of 65 differential fixtures
//
// The TypeScript differential suite has 65 total fixtures across five files.
// Only 20 are in scope for this task:
//
//   - 8 from src/differential/fixtures.test.ts (P2-03's core set)
//   - 9 from src/differential/fixtures-batch2.test.ts (P2-04 batch 2)
//   - 3 from src/differential/fixtures-outbound-delivery.test.ts (P2-03 +
//     P2-04's delivery-axis fixtures)
//
// Two categories are deliberately excluded, not merely deferred silently:
//
//  1. The 43 guard-catalog fixtures (fixtures-guard-catalog.test.ts) exercise
//     guard.ts, which is Phase 5 (Security Kernel) scope — no Go port of the
//     guard/command-classification logic exists yet as of P4-06. This
//     task's own prompt guidance ("produce a parity report grouped by
//     sessions/routing/mailbox/runtime/delivery") names five axes and
//     conspicuously omits "guard", read here as confirmation that the guard
//     axis is intentionally left to Phase 5, not an oversight.
//  2. The 2 remaining fixtures (fixtures-unknown-sender.test.ts,
//     fixtures-channel-registration.test.ts) exercise the permissions
//     module's unknown-sender and channel-registration-escalation policy —
//     a module P1-01's docs/host-decomposition.md classifies as KEEP
//     TYPESCRIPT FOREVER (a customization-hook-dense surface never planned
//     for a Go port at all, per LAW-01/LAW-02). These can never gain a Go
//     equivalent, not just "not yet" — there is no future task in the
//     workbook that would port them.
//
// # Composition: per-function assertions, not a reconstructed routeInbound
//
// router.ts's routeInbound/deliverToAgent is itself BOUNDARY/KEEP-TYPESCRIPT
// orchestration (it owns the six customization-hook seams — sender resolver,
// access gate, sender-scope gate, message interceptors, channel-request
// gate, session-created hooks — see router.ts's own package doc comment,
// lines 1-19) and has NOT been ported to Go; only its constituent pure
// decision functions have, across P4-01 through P4-04. This package does
// therefore NOT attempt to reconstruct a composed "RouteInbound" pipeline in
// Go. Instead, each fixture's test asserts every ported function's output
// against the SLICE of that fixture's golden ParityResult the corresponding
// TypeScript function actually produces:
//
//   - routing.EvaluateEngage + DecideWiringOutcome + NoAgentEngaged +
//     DecideUnwiredChannel → routing.dispositions[]/messageOutcome/dropReason
//   - session.ResolveSession/Create/IsUniqueViolation → session.{sessionId
//     (shape only — never a literal ID string, which is fixture-run-specific
//     even in the TS golden values, hence IdNormalizer there), created,
//     sessionMode, containerStatus}
//   - mailbox.Insert (keyed by routing.MessageIDForAgent) →
//     duplicate-input's "second call throws a PK violation" contract
//   - delivery.Deliver/ResolveDeliveryTarget/NextAttempt +
//     delivery.FakeAdapter → delivery.{outcome, attempts, target}
//
// Two golden-value fields are explicitly EXCLUDED from every assertion
// below, each grounded in an inspection of the real TS source rather than
// assumed:
//
//   - session.lastActiveTouched: session-manager.ts's writeSessionMessage
//     (line 312) unconditionally calls `updateSession(sessionId, {
//     last_active: ... })` after every delivered OR accumulated message —
//     this is deliverToAgent orchestration, not something any ported Go
//     decision function owns yet (ResolveSession itself never touches
//     last_active; session.MarkContainerRunning does, but only for the
//     wake-succeeded path). Reproducing it here would mean writing new,
//     uncited composition logic guessed from the snapshot shape rather than
//     a real port — exactly what this project's own practice forbids.
//   - the accumulate-stores-without-waking fixture's containerWake.attempted
//     field: fixtures-batch2.test.ts line 240 computes it as
//     `wakeContainer.mock.calls.length > 0` against a vi.fn() that is never
//     cleared between tests in that file (no clearMocks/restoreMocks in
//     vitest.config.ts, no explicit mockClear in beforeEach). Because the
//     mention-sticky-follow-up-engages fixture earlier in the same file
//     already invokes wakeContainer once (its outcome is 'engaged'), this
//     field's recorded value of `true` is an artifact of Vitest's per-file
//     (not per-test) mock-instance lifetime and test declaration order, not
//     a deliberate product behavior — the accumulate branch itself
//     (router.ts:600 `if (wake) { ... wakeContainer ... }`) never calls
//     wakeContainer at all when wake=false. Asserting a Go equivalent of
//     this specific field would mean deliberately reproducing cross-test
//     mock leakage, which is not a host behavior worth preserving.
//
// Both exclusions are also recorded in docs/parity-report-p4-06.md and
// docs/ADR-002-differential-parity-scope.md.
package parity

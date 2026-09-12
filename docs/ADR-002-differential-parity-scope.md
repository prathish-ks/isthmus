# ADR-002: Differential Parity Scope and Approved Divergences (P4-06)

**Status**: Accepted, 2026-09-02
**Task**: P4-06 (reach differential parity milestone — closes Phase 4, Milestone C: Value Preservation)
**Depends on**: P4-01 through P4-05

## Context

P4-06's own instruction is explicit: "Run every accepted contract against TS baseline and Go host. Investigate every difference; intentional deviations require ADR." Two things need a durable, explicit record rather than only an inline doc comment: (1) exactly which of the TypeScript differential suite's 65 fixtures this milestone did and did not exercise in Go, and why; (2) the three intentional, already-implemented divergences from strict TS-behavior byte-parity that earlier Phase 4 tasks introduced and documented inline, now formally approved as accepted contracts rather than left as scattered code comments.

The comparison mechanism itself — a new `go-host/internal/parity` test package asserting ported Go decision functions against literal values extracted from the already-`verify:baseline`-approved Vitest snapshots, rather than live dual-execution — is recorded in `docs/parity-report-p4-06.md` and in the package's own doc comment; this ADR does not repeat it.

## Decision 1: Scope is 20 of 65 fixtures, not 65

**43 guard-catalog fixtures** (`src/differential/fixtures-guard-catalog.test.ts`) are excluded. They exercise `guard.ts` — command/action classification — which is Phase 5 (Security Kernel) scope. No Go port of that logic exists as of P4-06, and porting it now would be new, untested surface introduced ahead of its own workbook task rather than a captured contract, the same reasoning P4-01's own scope note used to defer `resolveTaskSession`. This task's own prompt guidance — "produce a parity report grouped by sessions/routing/mailbox/runtime/delivery" — names five axes and conspicuously omits "guard," read here as the plan's own confirmation that this axis is intentionally deferred, not an oversight this ADR is inventing after the fact.

**2 permissions-module fixtures** (`fixtures-unknown-sender.test.ts`, `fixtures-channel-registration.test.ts`) are excluded **permanently**, not merely deferred. They exercise the permissions module's unknown-sender and channel-registration-escalation policy, which P1-01's `docs/host-decomposition.md` classifies **KEEP TYPESCRIPT FOREVER** — a customization-hook-dense surface (LAW-01/LAW-02: "mechanism in Go, product policy in TypeScript, customizable pieces stay flexible") with no future workbook task that ports it. Unlike the guard-catalog exclusion, there is no future "Decision 1 revisited" expected for this category.

The remaining **20 fixtures** (8 from `fixtures.test.ts`, 9 from `fixtures-batch2.test.ts`, 3 from `fixtures-outbound-delivery.test.ts`) exercise session/routing/mailbox/delivery decision logic already ported across P4-01 through P4-05, and all 20 pass against their golden values — see `docs/parity-report-p4-06.md` for the full per-fixture table.

## Decision 2: Composition is per-function, not a reconstructed `routeInbound`

`router.ts`'s `routeInbound`/`deliverToAgent` is itself BOUNDARY/KEEP-TYPESCRIPT orchestration — it owns six customization-hook seams (sender resolver, access gate, sender-scope gate, message interceptors, channel-request gate, session-created hooks) per its own package doc comment — and has not been ported to Go; only its constituent pure decision functions have been, across P4-01 through P4-04. `internal/parity` therefore does not attempt to reconstruct a composed Go equivalent of `routeInbound` itself. Each fixture's test instead asserts every already-ported function against the slice of that fixture's golden `ParityResult` the corresponding TypeScript function actually produces (see the package's own doc comment for the full mapping). This is a narrower claim than "the Go host reproduces `routeInbound` end to end" — it is "the decision functions ported so far reproduce their own outputs exactly," which is what P4-01 through P4-05 actually delivered.

## Decision 3: Two golden-value fields are excluded from assertion, not silently fabricated

1. **`session.lastActiveTouched`**. `src/session-manager.ts:312`'s `writeSessionMessage` unconditionally touches `last_active` on every delivered or accumulated message — `deliverToAgent` orchestration, not something any ported Go function (including `session.ResolveSession`) owns. Reproducing the golden `true` values here would require inventing new, uncited Go composition logic to match a snapshot shape backward — exactly the practice this project has consistently avoided in every prior task.
2. **`containerWake.attempted` in `accumulate-stores-without-waking` only**. Traced to `src/differential/fixtures-batch2.test.ts:240`: the field is `wakeContainer.mock.calls.length > 0` against a `vi.fn()` Vitest keeps alive for the whole test file (confirmed: `vitest.config.ts` sets neither `clearMocks` nor `restoreMocks`, and this file's `beforeEach` never calls `mockClear`). An earlier fixture in the same file (`mention-sticky-follow-up-engages`) already invokes `wakeContainer` once, so this field's recorded `true` is a cross-test mock-leakage artifact of declaration order, not a real accumulate-branch behavior — `router.ts`'s own wake branch is never entered when `wake=false`, which `routing.DecideWiringOutcome` correctly reproduces (`Wake:false`).

Both are recorded in three places for durability: this ADR, `docs/parity-report-p4-06.md`, and `go-host/internal/parity/doc.go`'s package comment.

## Decision 4: Three pre-existing divergences are formally approved

Each was already implemented and inline-documented in its originating task; this ADR is their first formal, cross-referenced approval as accepted (not merely tolerated) contracts, per this task's "intentional deviations require ADR" instruction.

### 4a. RE2 vs JS regex in `engage_mode='pattern'` (P4-02, `internal/routing/routing.go`)

The TS host evaluates patterns with JS `RegExp`; the Go host evaluates them with Go's `regexp` (RE2). RE2 has no backreferences or lookaround. A pattern invalid in RE2 still fails open (engages) here, matching the TS fail-open outcome for a truly malformed pattern — but a pattern that compiles under both engines with different match semantics (e.g. one using backreferences) will not behave identically between hosts.

**Approved as accepted.** No fixture in the 20-fixture scope exercises a pattern requiring backreference/lookaround semantics (all use `.` or plain literal-text patterns), so this divergence is real but currently unobserved in any captured contract. Operator-facing documentation of `engage_mode='pattern'` for the Go host must state this rather than claim byte-for-byte regex parity. This is tracked as a documentation follow-up, not a code fix, since RE2's safety properties (no catastrophic backtracking) are themselves a deliberate, desirable property of a hardened host.

### 4b. `getDueMessages` malformed-row resilience (P3-05, `internal/mailbox/outbound.go`)

`src/mailbox/sqlite/index.ts`'s real `getDueMessages()` treats one malformed row as a best-effort partial delivery rather than failing the whole read, so a single bad row can't block an entire outbound queue in production. `internal/mailbox.DueOutbound` instead fails the whole read on the first malformed row.

**Approved as accepted, with a scope note.** This was deliberately chosen at P3-05 (a Phase 3 protocol proof) on the reasoning that a protocol proof should surface a contract violation loudly rather than paper over it. No fixture in the 20-fixture scope constructs a malformed outbound row, so this divergence is not exercised by any parity test today. Flagged forward (already noted at P3-05): if a real install ever produces a malformed row in production, Go's current fail-whole-read behavior is stricter (fails loud) rather than looser (silently drops one row) than TS. This is an acceptable direction for a trust kernel to diverge in, but worth porting the TS resilience behavior in a later hardening pass if this ever proves disruptive operationally.

### 4c. Strict vs lenient timestamp parsing in `DecideStuckAction` (P4-03, `internal/lifecycle/lifecycle.go`)

Each claim's `StatusChanged` is parsed with `internal/mailbox.ParseTimestamp` (strict, canonical `toISOString()` format) rather than JavaScript's lenient `Date.parse`. In production every `StatusChanged` value was itself written by the host in canonical form, so this is not expected to change behavior on real data. It only means an adversarial or corrupted timestamp string that `Date.parse` would loosely accept and Go's strict parser would reject is treated as unparseable (the claim is skipped), mirroring `decideStuckAction`'s own `Number.isNaN(claimedAt)` branch for a genuinely unparseable string.

**Approved as accepted.** This is a strictly stricter failure mode (reject-and-skip on ambiguous input), which is the correct direction of divergence for a hardened kernel. No fixture in the 20-fixture scope exercises a non-canonical timestamp, so it is unexercised by any parity test but poses no known behavioral risk.

## Options considered

**Expand scope to all 65 fixtures before closing Phase 4.** Considered and rejected: 43 of the remaining 45 fixtures require porting `guard.ts` first, which is explicitly Phase 5's own task, not a P4-06 sub-task. Doing that work here would silently pull forward the highest-risk, security-critical port (per `docs/host-decomposition.md`'s own risk annotation on `container-runner.ts`/`guard.ts`) ahead of its planned sequencing, for the sake of a fixture count rather than a genuine readiness signal.

**Reconstruct a composed `routeInbound` equivalent in Go now, to close the `lastActiveTouched`/`containerWake.attempted` gaps.** Considered and rejected: doing so would mean writing new production-shaped orchestration code not requested by any P4-0x task, guessing at composition details from snapshot shape rather than real source in at least one case (the mock-leakage artifact has no correct Go equivalent to write at all), and expanding this task's 3-hour estimate into something closer to a full router port. That itself would be a future task, if ever undertaken, given `router.ts` is currently classified BOUNDARY/KEEP-TYPESCRIPT.

## Decision

**Accept the 20-fixture scope, the per-function composition approach, the two field exclusions, and formally approve the three pre-existing divergences (4a-4c) as accepted contracts.** This closes Phase 4's own bar — "all accepted host contracts pass or have approved ADRs" — for every contract this milestone was actually positioned to prove.

## Consequences

- Phase 4 (Value Preservation) is closed: P4-01 through P4-06 all done, 6/6.
- The 43 guard-catalog fixtures and `guard.ts` itself remain Phase 5's opening task (P5-01: convert threat model into executable security tests) and its own subsequent port work — not implicitly pulled forward by this ADR.
- The 2 permissions-module fixtures remain permanently out of Go-parity scope; any future differential-testing work on them stays TypeScript-only, exercised by their own existing Vitest suite.
- If a future task ports `router.ts`'s orchestration itself (unlikely given its current BOUNDARY classification, but not ruled out by any document reviewed here), the `lastActiveTouched` and `containerWake.attempted` exclusions should be revisited in a new ADR against that port's real source — not retrofitted onto this one.
- The three approved divergences (4a-4c) carry forward unchanged; each remains flagged in its originating package's doc comment, now cross-referenced here as their formal approval record.

## References

- `docs/parity-report-p4-06.md` — the full 20-fixture pass/fail table and comparison-mechanism description this ADR summarizes.
- `go-host/internal/parity/doc.go` — the parity package's own scope and exclusion doc comment.
- `go-host/internal/routing/routing.go` (P4-02) — `EvaluateEngage`'s RE2 divergence doc comment (4a).
- `go-host/internal/mailbox/outbound.go` (P3-05) — `DueOutbound`'s malformed-row divergence doc comment (4b).
- `go-host/internal/lifecycle/lifecycle.go` (P4-03) — `DecideStuckAction`'s timestamp-parsing divergence doc comment (4c).
- `docs/host-decomposition.md` (P1-01) — the permissions-module KEEP-TYPESCRIPT-FOREVER classification and the `guard.ts`/`container-runner.ts` Phase-5 risk annotations this ADR's scope decisions rest on.
- `docs/design-laws.md` (P1-05) — LAW-01, LAW-02.
- `docs/ADR-001-milestone-b-protocol-proof.md` — the precedent this ADR follows in structure and in explicitly stating what is (and is not) proven.
- `src/differential/fixtures.test.ts`, `fixtures-batch2.test.ts`, `fixtures-outbound-delivery.test.ts` and their committed `.snap` files — the TS source and golden values this milestone's 20 Go tests were built against.

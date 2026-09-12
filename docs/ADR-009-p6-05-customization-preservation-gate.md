# ADR-009: Customization Preservation Gate (P6-05)

Status: accepted, 2026-09-02, as task P6-05. Prerequisite: P6-04 (satisfied). Done when, per the master plan: "≥90% initially; all non-security failures have an improvement plan."

## The calculation

Base population: the 20 scenarios in `docs/customization-catalogue.md`. A scenario counts toward the denominator regardless of category; it counts toward the numerator if building it, on top of a Phase-6-complete `internal/kernel` boundary, requires zero `go-host/` source changes.

| | Count |
|---|---|
| Scenarios requiring zero Go modification (all 20 — see catalogue table + `docs/P6-03-zero-go-edit-proofs.md`'s 10 executed proofs) | 20 |
| Scenarios requiring a Go modification *as part of implementing the customization itself* | 0 |
| **Preservation score** | **20 / 20 = 100%** |

This clears the ≥90% target with the strongest form of evidence the master plan asks for: 10 of the 20 scenarios individually traced to an already-passing, named Go test that proves the relevant function's behavior is parameter-driven, plus the other 10 justified structurally (a code path that provably never reaches `go-host/`).

## The honest asterisk: two Go edits *did* happen this phase

P6-04's compatibility report closed a real gap by adding `mount.Spec.Origin` and updating `credential.ContributionFromArgs` to stamp it. Reporting 100% without addressing this directly would be exactly the kind of overclaiming this project's own ADRs have consistently refused to do (see design-laws.md's note on ADR-002's "mock-leakage exclusion... exactly the right discipline"). The distinction that keeps the 100% figure honest rather than gamed:

- Both edits were **boundary infrastructure**, made once, to close a gap `internal/mount`'s own P5-02 doc comment had already named and left open ("the recommendation left for the user's own PR") — the same category of work as P6-02 itself (building `internal/kernel`), not a customization.
- Neither edit was **caused by** implementing one of the 20 catalogued scenarios. Scenario #17 (a provider-contributed credential mount) was already in the catalogue, already marked "No — but exercises the Go boundary as data," *before* P6-04 ran — the catalogue's own claim was that once the boundary exists correctly, this class of customization needs no Go edit. P6-04 tested that claim against a real extension and found the boundary wasn't *yet* correct for this one case — a P6-02 completeness gap, not a P6-01 classification error.
- After the fix, scenario #17 and every future customization shaped the same way (a new provider stamping `origin: provider`) genuinely need zero further Go changes. `docs/P6-04-compatibility-report.md`'s Finding 2 (model-provider container-registry mounts) already demonstrates a *second*, structurally distinct call site working correctly with no fix at all — because the generic mechanism, once complete, generalizes.

If this project ever needs a stricter, "gate at 100% means literally zero go-host diff this phase" metric, the honest number to report alongside it is **18 of 20 scenarios required no Go work of any kind; 2 of 20 (both mount-related) required a one-time boundary-completeness fix that then generalized to zero further edits.** Both framings are recorded here rather than picking the more flattering one silently.

## Non-security failures and their improvement plans

There are no failures to report — 20/20 scenarios pass, and the one real gap found (Finding 1, `docs/P6-04-compatibility-report.md`) was a security-relevant compatibility gap, not a customization-preservation failure, and it is already closed with a reverified fix and full-module green regression (`go vet`, `go test`, `go test -race`, all packages). The master plan's own done-when only requires an improvement plan for failures that exist; none do. This is recorded explicitly, per this project's established practice of stating a null result plainly rather than letting an empty section pass without comment. Compare design-laws.md's own "Why there is no tenth law" section, written for the identical reason: to leave a durable record that the absence was considered.

## What Phase 6 does not close (carried forward explicitly, not silently)

Two items ADR-008 already named as deferred remain open at Phase 6's close, and are recorded here again so P6-05's own closing review doesn't let them go unremarked:

1. **`container-runner.ts` is not yet rewired** to call `internal/kernel`'s `capability.request` instead of invoking `docker` directly. `internal/kernel` is built, tested (22 unit tests plus a real Unix-socket round trip, all green under `-race`), and is the enforcement boundary LAW-07 requires. But until the TypeScript call sites are switched over, Phase 5's original gap (advisory, not physically exclusive, enforcement) remains true of the *running system* — even though the *component that closes it* now exists and is proven correct in isolation. This is exactly the same "component exists and is tested" vs. "component is wired into the live path" distinction Phase 3/4's own history has surfaced before (hidden dependencies found only at execution, per the Phase 5 readiness review's point 5b). It is flagged here rather than letting Phase 6's Go-side completeness read as "the kernel now enforces," which it will not until this wiring lands.
2. **`cmd/nanogo` does not yet run `Kernel.Serve`** as a long-lived process. Standing up an actual Go host process alongside the TS one — socket lifecycle, restart behavior, how the TS process discovers the socket path — is release-engineering work, tracked for Phase 7+, not invented here.

Both are named as the concrete next architectural milestone, not treated as Phase 6 scope creep: P6-02's own done-when ("a small versioned API/protocol with examples and explicit non-capabilities") is satisfied by the boundary's existence and documentation, not by its live deployment.

## Conclusion

Phase 6 (Customization) is closed: 69 → task count now at 43/69 (Phase 0 through Phase 5, 38/69, plus P6-01 through P6-05). The customization-preservation thesis this entire project exists to prove — that a hardened Go trust kernel and LAW-02's "no Go for ordinary customization" can coexist — has its first executable evidence: 20 catalogued scenarios, 10 proven individually, 100% preservation with the honest accounting above, and one real compatibility gap found and closed along the way.

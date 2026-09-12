# ADR-007: P5-06 Security Scope Review — Phase 5 Close-Out

**Status**: Accepted, 2026-09-02
**Task**: P5-06 (security scope review), Phase 5 — Security Kernel
**Depends on**: ADR-004, ADR-005, ADR-006, `internal/security` (P5-01)

## Context

P5-06's instructions: "Re-run parity/security suites, inspect Go kernel size/responsibilities, move product/integration logic back out if it crept in; ADR records concrete security gains/gaps/kernel scope." This is Phase 5's closing task — its job is to confirm the four preceding tasks (P5-01–P5-05) actually delivered what the threat model asked for, at the size/shape a "trust kernel" is supposed to stay at, not to add new invariants.

## Suite re-run

Whole-module `go test -race -v ./...` from `go-host/`: **all tests pass, zero failures, zero skips.** 223 total tests across all 9 packages (6 pre-Phase-5 + 5 new; `internal/security` and `internal/mailbox` both pre-existed as directories but `security` had no code before P5-01). 63 of the 223 are new this phase:

| Package | Non-test lines | Test lines | Tests |
|---|---|---|---|
| `internal/mount` | 543 | 338 | 24 (parity table) + 14 named |
| `internal/containerdefaults` | 151 | 137 | 8 |
| `internal/ownership` | 127 | 105 | 9 |
| `internal/credential` | 96 | 169 | 8 |
| `internal/security` | 41 (doc only) | 123 | 9 |
| **Total, Phase 5** | **958** | **872** | **~63 new (net of table-driven sub-cases)** |

`gofmt -l .` reports no unformatted files. `go vet ./...` is clean.

## Kernel size and responsibilities

958 lines of new non-test Go code, none of which is product or integration logic:

- `internal/mount` — pure validation (`ValidateSpec`, `mountAllowed`, `IsSecretShaped`) and a policy-check function (`CheckAllowlistedExtra`). No Docker invocation, no session orchestration.
- `internal/containerdefaults` — pure validation (`ValidateRunAs`, `ValidateResources`) and argv-fragment assembly (`UserArgs`, `ResourceArgs`). No container lifecycle code.
- `internal/ownership` — pure validation (`ValidateID`, `ValidateOwnership`) and path construction mirroring an existing function. No I/O beyond `filepath` string operations.
- `internal/credential` — pure parsing/validation of an argv shape into a typed struct. No network calls, no OneCLI SDK invocation.
- `internal/security` — no runtime code at all; a package doc plus a test file asserting the other four packages' headline invariants in one place.

This matches LAW-01/LAW-02's kernel-scope discipline: every new package answers a yes/no or produces a validated value; none of them decides *what an agent should do*, only *whether a proposed action is allowed*. No product/integration logic crept in — there is nothing to move back out.

## Concrete security gains

1. **Six named threat-model areas now have executable tests** (`internal/security/security_test.go`), each pointing at the specific package/function that enforces it, closing the "is there a test for X" question the threat-model addendum left open.
2. **Two genuine, previously-undocumented findings surfaced during the port**, both proven against real code paths:
   - ADR-004: the shipped-but-unmerged PR #3680 mount-hardening fix would likely break OneCLI's own credential-mount injection if wired in as-is. This is a live risk on the user's own open PR, not a Go-kernel-only concern — flagged with a concrete pre-merge verification recommendation.
   - ADR-005: both the TypeScript and Go hosts join `agentGroupId`/`sessionId` into a mailbox filesystem path with zero validation, an unexploited-today but real latent path-traversal gap, proven against the actual shipped `internal/mailbox.Path`. `internal/ownership` closes this for new callers without touching the existing function's signature.
3. **Two Go-only hardening additions beyond the pinned TS baseline**, both off-by-default so they change nothing unless a caller opts in: `mount.Policy.ResolveSymlinks` (real symlink resolution; the TS baseline's `hostPathCanonical` is lexical-only by its own admission) and `containerdefaults.ValidateRunAs`'s explicit root rejection (the TS baseline has no equivalent check at all).
4. **Three properties of the existing credential-isolation mechanism are now pinned as permanent regression tests** (ADR-006) rather than living only as an informal trust in `onecli.ts`'s correctness.

## Named gaps (carried forward, not silently assumed solid)

1. **ADR-004's OneCLI/allowlist interaction is unresolved**, by design — resolving it requires either mount-origin tracking (a real `SessionSpec` shape change) or a setup-time allowlist seeding guarantee this pass did not verify. `mount.CheckAllowlistedExtra` remains unwired from any default/example configuration; this review confirms that is still true — grep of `go-host` for callers of `CheckAllowlistedExtra` outside `_test.go` files returns none.
2. **`src/egress-lockdown.ts`'s network-isolation guarantee remains unverified** (carried from the Opus readiness review through ADR-006). It has no decision logic to port — it is pure Docker network-CLI setup — so there is nothing for a Go port to test yet. A future task would need to define what "verified" means for it (e.g., an integration test that actually attempts an external connection from inside a hardened container).
3. **No Phase 3/4 caller has been migrated to `internal/ownership`'s safe path helpers.** `internal/mailbox.Path` itself is unchanged (ADR-005 decision 2, deliberate), so the latent gap it documents still exists in the code path Phase 3/4 already ships — `internal/ownership` is available to new callers but is not yet load-bearing anywhere in the shipped kernel. This is a real residual gap, not a documentation nicety.
4. **`docker-driver.ts`'s own default `runAs` behavior was not independently re-verified this pass** — `containerdefaults.ValidateRunAs`'s new root-rejection invariant is proven against synthetic inputs, not against a captured baseline of what the TS driver actually passes as its own default today. Low risk, since the TS default is very unlikely to be root.

## Decision

Phase 5 is complete as scoped: all six threat-model areas have executable tests, the two required "harden" tasks (P5-02, P5-03) reject unsafe configurations rather than silently accepting them, ownership/credential invariants are preserved and proven, and this review confirms no product logic crept into the new packages. The four gaps above are carried forward explicitly rather than closed by inflating this phase's scope — per this project's standing discipline of doing only what a task's own done-when requires.

## Consequences

- Any future task that wires `mount.CheckAllowlistedExtra` into a default/production policy must first resolve ADR-004's open items, or it introduces a real regression.
- Any future task that migrates a Phase 3/4 mailbox-path call site should point it at `internal/ownership`, and this ADR's gap 3 should be marked closed at that point, not before.
- A future phase (or a dedicated task) is the right place for `egress-lockdown.ts`'s verification and for capturing `docker-driver.ts`'s actual default `runAs` value as a golden baseline — neither is invented as new scope here.

## References

- ADR-004, ADR-005, ADR-006 — the three preceding Phase 5 ADRs this review closes out.
- `internal/security/doc.go`, `security_test.go` — the six-area traceability this review re-confirms.
- `docs/threat-model-addendum-p5.md` — the original area definitions.

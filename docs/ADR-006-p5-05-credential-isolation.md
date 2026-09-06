# ADR-006: P5-05 Credential Isolation — Trace, Port, and the ADR-004 Interaction

**Status**: Accepted, 2026-09-02
**Task**: P5-05 (preserve/improve credential isolation), Phase 5 — Security Kernel
**Depends on**: ADR-004, `docs/threat-model-addendum-p5.md` §4

## Context

P5-05's instructions: "Trace current credential flow first, then reproduce its security properties in Go without introducing new secret exposure... changed credential mechanism has ADR." The credential-flow trace (`src/gateway-providers/onecli.ts`, `src/drivers/types.ts`) is recorded in full in `go-host/internal/credential`'s package doc comment; this ADR records the one thing that trace changed the record of, not a routine restatement of the trace itself.

## What is preserved, not changed

Three security properties, each proven in Go against a real, OneCLI-shaped contribution (`go-host/internal/credential/credential_test.go`), not merely asserted in prose:

1. Credential **values** never ride `contributedEnv`, even though its key-name check is deliberately exempt for legitimate placeholder injection (`TestProperty_ContributedEnvRejectsCredentialValueDespiteExemptKeyName`).
2. Real credential material rides by **reference** (a read-only mount), never by value (`TestProperty_CredentialStubMountRidesByReferenceNotByValue`).
3. The OneCLI SDK's argv grammar is closed and fails loudly on drift (`TestContributionFromArgs_FailsClosedOnUnknownFlag` and siblings) — `contributionFromArgs`'s own comment: "nothing gets to ride raw argv around the spec again."

None of these required a mechanism change; all three are the pinned baseline's existing behavior, ported field-for-field.

## What this task's trace actually found (the reason this ADR exists)

Tracing property 2 end to end — not just reading `onecli.ts` in isolation, but running its output through `mount.ValidateSpec` — surfaced the ADR-004 finding: OneCLI's own contributed mounts are classed `allowlisted-extra`, the exact class P5-02's optional hardening (`mount.CheckAllowlistedExtra`) can newly scrutinize against the operator's `mount-allowlist.json`. `go-host/internal/credential/credential_test.go`'s `TestFinding_HardenedAllowlistCheckCanBreakOneCLIsOwnContributedMount` proves this concretely: a realistic operator allowlist (dev project directories only) denies OneCLI's own credential-stub mount once `CheckAllowlistedExtra` is wired in.

This is a genuine interaction between two Phase-5 tasks' invariants, not a P5-05-only finding — it lives primarily in ADR-004, with this ADR cross-referencing it because it is P5-05's actual credential-isolation property that would break, not P5-02's mount rules in the abstract.

## Decision

1. No credential mechanism is changed by this task. The three properties above are ported as-is; no ADR-mandated behavior change exists to record beyond the ADR-004 cross-reference.
2. The ADR-004 interaction stands as the primary open item touching credential isolation: **`mount.CheckAllowlistedExtra` must not be wired into production without first resolving how OneCLI's own contributed mounts are exempted or allowlisted** — doing so today would silently break every session's credential injection, which is a far worse outcome than the gap it would close.
3. **Not done in this task, named as a real gap rather than silently assumed solid**: `src/egress-lockdown.ts`'s network-isolation guarantee (no exfiltration to non-internal destinations), which the credential flow's overall security value ultimately depends on, has no decision logic to port (pure Docker-CLI network setup) and was not verified this pass — carried forward from the Opus readiness review as still open.

## Consequences

- `go-host/internal/credential`'s test suite is the executable record of all three preserved properties and the one interaction finding; a change to any of them should update this ADR, not just the code.
- P5-06's security scope review should confirm `mount.CheckAllowlistedExtra` remains unwired in any default/example configuration this project ships, per ADR-004 decision 1.

## References

- ADR-004 — the mount-hardening decision and the OneCLI interaction's primary record.
- `src/gateway-providers/onecli.ts`, `src/drivers/types.ts` — the traced source.
- `docs/threat-model-addendum-p5.md` §4 — the secret-exposure invariants this task's properties satisfy.
- `go-host/internal/credential/credential.go`, `credential_test.go` — the port and its executable evidence.

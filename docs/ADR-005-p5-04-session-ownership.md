# ADR-005: P5-04 Session/Mailbox Ownership — A Real Path-Traversal Gap in Both Hosts

**Status**: Accepted, 2026-09-02
**Task**: P5-04 (enforce session/mailbox ownership), Phase 5 — Security Kernel
**Depends on**: `docs/threat-model-addendum-p5.md` §3 (flagged this as unverified)

## Context

`docs/threat-model-addendum-p5.md` §3 named an unverified item: whether the mailbox layer validates a `sessionId`/`agentGroupId` before joining it into a filesystem path, independent of the mount-validation layer (which governs what gets *mounted into a container*, not what a host-side path-join resolves to before ever touching Docker). P5-04's instructions ask directly for this: "prevent forged IDs or cross-session path/DB swaps... add negative tests for forged IDs and swapped paths."

## The finding

Both hosts join these IDs into a path with no validation at all:

- TypeScript: `src/mailbox/sqlite/paths.ts`'s `sessionMailboxDir` — `path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId)`.
- Go (already shipped, P3-03): `go-host/internal/mailbox.Path` — `filepath.Join(dataDir, "v2-sessions", agentGroupID, sessionID, "inbound.db")`.

Both `path.join` (Node) and `filepath.Join` (Go) **clean** the resulting path — collapsing `..` segments rather than rejecting them. Neither function checks its inputs first. This is confirmed executably: `go-host/internal/ownership/ownership_test.go`'s `TestFilepathJoinAloneWouldHaveBeenExploitable` calls the real, already-shipped `internal/mailbox.Path` with a sessionId of `"../../../tmp/evil"` and confirms the result resolves outside `dataDir/v2-sessions`.

**Calibration**: this is a currently-**unexploited latent gap**, not a live vulnerability report. In today's real code paths, `agentGroupId`/`sessionId` values are always host-generated (`internal/session.generateID`'s alphanumeric-with-hyphens format) and never taken raw from external input in any path this project has traced so far. The point — consistent with this whole project's governing philosophy (LAW-07's "physically impossible," not "believed safe") applied one level down from Docker execution to filesystem path construction — is that this invariant was **assumed**, not **checked**, in both hosts identically.

## Decision

1. **`go-host/internal/ownership` is a new package**, not a modification to `internal/mailbox.Path`'s existing signature — changing that function's signature would ripple through every P3-03–P4-06 call site that already depends on it returning a bare string. `ownership.ValidateID` rejects a forged ID with an allowlist regex (`^[A-Za-z0-9_-]+$`) — deliberately an allowlist, not a denylist targeting only `".."`, so it cannot be bypassed by an encoding this package's author did not anticipate. `ownership.SafeMailboxDir`/`SafeMailboxPath` validate then perform the identical join `internal/mailbox.Path` does (confirmed by a test asserting byte-identical output for legitimate IDs).
2. **`internal/mailbox.Path` itself is left unchanged.** `ownership.SafeMailboxDir`/`SafeMailboxPath` are the recommended calling convention for any *new* mailbox-path construction; migrating existing P3-03–P4-06 call sites to go through them is a separate, explicit follow-up, not done in this task (scope discipline: "implement only ownership checks required by threat model/contracts").
3. **`ownership.ValidateOwnership`** covers the second half of this task's instruction (cross-session swaps): given a claimed agent-group id and the one actually recorded for a session, it refuses a mismatch — the mailbox-layer analogue of `mount.ValidateSpec`'s group-state `groupScope` check, which guards what gets mounted rather than what gets opened as a file.
4. **Recommendation for the user, not acted on unilaterally**: the identical gap in `src/mailbox/sqlite/paths.ts` is real, present-day, and worth a small hardening PR of its own — either against this project's own fork or, if judged worth it, upstream — mirroring the shape of PR #3680. This is the user's call; this ADR only surfaces the finding with the evidence to act on it.

## Consequences

- Every new Go-host mailbox-path construction should go through `ownership.SafeMailboxDir`/`SafeMailboxPath`, not raw `filepath.Join` or `internal/mailbox.Path` directly, going forward.
- `TestFilepathJoinAloneWouldHaveBeenExploitable` is a permanent regression pin: if `internal/mailbox.Path` itself is ever hardened directly (making this test's premise false), that test failing is the correct signal to revisit this ADR, not to delete the test silently.
- P5-06's security scope review should confirm whether any Phase-4-era caller of `internal/mailbox.Path`/`outbound.go`'s equivalent construction has since been migrated, and if not, record it as a named residual gap rather than letting this ADR's "not yet migrated" note go stale.

## References

- `src/mailbox/sqlite/paths.ts` — the identical gap in the TypeScript host.
- `go-host/internal/mailbox/mailbox.go`'s `Path` (P3-03) — the already-shipped Go function this ADR does not modify.
- `docs/threat-model-addendum-p5.md` §3 — the item this ADR resolves.
- `go-host/internal/ownership/ownership.go`, `ownership_test.go` — the implementation and executable evidence.

# ADR-034: Go-kernel mount/network model additions for v2.4.0 (gateway-trust, multi-container isolation)

Status: decided and implemented 2026-09-25, v2.4.0 promotion, Workstream A
(A1-A6). Closes `docs/promotion-v2.4.0.md`'s F1(a), the one ADR that list
named but never got written — (b) and (c) went to ADR-030, C14/C15 went to
ADR-032, egress-lockdown generalization went to ADR-033; this is the
fourth, covering the Go kernel's own mount/network model changes.

## Background

Upstream nanoclaw v2.4.0 adds a `gateway-trust` mount class and a
multi-container/private-network session model to the TypeScript driver
layer (`drivers/types.ts`, `docker-driver.ts`). Isthmus's Go kernel
(`internal/mount`, `internal/kernel`) is this project's own addition —
upstream has no Go source to port from for the execution half of this
(the admission/validation half mirrors a real TS rule; the network/
container orchestration half is original Go implementation work).

## Decisions

**A1 — `gateway-trust` mount class** (`internal/mount`, commit `5dd6ec64`).
Ported the class value, `Policy.GatewayTrustRoot`, and the admission rule
(ro-only, agent-role-allowed, checked ahead of identity-material — exact
TS ordering) into `ValidateSpec`/`ClassRequiredByPath`/`mountAllowed`.
Extended this package's own Go-only symlink-escape hardening to the new
pinned root. A real bug was found and fixed here, not just ported
faithfully: `underRoot(path, "")` matched every absolute path, so an unset
`GatewayTrustRoot` would have silently misclassified every mount as
gateway-trust-admitted — closed with an explicit empty-root fail-closed
guard, verified via negative control.

**A2 — Wire protocol extension and the version bump**
(`internal/kernel`, commit `41af3c5f`). Added `NetworkAccessIntent`/
`NetworkAccessTarget` to `internal/mount` and threaded them through the
wire payload; `mount.Session.Containers` needed no change (already a
slice — multi-container wire capacity predates this promotion). Bumped
`ProtocolVersion` from `v1` to `v2`. This is the piece F1(a) explicitly
asked for a "mixed-version compatibility matrix" on — produced, and it
turned out to already exist in the clearest form this project has for
it: `protocol.go`'s own doc comment on `ProtocolVersion`, written as part
of A2's own commit, states the full answer directly rather than needing
a separate document to restate it:

> "Neither side can be half-upgraded against the other — this is a
> deliberate fail-closed property of the existing exact-match gate, not
> something v2 changes or needs a new tolerance mechanism for. No
> unknown-field tolerance is attempted either: the version string itself
> is the compatibility boundary, checked before any payload is ever
> parsed."

Filled in against the playbook's own required questions
(`upstream-promotion-playbook.md`'s Step 4):

| Pairing | Outcome |
|---|---|
| old (v1) host × old (v1) kernel | Supported (unaffected by this bump) |
| new (v2) host × new (v2) kernel | Supported (the only pairing this promotion produces) |
| old (v1) host × new (v2) kernel | Rejected — `ErrUnsupportedVersion`, checked before payload decode |
| new (v2) host × old (v1) kernel | Rejected, symmetrically (a hypothetical newer host talking to an un-upgraded kernel) |
| Independent rollback of either side | Not supported — rejection is the rollback safety net: a mismatched pair fails closed immediately rather than degrading, so there is no unsafe intermediate state to roll back out of |
| Unknown/extra field tolerance | None — the version string, not field-level tolerance, is the compatibility boundary |
| Operator-visible mismatch signal | A clean rejected response at dispatch time (`kernel_test.go`'s `TestDispatch_RejectsUnsupportedVersion`), not a hang, crash, or silent misbehavior |

This resolves cleanly because this project's deployment model is
single-install, both sides versioned and shipped together (`go-host` and
the TS host live in the same repo, same release) — there is no supported
scenario where an operator runs a v1 kernel against a v2 host or vice
versa outside of an in-progress, incomplete upgrade, which the exact-
match gate refuses by design rather than accommodates.

A real regression was found and fixed during this same work: a
pre-existing test hardcoded the literal string `"v2"` as its "unsupported
version" fixture, written when `ProtocolVersion` was still `"v1"` — the
bump silently made that fixture describe the *current* version instead
of an unsupported one. Fixed to derive from the live constant instead of
a literal, so a future bump can't silently break this exact test the same
way again.

**A3 — Multi-container Wake/Kill, private network isolation**
(`internal/kernel`, commit `2a093034`). Original implementation (no
upstream Go source): per-session `--internal` Docker network, `--read-
only` auxiliary containers with their own bridge uplink, alias-based
network connect, ordered start (auxiliaries before agent) and full
allocate-all-or-roll-back-everything semantics on partial failure. `Kill`
extended symmetrically (auxiliaries in reverse order, then network).
**Explicit, tracked scope gap**: upstream's paired `status()` change
(auxiliary health-checking) has no Go-kernel equivalent yet — not
attempted, flagged for a later task rather than silently assumed covered.

**A4 — Hardening posture for auxiliary/gateway-proxy containers**
(`internal/containerdefaults`, confirmed no code change needed).
Confirmed by reading upstream's diff line by line rather than assuming:
`--read-only` (A3) is the *only* role-based difference upstream's own new
code makes to `containerCreateArgs` anywhere; every other hardening flag
(resource caps, user args) already applies identically regardless of
role, matching what Go's `containerCreateArgs` already did. A stricter
posture for auxiliaries specifically (e.g. a tighter seccomp profile)
would be a genuine new hardening decision beyond "port v2.4.0" — noted as
a possible future ADR, not decided here.

**A5/A6 — Verification.** A6: table-driven admission suite for the new
mount class, including a two-container test proving gateway-trust works
on a non-agent (auxiliary proxy) role. A5: live-Docker evidence against a
real daemon (`NANOCLAW_EC05_LIVE_DOCKER=1 go test -race ./...`) —
`TestLive_Wake_MultiContainerSession_PrivateNetworkIsolatesAgentAndReachesProxy`
(private network is `Internal:true` with exactly 2 members; agent reaches
the auxiliary by alias but not the outside internet) and
`TestLive_Wake_MultiContainerSession_AuxiliaryIsReadOnly` (the auxiliary's
real read-only rootfs confirmed from inside it). `go-multi-container-
live-docker` wired REQUIRED into `ci.yml` (Workstream G1) — real, not
report-only, proof this promotion's new network-isolation claim actually
holds.

## Consequences

- `docs/promotion-v2.4.0.md`'s F1(a) is closed by this ADR.
- `go-host/docs/compatibility-matrix.md` already carries the resulting
  Stable ratings for gateway-trust mount admission and multi-container
  network isolation (Workstream F3), and the one Unsupported row for the
  auxiliary health-check gap A3 named.
- The auxiliary health-check gap (A3) and the stricter-hardening-for-
  auxiliaries question (A4) both remain open, tracked here rather than
  silently dropped — either could warrant its own future ADR if picked up.

## What would change this

A future promotion that needs the two kernel/host sides to run at
different versions simultaneously (a rolling upgrade, or independently
versioned components) would need to replace the exact-match version gate
with a real compatibility-negotiation mechanism — a materially larger
design change than anything decided here, and not something this ADR
anticipates.

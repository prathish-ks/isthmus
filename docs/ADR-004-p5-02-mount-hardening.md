# ADR-004: P5-02 Mount Hardening — Default-Off Allowlist Check, and the OneCLI Interaction

**Status**: Accepted, 2026-09-02
**Task**: P5-02 (harden mount/path validation), Phase 5 — Security Kernel
**Depends on**: `docs/mount-validation-fixtures-p5.md` (the 24-case golden capture), `docs/threat-model-addendum-p5.md` §1, ADR-003

## Context

P5-02 ports `src/drivers/types.ts`'s `validateSpec`/`mountAllowed` to Go (`go-host/internal/mount`), and its own instructions ask specifically to "reject forbidden roots/traversal/symlink escape." The pinned `v2.3.0` baseline has one confirmed gap (the fixture capture's 2 `DIFF` rows): `mountAllowed`'s `'allowlisted-extra'` case trusts the class label unconditionally, allowing `/var/run/docker.sock` and `/root/.ssh` through with zero independent check. A fix for this already exists — `mount-security-hardening.patch` / [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680) — which wires the operator's `~/.config/nanoclaw/mount-allowlist.json` check (`isHostPathAllowlisted`, `src/modules/mount-security/index.ts`) into every `'allowlisted-extra'` mount, unconditionally, via `drivers/index.ts`'s production `mountPolicy()`.

While porting this to Go (`mount.CheckAllowlistedExtra`, a faithful port of `isHostPathAllowlisted`), a closer read of `src/gateway-providers/onecli.ts` surfaced a genuine interaction risk with that same fix — in the shipped PR, not just in this project's own Go port.

## The finding

`onecli.ts`'s `contributionFromArgs` (the function that turns the OneCLI SDK's argv output into a typed `GatewayContribution`) stamps **every** `-v` mount it parses with `class: 'allowlisted-extra'` — including the gateway's own CA certificate and credential-stub **files**, which the file's own doc comment says ride as mounts specifically because "stubs never ride env." These are not operator-configured paths; they are internal to the OneCLI SDK, and there is no reason an operator's `mount-allowlist.json` would ever list the SDK's own stub-file directory as an `allowedRoot`.

`validateSpec` (and this Go port) has no notion of mount *origin* — an `allowlisted-extra` mount from `contributionFromArgs` is indistinguishable, at the point `mountAllowed` runs, from one an operator configured through `additionalMounts`. So wiring `isHostPathAllowlisted`/`CheckAllowlistedExtra` as the check for **every** `allowlisted-extra` mount — exactly what PR #3680 currently does in `drivers/index.ts` — would also subject OneCLI's own contributed mount to the operator's allowlist file, and **block it** unless that file happens to already list the SDK's stub directory as an allowed root. Nothing in the setup flow (`generateAllowlistTemplate`'s own default template lists only `~/projects`, `~/repos`, `~/Documents/work`) suggests it does.

This is proven executably, not just argued in prose: `go-host/internal/credential/credential_test.go`'s `TestFinding_HardenedAllowlistCheckCanBreakOneCLIsOwnContributedMount` builds a real `contributionFromArgs`-shaped mount, runs it through `mount.ValidateSpec` with a realistic (dev-project-only) allowlist, and confirms it is denied.

## Decision

1. **`mount.Policy.AllowlistedExtraCheck` defaults to `nil`**, reproducing the pinned baseline's unconditional trust exactly — this Go port does not silently adopt the PR #3680 behavior as its default, per LAW-06 (reproduce before optimizing). `mount.CheckAllowlistedExtra` is provided, tested, and available for a caller who deliberately wires it in.
2. **This ADR does not resolve the OneCLI interaction** — that requires either (a) exempting provider-contributed mounts from the operator-facing allowlist check by tracking mount origin (a `SessionSpec`/`MountSpec` shape change neither the TS baseline nor this Go port currently has), or (b) ensuring every install's allowlist is seeded with the OneCLI SDK's stub-file directory at setup time. Neither is implemented here; both are recorded as **open items for the user**, since (b) may already be handled by setup in a way this pass did not verify (setup scripts were not re-read this task), and (a) is a real design decision.
3. **Recommendation for the user's own PR #3680**: before that PR merges, verify — on a real install with the fix applied — that a fresh session still spawns successfully with OneCLI's own contributed mount intact. If it does not, the PR as currently scoped introduces a regression that would need fixing before merge, independent of this Go-kernel project entirely. This is the user's call to act on; this ADR does not modify or comment on the live PR itself.
4. **Real symlink-escape resolution (`Policy.ResolveSymlinks`) is added as a genuine Go-side improvement** beyond what the pinned TS baseline attempts (`hostPathCanonical` is lexical-only by the TS source's own admission). Off by default, so it changes nothing about which specs are accepted unless a caller opts in.

## Consequences

- `go-host/internal/mount`'s test suite (`mount_test.go`) reproduces all 24 `mount-validation-fixtures-p5.md` cases against the default (unconditionally-trusting) policy, matching the captured TS baseline exactly — including its 2 known-gap rows — and additionally proves the hardened policy (with `CheckAllowlistedExtra` wired) closes both.
- `go-host/internal/credential`'s test suite makes the OneCLI interaction risk a permanent, named regression check rather than a one-time observation: if the interaction is ever resolved (origin tracking, or a seeded allowlist), that test should start failing in the opposite direction, which is the intended signal to update this ADR.
- P5-06's security scope review should re-read this ADR when assessing whether `AllowlistedExtraCheck` should ever become the Go host's default, and should not do so before item 2's open items are resolved.

## References

- `src/drivers/types.ts` — `mountAllowed`'s `allowlisted-extra` case (unconditional trust).
- `src/modules/mount-security/index.ts` — `isHostPathAllowlisted`'s real source, ported as `mount.CheckAllowlistedExtra`.
- `src/gateway-providers/onecli.ts` — `contributionFromArgs`, the source of the interaction finding.
- `docs/mount-validation-fixtures-p5.md` — the golden capture this port's default-policy tests reproduce.
- [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680) — the shipped, not-yet-merged fix this ADR analyzes.
- `go-host/internal/mount/mount_test.go`, `go-host/internal/credential/credential_test.go` — the executable evidence.

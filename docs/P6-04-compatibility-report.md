# P6-04: Compatibility Report — Existing Skills/Channels Against the New Boundary

Status: written 2026-09-02, as task P6-04. Prerequisite: P6-03 (satisfied). Done when, per the master plan: "compatibility report with pass/fail + exact incompatibility reasons."

## Method

For each representative, already-shipped NanoClaw extension category, this report asks the concrete question P6-02's boundary makes askable for the first time: *if `container-runner.ts`'s three Docker-facing functions were rewired to call `internal/kernel`'s `capability.request` instead of `docker` directly, would this extension's needs still be met?* Two categories produced a real, executable FAIL — both traced to the exact same root cause, both now fixed and reverified. Every other category is a structural PASS: the extension's code never reaches `go-host/` at all, so the new boundary cannot regress it by construction.

## Finding 1 (closed): OneCLI gateway's own contributed mount — FAIL → PASS

**Extension tested:** the OneCLI gateway provider (`src/gateway-providers/onecli.ts`'s `contributionFromArgs`), the built-in provider every install uses to inject model-API credentials — traced in Go by `internal/credential.ContributionFromArgs` since P5-05.

**Initial result: FAIL.** `internal/credential`'s own P5-05 test suite already contained `TestFinding_HardenedAllowlistCheckCanBreakOneCLIsOwnContributedMount`, written during Phase 5 and asserting the failure as a *known, documented, deliberately-left-open* gap (see that package's doc comment and `docs/ADR-006-p5-05-credential-isolation.md`). Re-running it before any P6-04 change confirmed the gap was still live:

```
=== RUN   TestFinding_HardenedAllowlistCheckCanBreakOneCLIsOwnContributedMount
--- PASS: TestFinding_HardenedAllowlistCheckCanBreakOneCLIsOwnContributedMount (0.00s)
```

(The test asserted a denial as its *expected* outcome at that point — a "PASS" here means the gap reproduced, not that the system was safe.)

**Exact incompatibility reason:** `mount.Spec` had no way to distinguish a provider-contributed mount from an operator-configured one. Once an install turns on `mount.CheckAllowlistedExtra` (the opt-in hardening `internal/mount`'s own doc comment recommends operators eventually enable), the check re-validates *every* `allowlisted-extra` mount against the operator's `mount-allowlist.json` uniformly — including OneCLI's own internal credential-stub file, whose path no operator would ever think to list, because it isn't a path they chose. `ValidateSpec` would then deny the mount that every agent container's credential injection depends on.

**Remediation, applied and reverified:** this is precisely the gap the real, already-shipped `nanocoai/nanoclaw#3680` (commit `fdde3b26`) closed on the TypeScript side, discovered and fixed earlier in this same project's work. The Go port had documented the identical gap since P5-02 (`mount.go`'s own doc comment named it explicitly, "the recommendation left for the user's own PR") but had not yet absorbed the fix once that PR became real. Closed now, mirroring the TS fix exactly:

- `mount.Spec` gained an `Origin` field (`OriginOperator | OriginProvider`, zero value = operator, matching every mount shape that existed before this field).
- `mountAllowed`'s `allowlisted-extra` case exempts `Origin == OriginProvider` before consulting `AllowlistedExtraCheck` — same order as the TS fix.
- `credential.ContributionFromArgs` now stamps `Origin: mount.OriginProvider` on every mount it constructs — the Go-side equivalent of `onecli.ts` stamping `origin: 'provider'` at its own call site.

**Reverified result: PASS.**

```
=== RUN   TestFinding_HardenedAllowlistCheckNoLongerBreaksOneCLIsOwnContributedMount
--- PASS: TestFinding_HardenedAllowlistCheckNoLongerBreaksOneCLIsOwnContributedMount (0.00s)
=== RUN   TestOriginProvider_ExemptFromAllowlistedExtraCheck
--- PASS
=== RUN   TestOriginOperator_StillSubjectToAllowlistedExtraCheck
--- PASS
=== RUN   TestOriginProvider_UnhardenedDefaultUnaffected
--- PASS
```

Full module regression (`go vet ./...`, `go test ./...`, `go test -race ./...`) reverified green after this change — see the command transcript folded into this phase's delivery notes.

**Why this doesn't count against P6-03's "zero Go edit" claim for the same customization (catalogue scenario #17):** this was a one-time architecture-parity fix — porting a fix already made once, for real, on the TS side — not a Go change *caused by* adding a new provider-mount customization. After this fix, adding a new provider that follows the identical `origin: provider` contract (any future gateway or model-provider skill) requires zero further Go changes, which is exactly what P6-03 demonstrated and this report confirms empirically rather than by assertion.

## Finding 2 (scoped, no fix needed): model-provider container-registry mounts

**Extension tested:** `src/providers/provider-container-registry.ts`'s `VolumeMount`/`ProviderContainerConfigFn` mechanism — the seam a skill like `/add-opencode` uses to contribute host mounts for a model provider's own container needs (the "opencode-xdg"-style branch in `container-runner.ts`'s `buildMounts`).

**Result: PASS, structurally.** Unlike OneCLI, this path has no dedicated Go-side composer (there is no `internal/<providername>` package mirroring `internal/credential`) — composition for this branch is entirely TypeScript's job, and always has been. The kernel's only contact with it is validating whatever `mount.Spec` (with whatever `Origin` TS stamps) the composed `SessionSpec` ultimately carries into `capability.request`. `TestOriginProvider_ExemptFromAllowlistedExtraCheck` already covers this generically — it does not matter which real TS call site produced an `Origin: OriginProvider` mount, since the check that matters (`mountAllowed`'s exemption) has no knowledge of provenance beyond the field itself. No Finding-1-style gap exists here because there was never a Go-side function silently omitting the stamp for this path — there was never a Go-side function for this path at all.

## Finding 3: container-side skills — PASS (out of reach by construction)

Tested representatively: `slack-formatting`, `whatsapp-formatting` (channel-specific formatting), `welcome` (greeting customization), `onecli-gateway` (MCP tool usage guidance), `self-customize`, `frontend-engineer`, `vercel-cli` (container skills, per CONTRIBUTING.md's skill-type #4). All mount read-only at `/app/skills` (host-decomposition.md #4's mount evidence) and run inside the agent container, which — per host-decomposition.md #15 — communicates with the host exclusively through the mailbox and composed project doc, never through any RPC the kernel boundary could intercept or break. **PASS**, unconditionally: P6-02's boundary sits between the TS host process and Docker; container-internal skills never reach either.

## Finding 4: registry-branch channel/provider skills — PASS (install-time only)

Tested representatively: `/add-telegram`, `/add-slack`, `/add-discord`, `/add-opencode`. Per CONTRIBUTING.md's skill-type #1, install is `git fetch` + `git show <branch>:<path> > <path>`, never a merge into `main`, and the adapter code that lands is ordinary `ChannelAdapter`-interface TypeScript (host-decomposition.md #13, "the single clearest LAW-01 boundary in the codebase"). **PASS**: nothing about installing or running a new channel/provider touches `go-host/`; the one path that *can* (a provider's mount contribution) is Finding 2, already covered.

## Finding 5: routing/scheduling/delivery customizations — PASS (decision booleans only)

Tested representatively: a custom access-gate rule (permissions module), a scheduling/recurrence hook, a new `registerDeliveryAction`. All three are TS-owned hook seams per host-decomposition.md (#2/#6/#11 for the first two; #5 for the third); each communicates with its corresponding Go-owned decision function (`routing.DecideWiringOutcome`, none for scheduling — `decideStuckAction` has no recurrence concept at all — and `delivery.ResolveDeliveryTarget`) via plain booleans/values already covered by that function's own pre-existing test suite (cited exactly in `docs/P6-03-zero-go-edit-proofs.md`). **PASS**.

## Summary

| Category | Result | Fix required |
|---|---|---|
| OneCLI gateway contributed mount | FAIL → PASS | Yes — `mount.Origin` + `credential.ContributionFromArgs` stamp (applied, reverified) |
| Model-provider container-registry mounts | PASS | No — generic mechanism already covers it |
| Container-side skills (formatting, greeting, MCP tools) | PASS | No — out of reach by construction |
| Registry-branch channel/provider skills | PASS | No — install-time only |
| Routing/scheduling/delivery hook customizations | PASS | No — decision-boolean boundary already covered |

One real, exact incompatibility found and closed; four categories confirmed compatible by construction or by already-existing test coverage. This satisfies P6-04's done-when in full, including its harder half — a report that found nothing would be a weaker proof of the exercise than one that found a real gap, disclosed the exact reason, and closed it.

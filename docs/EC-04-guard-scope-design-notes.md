# EC-04 Design Notes: The Guard.ts Scope Decision, Grounded Against Real Source

Status: research complete, 2026-09-02, as groundwork for EC-04 (Phase 9 — Enforcement Closure). This is not the ADR that closes EC-04 — it is the precise, source-grounded scoping that ADR needs, captured now so the implementation pass doesn't have to re-derive it. Everything below was read directly from the user's real, current Mac repo (freshly staged this session), not from the earlier, stale `/mnt/user-data/uploads/nanoclaw-go-lab` mirror, which was found to be missing files added since. That is a reminder to always re-stage before trusting a local mirror for anything beyond a quick reference.

## What "the CLI-derived restart guard" actually is

It is **not** a dedicated restart-specific function, and it is **not** anything inside `src/container-restart.ts` (that file calls `killContainer`/`wakeContainer` directly and consults no guard at all). The real mechanism is generic: `src/cli/guard.ts`'s `commandDecide(cmd, input)`, which every one of the CLI's ~30 registered commands is gated by via `commandGuardSpec(cmd)` — one shared decision function parameterized by each command's static `CommandDef` (`hostOnly`, `resource`, `access: 'open' | 'approval'`, `name`). `ncl groups restart` is simply the one registered command in this catalog whose handler (`src/cli/resources/groups.ts`'s `restart` entry) reaches `restartAgentGroupContainers` → `killContainer`/`wakeContainer` — the two of the three Docker-facing functions LAW-07's annotation names. That is the entire reason this one generic gate is in scope for Go-parity at all: every other CLI command's `commandDecide` gate protects something that never reaches Docker, and moving those would violate LAW-01/LAW-02 for no security benefit (design-laws.md's own words).

`commandDecide`'s logic, read directly from `src/cli/guard.ts`, in order:
1. `actor.kind === 'host'` → `ALLOW` unconditionally (the 0600 socket is the whole auth story for a trusted local caller).
2. `actor.kind !== 'agent'` (i.e. `'system'`) → `DENY`.
3. `cmd.hostOnly` → `DENY` for **any** container caller, regardless of `cli_scope` — operator-only, no exception.
4. Look up `cli_scope` for the caller's agent group (`getContainerConfig(actor.agentGroupId)?.cli_scope ?? 'group'`).
5. `cli_scope === 'disabled'` → `DENY`.
6. `cli_scope === 'group'`: deny if `cmd.resource` isn't on the group-scope allowlist (unless it's the special-cased `wirings-get`/`wirings-update` pair); deny if any of `agent_group_id`/`group` args name a different group; deny if `resource === 'groups' | 'destinations'` and `id` names a different group; deny a `wirings-update` whose args include anything outside the allowed field set; deny any attempt to set `cli_scope`/`cli-scope` itself (privilege escalation).
7. `cmd.access === 'approval'` → `HOLD` (admin approval required).
8. Otherwise → `ALLOW`.

The real `restart` command (`src/cli/resources/groups.ts`, confirmed by direct read) is `{ resource: 'groups', access: 'approval' }`, with no `hostOnly` — exactly matching the fixture's `restartLikeCmd` synthetic stand-in, which is why the fixture is a faithful golden baseline for it.

## The 12 golden fixtures already captured (P2-04, `fixtures-guard-catalog.test.ts` lines 579-747)

Extracted directly from the committed `.snap` file — these are the exact `{effect, reasonCategory}` pairs a Go port must reproduce:

| Scenario | Effect | reasonCategory |
|---|---|---|
| guard-cli-host-caller | allow | cli-host-caller-allowed |
| guard-cli-non-host-non-agent | deny | cli-non-host-non-agent-denied |
| guard-cli-host-only-denied | deny | cli-host-only-command-denied |
| guard-cli-scope-disabled | deny | cli-scope-disabled-denied |
| guard-cli-scope-resource-not-allowlisted | deny | cli-scope-resource-not-allowlisted-denied |
| guard-cli-scope-cross-group-arg | deny | cli-scope-cross-group-denied |
| guard-cli-scope-cross-group-id | deny | cli-scope-cross-group-denied |
| guard-cli-scope-wiring-update-args | deny | cli-scope-wiring-update-args-denied |
| guard-cli-scope-mutation-denied | deny | cli-scope-mutation-denied |
| guard-cli-approval-required-hold | hold | cli-approval-required-hold |
| guard-cli-open-command | allow | cli-open-command-allowed |
| guard-cli-grant-satisfied | allow | grant-satisfied-hold-allowed |
| guard-cli-grant-mismatch | deny | grant-invalid-or-mismatched-denied |

`guard()`'s own grant-satisfaction wrapper (a `cli_command`-action pending-approval row whose `payload.frame.command` matches the exact command name) is the mechanism behind the last two rows and is itself generic — already covered by `guard.ts`'s own logic, not `commandDecide`'s.

## The self-mod gate (`src/modules/self-mod/guard.ts`), also read fresh

`self_mod.install_packages` and `self_mod.add_mcp_server` are simpler: both `DENY` any non-agent caller, then `HOLD` unconditionally for admin approval from the container path. `install_packages` is additionally gated by a capability check (`getSessionDriver().capabilities().imageBuild`) that must `DENY` *before* minting a hold when the runtime declares no image-rebuild support, "so an admin is never asked to approve something that cannot happen." This capability-gate detail is already structurally close to something Go tracks: `internal/kernel`'s `CapabilityRequestPayload` carries a `*mount.Capabilities` for `container.wake`, though nothing today reads an `imageBuild`-equivalent field from it for the `container.build_image` capability specifically. It's worth checking whether `mount.Capabilities` needs a field added, or whether TS should keep composing this check and pass its result down, during actual implementation.

## The open architectural question this groundwork surfaces — bigger than a straightforward port

A pure Go **decision-mirror** of `commandDecide` (a `parity`-style package tested against the 12 fixtures above, the same shape as every other Phase 4 port) is straightforward and low-risk — but on its own it does **not** deliver what design-laws.md's LAW-07 annotation actually asks for. Re-reading that annotation precisely: it says the guard logic must move "into the kernel **alongside the execution authority**" — not next to it, tested independently. The reason is structural: once EC-02 makes `killContainer`/`wakeContainer` call the Go kernel's `container.kill`/`container.wake` capability instead of Docker directly, the kernel becomes the sole physical path to the Docker effect. But `internal/kernel`'s `handleCapabilityRequest` today has **no caller-identity or authorization concept at all**. It checks whether a `CapabilityRequestPayload` is *well-formed and safe* (valid mount spec, non-root `RunAs`, sane resources) — never *who is asking or whether they're allowed to*. That means a `commandDecide` Go port sitting beside the kernel, consulted only by a TypeScript call site before it calls the kernel client, reproduces exactly the gap design-laws.md's Phase 1 investigation identified in the first place: nothing stops a different TypeScript code path from calling the kernel client directly and skipping the decision entirely, because the kernel itself doesn't know to ask.

Closing this for real means `CapabilityRequestPayload` (or a new, narrower payload specifically for a CLI-restart-triggered kill/wake) needs to carry enough of `GuardInput`'s shape — actor kind, the caller's `cli_scope`, the command being invoked, any grant — for the kernel itself to evaluate the restart-guard decision as part of `handleCapabilityRequest`, denying before `exec.go` is ever reached. This is exactly the same shape `mount.ValidateSpec`/`containerdefaults.ValidateRunAs` already enforce today. This is real design work, and it should happen as part of EC-02 (the container-runner.ts rewiring) rather than as an independent task afterward — the two are the same boundary. Recommend folding EC-04 into EC-02's implementation pass rather than sequencing it separately, with this document as EC-02's starting design reference for the guard-carrying half of that payload.

## What stays out of scope, confirmed

Every other action in the 43-fixture guard catalog (`a2a.send`, `agents.create`, `senders.admit`, `channels.register`, every non-restart CLI command, `guard()`'s own fail-closed backstops) gates something that never reaches `internal/kernel`'s three capabilities — confirmed by re-reading. These stay permanently TypeScript-only. The ADR that formally closes EC-04 should say this as plainly as this document does, rather than leaving "some subset of 43" vague.

# nanocoai/nanoclaw v2.4.0 Promotion — Living Plan

Status: **living document, plan phase**. Started 2026-09-25. Update this
document's status markers and changelog as each workstream moves — this is
the source of truth for where the promotion actually stands, not the chat
history that produced it.

Companion to `go-host/docs/version-compatibility.md` (the standing
adapter-boundary contract this promotion exercises), `go-host/docs/
compatibility-matrix.md` (the Stable/Preview/Unsupported ratings this
promotion will need to re-issue), `docs/upstream-pin.json` /
`docs/baseline.md` (what actually moves at the end), and
`ADR-017-p9-07-upstream-overlap-review.md` (the precedent review this
promotion is the sequel to — that review found v2.3.0 still current with no
admission-checked feature work cleared; this one finds the opposite).

## Goal

Move the pinned upstream baseline from `nanocoai/nanoclaw` **v2.3.0**
(`54d9d9a5`) to **v2.4.0** (`143db6c9`), adopting the new upstream features —
not just absorbing them passively — while:

1. Porting every new privileged capability that belongs in the Go kernel
   into the Go kernel, not leaving it TypeScript-enforced by omission.
2. Resolving every seam (TypeScript-calls-kernel) change without silently
   dropping a feature from either project.
3. Finding and closing every new way a privileged operation could bypass
   the kernel, not just the ones this analysis phase happened to notice.
4. Reconciling every pure-TypeScript upstream change against Isthmus's own
   modifications to the same files, without regressing either project's
   features.
5. Keeping user-facing migration (nanoclaw → Isthmus) working for someone
   arriving from either a v2.3.0 or a v2.4.0 nanoclaw install.
6. Only then moving the pin — gated on tests, docs, and CI passing for real,
   not on this plan looking complete on paper.

## Non-goals

- This is not a general "catch up with upstream forever" project. LAW-09
  stays in force: one pinned baseline at a time, promoted deliberately.
- Not scoped to also adopt `add-iron-proxy`'s own CI verification job
  (`iron-front`) or the `channels`/`providers` sibling-branch drift this
  produces (Mattermost, Codex/OpenCode contract work) — those are separate,
  already-tracked threads (see `.github/workflows/ci.yml`'s
  `sync-sibling-branches-*` jobs, merged 2026-09-25). This plan is scoped to
  the **core pin** only.
- Not scoped to decide, up front, whether Isthmus adopts upstream's full
  gateway-session-lifecycle behavior (lease-managed sessions, fail-closed
  shutdown, approval coordination) verbatim, vs. a narrower Isthmus-specific
  design achieving the same trust properties. That decision is Workstream
  C's output, recorded in an ADR — not assumed here.

## Why this promotion is not a routine version bump

The previous overlap review (ADR-017, 2026-09-03) found v2.3.0 still current
with "no new admission-checked feature work cleared yet." That is no longer
true. Concrete findings from this planning phase's own analysis, checked
against `version-compatibility.md` §1's consumed-contracts table and a full
`src/` diffstat (`54d9d9a5..v2.4.0`, 200 files changed, +17,801/-2,232):

- **`drivers/types.ts`** (mount/session admission shape — row 1 of the
  consumed-contracts table): new `MountClass` value `'gateway-trust'`, a new
  **required** `SessionSpec.networkAccess` field, a new `MountPolicy.
  gatewayTrustRoot`, new admission rules. `internal/mount` models none of
  this today.
- **`drivers/docker-driver.ts`** (the Docker chokepoint — row 4):
  `capabilities().auxiliaryContainers` flips `false → true` upstream; the
  explicit refusal of multi-container sessions is deleted; `prepare()` now
  creates a per-session private internal Docker network and spawns
  auxiliary containers alongside the agent.
  - **Isthmus-specific complication, confirmed by reading Isthmus's own
    fork of this file (not just upstream's)**: since ADR-016, the actual
    `docker create`/`docker start` work already lives entirely in
    `internal/kernel` (Go), reached via `this.#kernelClient.wake(spec)`
    sending the whole `SessionSpec` over the socket. Isthmus's TS
    `docker-driver.ts` only validates and forwards. Upstream's new
    network/multi-container logic therefore has **no TS-side home to
    port into** — it has to be designed and built in Go directly. There is
    no upstream Go reference implementation to port from at all, because
    upstream has no Go kernel.
- **A new gateway-provider subsystem** upstream introduced, 21 files under
  `src/gateway-*.ts` and `src/gateway-providers/`: session lifecycle,
  approval coordination, availability, read-policy allowlisting. The
  admission decisions here (`ensureGatewaySession`, `permitsConfiguredGatewayRead`)
  live entirely in TypeScript (`container-runner.ts`, `gateway-read-policy.ts`),
  consistent with — but a materially larger instance of — Isthmus's own
  existing `admissionEnforced: false` acknowledgment in `docker-driver.ts`'s
  `capabilities()`. This needs an explicit, current risk assessment, not an
  inherited assumption.
- **OneCLI moved out of trunk.** `src/gateway-providers/onecli.ts` does not
  exist in the v2.4.0 tree — it now lives under
  `.claude/skills/add-onecli/payload/src/gateway-providers/`, installed like
  a channel/provider skill. Isthmus's current `CLAUDE.md` documents OneCLI
  as trunk-baked. This is a real architectural fork point to decide, not
  just port.
- Everything else in the consumed-contracts table (CLI-restart guard,
  self-mod guard decision logic, `pending_approvals`/`container_configs` row
  shapes, central DB format, mailbox identity shape) is clean — either
  untouched in the full commit range, or changed in ways upstream's own
  commit messages describe as behavior-preserving (verified, not just
  taken on faith — see Workstream B's file-by-file notes as they're filled
  in).

Root cause for the two real breaks and the new subsystem: a single
architectural effort (the "Iron Proxy gateway," PRs #3815/#3816/#3817/#3825,
opened together 2026-09-15, merged together in a 45-minute window on release
day 2026-09-23) — not upstream scope creep across many unrelated PRs. That
narrows what needs deep design work, even though the blast radius (42 files
across the mount/driver/gateway surface) is large.

## Design Law note — read before writing anything under "new law"

`docs/design-laws.md` records an explicit precedent: a proposed LAW-10 was
considered and **declined** on 2026-08-30, because its substance was already
covered by LAW-09 ("upstream moves independently") and LAW-07's own
annotation. The document states the bar plainly: *"the bar for adding a
tenth law is that it must not be restating something LAW-01 through LAW-09
already cover."* It also demonstrates the alternative this project already
uses when a law needs sharpening rather than duplication — see "LAW-07 /
OBJ-04, annotated" in that same file, a dated, evidence-grounded annotation
under the existing law number, not a new one.

**This plan's closing workstream (I) is therefore not "author LAW-10" as a
foregone conclusion.** It is: execute this promotion, then assess honestly
against that same bar. LAW-09 already states almost exactly what this
promotion is a test of — "a NanoClaw release that does not change a contract
consumed by the Go kernel should require zero Go source changes... Pin
stable releases for development and use a separate upstream watch track."
The most likely honest outcome is a **LAW-09 annotation** (mirroring the
LAW-07 precedent) recording the concrete, repeatable methodology this
promotion executes — the three-way classification (seam / bypass-risk /
pure-TS), the ADR-per-architectural-decision discipline, the re-validation
step before pinning. A new law number is only warranted if this promotion
surfaces a genuinely distinct principle LAW-01–09 don't already cover — to
be judged at the end, against real evidence, not decided now.

## Migration continuity — open question, needs discovery before design

The goal states migration must stay seamless for a user coming from either
a v2.3.0 or a v2.4.0 nanoclaw install, and that it's acceptable for
Isthmus's own onboarding to carry a v2.3.0 user forward to v2.4.0 along the
way (i.e., migration target is always "current Isthmus," never a choice of
two destinations).

**Not yet established, and needs its own investigation before this section
can have a real plan**: which existing skill (if any) is actually the
"migrate from a plain nanocoai/nanoclaw install into Isthmus" entry point.
Checked so far:

- `migrate-from-v1` — NanoClaw **v1 → v2** migration. Different axis
  entirely (major-version lineage), not this promotion's concern.
- `migrate-nanoclaw` — "Extracts user customizations from a fork... upgrades
  to upstream by reapplying customizations on a clean base." Built for an
  end user who lightly forked nanoclaw (config values, a few edited files,
  custom skills) and wants to catch up with upstream. Isthmus's own
  divergence from upstream (an entire additional Go trust-kernel layer,
  wire protocol, ADR series) is far deeper than what this skill's own
  stated use case describes. Its **methodology** (extract intent into a
  migration guide, reapply on a clean worktree checkout, never a literal
  `git merge`) is worth borrowing conceptually — the skill itself is not
  obviously fit for purpose as-is.
- `update-nanoclaw` — updates an **already-customized** install in place
  (transactional, worktree-staged, snapshot/rollback). This is the
  in-place-upgrade mechanism for someone who already has Isthmus (or any
  customized NanoClaw) running, not an onboarding path from plain nanoclaw.

**Action item (first task of Workstream H below, but flagged here because
it blocks writing a real continuity plan)**: find or confirm the actual
current "come from nanoclaw, end up on Isthmus" flow. If none exists today
as a dedicated skill, that is itself a finding worth recording, not an
assumption to paper over.

## The four workstreams

### Workstream A — Kernel port (new capability, belongs in Go)

Scope: `internal/mount`'s new admission rule, `internal/kernel`'s executor
gaining per-session private-network creation and multi-container spawn —
the two real consumed-contract breaks from "Why this promotion is not a
routine version bump," above.

| # | Task | Status |
|---|---|---|
| A1 | `internal/mount`: add `MountClass` value `gateway-trust`, `Policy.GatewayTrustRoot`, admission rule (ro-only, agent-role-allowed) mirroring `types.ts`'s new rule exactly | Not started |
| A2 | `internal/kernel`: extend the wire payload (`CapabilityRequestPayload`) to carry `networkAccess` and multi-container `SessionSpec.containers`; decide whether this requires a `ProtocolVersion` bump per `version-compatibility.md` §2's rule ("only needs to change when THIS project changes the TS↔Go contract") | Not started |
| A3 | `internal/kernel` executor: implement per-session `docker network create --internal` + auxiliary container spawn, mirroring upstream's `docker-driver.ts` logic in Go (no upstream Go source exists to port from — this is original implementation work, not translation) | Not started |
| A4 | `internal/containerdefaults`: assess whether auxiliary/gateway-proxy containers need a different hardening posture than the agent container (they're not the agent, but they're not fully trusted either) | Not started |
| A5 | Live-Docker tests proving a multi-container session actually gets a working, correctly-isolated private network — not just that the generated argv looks right (matches this project's own repeated lesson about mocked vs. real coverage) | Not started |
| A6 | Unit tests for the new mount class, table-driven, matching `internal/mount`'s existing style | Not started |

### Workstream B — Seam audit (TypeScript call-sites into the kernel)

Scope: the 18 files that call into or compose what the kernel receives.
Already characterized from the "consumed contracts" pass; this workstream
finishes the *call-sequencing and error-handling* half, which that pass
didn't cover (it only checked data shapes).

| File | Data-shape impact (from prior pass) | Call-sequencing impact | Status |
|---|---|---|---|
| `container-runner.ts` | Major — gateway-session-lifecycle wrapping (load-bearing) + durable-host shadow-writes (upstream-confirmed inert) tangled in one ~900-line diff | Not yet assessed | Not started |
| `drivers/docker-driver.ts` | Major — see Workstream A | N/A, IS the seam | In progress (A) |
| `drivers/types.ts` | Major — see Workstream A | N/A | In progress (A) |
| `drivers/index.ts` | Minor (wiring) | Not yet assessed | Not started |
| `drivers/session-events.ts` | Minor | Not yet assessed | Not started |
| `drivers/spec-fixture.ts` | Test fixture only | N/A | Not started |
| `drivers/conformance.test.ts`, `docker-driver.test.ts`, `driver-selection.test.ts` | Test files — compare against Isthmus's own equivalents for coverage gaps | Not yet assessed | Not started |
| `kernel/client.ts`, `kernel/protocol.ts` | Isthmus-only files (don't exist upstream) — confirm they still model the wire contract correctly once A2 lands | N/A | Blocked on A2 |
| `cli/dispatch.ts`, `cli/guard.ts`, `cli/registry.ts` | Clean (zero commits in range) | Clean | Done — no change needed |
| `cli/resources/groups.ts` | Not yet checked | Not yet assessed | Not started |
| `self-mod/apply.ts` | Clean — shadow-write + wake-routing only, upstream's own commit message: "byte-equivalent by construction" | Clean | Done — no change needed |
| `modules/agent-to-agent/agent-route.ts`, `create-agent.ts` | Not yet checked | Not yet assessed | Not started |
| `modules/kernel-supervisor/index.ts` | Not yet checked (kernel process supervision itself) | Not yet assessed | Not started |
| `host-sweep.ts`, `reconcile.ts`, `request-wake.ts` | Clean — durable-host coordination work, upstream-confirmed "shadow state... nothing reads the rows to make decisions" as of this range | Clean | Done — no change needed |

**Deliverable for each remaining row**: does upstream's change require an
Isthmus-side change to keep behavior correct, and if so, does it also
require a corresponding kernel-side change (feeds back into Workstream A),
or is it TS-only? Record the answer in this table directly, in place —
that's what makes this a living document rather than a one-time report.

### Workstream C — Bypass closure (new privileged surfaces, kernel or not)

Scope: the 21-file gateway/credential subsystem, plus a fresh sweep for
anything this plan hasn't looked at yet — new self-mod capabilities, new
`ncl` commands, anything shelling `docker` or touching credential material
outside `drivers/docker-driver.ts`.

| # | Task | Status |
|---|---|---|
| C1 | Trace `ensureGatewaySession`/`stopGatewaySessionsForUnavailability` (`container-runner.ts`) end to end: can a session reach the gateway, or keep reaching it after the gateway becomes unavailable, through any path that skips this function? | Not started |
| C2 | Trace `permitsConfiguredGatewayRead` (`gateway-read-policy.ts`): is the `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` env-var allowlist the *only* gate on read-only gateway destinations, and is it consulted on every code path that makes an outbound gateway request? | Not started |
| C3 | Confirm the OneCLI-as-skill restructuring doesn't change *how* credentials reach a container — still exclusively via a kernel-admitted `gateway-trust`/`identity-material` mount, never a new env-var or volume path the kernel doesn't validate | Not started |
| C4 | Full re-sweep of the 21 gateway files plus a fresh repo-wide grep (not scoped to `src/` this time — check `container/agent-runner/src/` and `setup/` too) for new `docker`/`exec`/credential-handling code introduced anywhere in the v2.4.0 diff that this plan hasn't already accounted for | Not started |
| C5 | For each finding: either close it (route through the kernel, or an existing guard) or explicitly accept and document the risk in `go-host/docs/compatibility-security-report.md`, the same way `admissionEnforced: false` is already an accepted, named gap today — never a silent gap | Not started |
| C6 | Security-focused review pass using the `code-review` skill, scoped specifically to trust-boundary findings on this diff (not general bug-hunting) | Not started |

### Workstream D — Pure-TypeScript reconciliation

Scope: the remaining ~161 changed files under `src/` (200 total minus
Workstream B's 18 minus Workstream C's 21, with some overlap to resolve)
plus whatever the full-repo diff (`container/agent-runner/`, `setup/`,
`.claude/skills/`) adds once actually enumerated.

| # | Task | Status |
|---|---|---|
| D1 | Full file-level classification into B/C/D, corrected for the double-counting in this plan's first-pass numbers (some files may legitimately belong to more than one bucket) | Not started |
| D2 | Read `migrate-nanoclaw`'s and `update-nanoclaw`'s SKILL.md in full; decide whether either is usable as-is, adaptable, or whether Isthmus's depth of fork needs a bespoke process for this reconciliation specifically | Not started |
| D3 | For each D-bucket file: is it a genuinely independent upstream change (safe to port as-is), or does it touch a file Isthmus has already meaningfully modified (needs manual reconciliation, feature-by-feature, preserving both sides) | Not started |
| D4 | Track every reconciliation decision (port verbatim / port with modification / decline and record why) somewhere durable — this table, or a linked sub-document if the volume warrants it | Not started |

### Workstream E — Testing

| # | Task | Status |
|---|---|---|
| E1 | Go: unit tests for every new/changed `internal/mount` rule (Workstream A) | Not started |
| E2 | Go: live-Docker tests for multi-container sessions and network isolation (Workstream A) | Not started |
| E3 | TS: update/extend the seam tests this project already built (the 6 seam-real tests from the wiring-boundary-coverage effort, merged 2026-09-24) to cover any new wake/kill/build-image call shape from Workstream B | Not started |
| E4 | TS: parity/security-regression coverage for the gateway trust-boundary findings from Workstream C (matching LAW-06/LAW-08's "contracts before rewrites" / "no weaker security than upstream" bar) | Not started |
| E5 | Full suite green: `pnpm exec vitest run`, `bun test` (container/agent-runner), `go test -mod=vendor ./...` including `-race`, plus the live-Docker jobs (`go-ec05-live-docker`, `go-egress-live-docker`) actually run and passing on real CI, not just locally | Not started |
| E6 | `wiring-registry-check` passes against any new privileged function this promotion introduces (Workstream A/C may add real callers/seam tests that need registering) | Not started |

### Workstream F — Documentation

| # | Task | Status |
|---|---|---|
| F1 | New ADR(s) recording the architectural decisions: (a) mount/network model in the Go kernel, (b) gateway-provider trust-boundary scope (what's kernel-enforced vs. accepted TS-side), (c) OneCLI trunk-vs-skill placement decision. One ADR or several, whichever keeps each decision reviewable independently — decide when the decisions are actually made, not now. | Not started |
| F2 | `go-host/docs/version-compatibility.md` §1's consumed-contracts table updated to reflect the new v2.4.0-based contracts | Not started |
| F3 | `go-host/docs/compatibility-matrix.md` Stable/Preview/Unsupported ratings re-issued against the new baseline | Not started |
| F4 | `docs/traceability.md` updated with this promotion's ADR(s) and any new/changed law-breach entries | Not started |
| F5 | `CLAUDE.md`'s "Secrets / Credentials / OneCLI" section updated if Workstream C/D's OneCLI decision changes how it's documented | Not started |
| F6 | This document's own findings folded into `go-host/docs/ADR-017`-style closure, or superseded by a new numbered ADR referencing it | Not started |

### Workstream G — CI / PR-check uplift

| # | Task | Status |
|---|---|---|
| G1 | Assess whether the new Go kernel surface (multi-container sessions, gateway-trust mounts) needs new required CI jobs, mirroring how `wiring-registry-check` was added as a required gate for the last major surface addition | Not started |
| G2 | Assess whether `sync-sibling-branch-script-test`-style regression coverage is warranted for any new script/automation this promotion introduces | Not started |
| G3 | Update `docs/upstream-pin.json`'s `$comment`/fields and `docs/baseline.md`'s "Stable Baseline" section together, in the same commit as the closing ADR (per LAW-09's own discipline, already established) | Not started (final step) |

### Workstream H — Migration continuity (nanoclaw → Isthmus)

| # | Task | Status |
|---|---|---|
| H1 | Resolve the open question above: identify or confirm the actual current onboarding path from a plain nanocoai/nanoclaw install to Isthmus | Not started |
| H2 | Verify that path handles a source install on nanoclaw v2.3.0 | Not started |
| H3 | Verify that path handles a source install on nanoclaw v2.4.0 (new — didn't exist as a migration source before this promotion) | Not started |
| H4 | Confirm it's acceptable and correctly handled for that path to carry a v2.3.0-sourced user forward to Isthmus's new v2.4.0-pinned baseline as part of migrating in (per this plan's stated goal) | Not started |

### Workstream I — Design Law closure (see the note above — not a foregone LAW-10)

| # | Task | Status |
|---|---|---|
| I1 | Once A–H are complete, write up the actually-executed methodology against `docs/design-laws.md`'s stated bar | Not started |
| I2 | Default expectation: a dated annotation under LAW-09 (mirroring the LAW-07 annotation precedent), not a new law number | Not started |
| I3 | Only if genuinely warranted: propose a new law, with the same evidence bar the declined 2026-08-30 LAW-10 proposal was held to | Not started |

## Promotion gate — do not move the pin until every box below is checked

- [ ] Workstream A complete and tested (E1, E2, A6)
- [ ] Workstream B: every row resolved, no "not yet assessed" remaining
- [ ] Workstream C: every finding closed or explicitly accepted and documented (C5)
- [ ] Workstream D: every file classified and reconciled
- [ ] Workstream E: full suite green on real CI, not local-only
- [ ] Workstream F: ADR(s) merged, compatibility docs current
- [ ] Workstream G: CI uplift assessed and applied where warranted
- [ ] Workstream H: migration continuity verified for both source versions
- [ ] Final re-validation: re-run this plan's Workstream B/C classification against the actual v2.4.0 tag one more time immediately before promoting, to catch anything that changed between planning and execution
- [ ] `docs/upstream-pin.json` + `docs/baseline.md` updated together with the closing ADR (G3)

## Open questions / risks (living list)

- Migration entry point for nanoclaw→Isthmus not yet confirmed to exist as a
  named, current skill (see "Migration continuity" section).
- `container-runner.ts`'s ~900-line diff combines two independently-landed
  upstream efforts (gateway-session-lifecycle, load-bearing; durable-host
  coordination, upstream-confirmed inert) — reconciling Isthmus's own
  modifications against this file needs to track which lines belong to
  which stream, not treat it as one block.
- Whether `internal/kernel`'s wire protocol needs a version bump (A2) is
  undetermined — affects rollout/compatibility sequencing if the answer is
  yes.
- The `channels`/`providers` sibling-branch auto-sync (merged 2026-09-25)
  is explicitly out of scope here, but note for later: once this pin moves,
  those branches' own upstream base line moves too, since they track
  nanocoai/nanoclaw's `channels`/`providers` branches independent of the
  tag pin. Not a blocker for this plan, but worth a cross-reference once
  this promotion lands.

## Changelog

- 2026-09-25 — Document created. Captures the planning-phase findings
  (consumed-contracts breaks, gateway subsystem discovery, OneCLI
  restructuring, migration-continuity open question, Design Law governance
  note) and the four-workstream (plus testing/docs/CI/migration/law-closure)
  structure. No implementation work started yet.

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

**This is the first applied instance of
`go-host/docs/upstream-promotion-playbook.md`** — a version-agnostic
procedure written directly out of this promotion's own findings, so the
*next* nanocoai/nanoclaw release doesn't require re-deriving this
methodology from scratch. That playbook document is the durable artifact;
this document is this specific promotion's findings and tracking against
it. `docs/design-laws.md`'s LAW-09 annotation records why the reusable
process lives there rather than as a new numbered law.

## Artifact index — where each kind of evidence actually lives

One line per artifact type, so nobody has to guess which document to open
or update:

| Evidence type | Lives at |
|---|---|
| Full changed-file diff inventory | `docs/promotion-v2.4.0-file-inventory.csv` (Workstream D0; schema below) |
| Security acceptance records (TS-only/bypass decisions) | `go-host/docs/compatibility-security-report.md` (Workstream C5) |
| Architectural decisions (ADRs) | `go-host/docs/ADR-0XX-*.md`, new for this promotion (Workstream F1) — exact numbers assigned when written |
| Consumed-contracts / compatibility ratings | `go-host/docs/version-compatibility.md` §1 and `go-host/docs/compatibility-matrix.md` (Workstream F2/F3) |
| CI evidence (which jobs cover what) | Named directly in each workstream's task rows below (e.g. A5/G1's `go-multi-container-live-docker`); consolidated into the final PR's evidence index (see "PR boundaries") |
| Migration rollback artifacts | `docs/promotion-v2.4.0-rollback-v2.3.0.md` / `-v2.4.0.md` (Workstream H2/H3) |
| Final pin update | `docs/upstream-pin.json` + `docs/baseline.md`'s "Stable Baseline" section (Workstream G4, final PR only) |
| This promotion's own status/tracking | This document — every workstream table, updated in place as work lands |

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
6. Only then moving the pin — gated on tests, docs, and CI passing **for
   real** (see "What 'green' means" and "What 'the gate passed' means"
   below — a Copilot PR review on this plan's own first draft correctly
   flagged that several gates were described in principle without being
   precise enough to stop an incomplete promotion from being declared
   complete; the sections below exist to close that).

## Non-goals

- **Resolved 2026-09-25, by direct founder decision — the scope bar is
  "genuinely part of v2.4.0," not "small enough to be convenient."** Several
  earlier entries in this document declined or deferred a piece of the
  diff on the reasoning that it was large, or that it needed its own
  architectural decision, treating those as reasons to leave it out of
  this promotion. That reasoning is corrected here: once Isthmus's pin
  says v2.4.0, an install is claiming to run v2.4.0 — a feature genuinely
  shipped in that release cannot be quietly missing because porting it was
  substantial. Size and complexity are inputs to *how carefully* a piece
  gets ported (more rigor, not less, matching the LAW-06/LAW-07 discipline
  every other workstream here already uses) — they are not grounds to
  decline it outright. This reopens, for real adoption rather than
  continued deferral: the provider-host-contract mount-composition rewrite
  (Workstream B's `container-runner.ts` finding), the community-portal
  runtime module (`src/modules/community-portal/`, adopted **with
  modification** — see its own entry below), and the reconcile-session
  stuck-container-detection system. It does NOT reopen decisions that were
  never about scope size in the first place: OneCLI staying core-baked
  instead of moving to a skill (C7) is Isthmus choosing a different
  *means* to the same end upstream's own default-gateway shape has, not a
  missing feature; Iron Proxy's `setup/gateways/` staying unbuilt is a
  sandbox verification limit (no Docker daemon can finish that build here
  yet), not a scope decision; and genuinely Isthmus-specific features
  upstream doesn't have at all (per-group timezone override, the whole Go
  kernel) were never upstream's scope to include in the first place.
- **Added 2026-09-25, scoping finding — the "provider-host-contract"
  language above refers to the *host-side* mount/file-composition
  contract only, not the *container-side* runtime contract.** A deep-scope
  pass (see C14) found these are two distinct, similarly-named
  abstractions: `src/provider-contracts/*` (host, mounts/files/skills —
  what this Non-goals entry's own text names, "Workstream B's
  `container-runner.ts` finding") vs.
  `container/agent-runner/src/provider-contracts/*` (container, execution
  policy/inference/memory/command-formatting — a ~2,579-line, 100%
  unported, genuinely separate effort). Only the host-side contract was
  reopened by the original decision above; whether the container-side one
  is also in scope was left as an open question for the founder.
- **Resolved 2026-09-26, by direct founder decision — the container-side
  provider-contracts port IS also in scope.** Reason given: the
  container-side provider files (`container/agent-runner/src/providers/
  claude.ts`, `provider-registry.ts`, `types.ts`, `factory.ts`, `mock.ts`)
  are confirmed **byte-identical to the pinned v2.3.0 baseline** — `git
  diff v2.3.0 -- <file>` is empty for every one of them — so unlike the
  host-side settings-content situation, there is no Isthmus-specific
  behavior a port would silently overwrite. Tracked as **C15**.
- This is not a general "catch up with upstream forever" project. LAW-09
  stays in force: one pinned baseline at a time, promoted deliberately.
- **Revised 2026-09-25 (ADR-030) — installing `add-iron-proxy` IS in
  scope**, on par with upstream v2.4.0's own gateway catalog (OneCLI as the
  default `GatewayProviderDefinition`, Iron Proxy as the second, opt-in
  one). This reverses this section's original stance, recorded when this
  plan was first drafted, under the belief that gateway-provider adoption
  was a separate, optional, later decision. It isn't — see ADR-030 for why.
  The `channels`/`providers` sibling-branch drift a *different* set of
  skills produces (Mattermost, Codex/OpenCode contract work — unrelated to
  gateways) remains a separate, already-tracked thread (see
  `.github/workflows/ci.yml`'s `sync-sibling-branches-*` jobs, merged
  2026-09-25) and is still out of this promotion's scope.
  Workstream G's CI-coverage requirement is unchanged and, if anything,
  more directly load-bearing now: whatever new privileged surface the pin
  introduces — the Go kernel's mount class and multi-container executor,
  the gateway-provider contract itself, any new seam call shape — must get
  equivalent CI coverage before the pin moves, the same way
  `wiring-registry-check` became a required gate when that surface grew.
- **Resolved 2026-09-25 ([ADR-030](../go-host/docs/ADR-030-gateway-adoption-and-multi-host-coordination.md), superseding
  [ADR-029](../go-host/docs/ADR-029-gateway-session-lifecycle-adoption.md))**
  — Isthmus adopts upstream's gateway-session-lifecycle behavior
  (lease-managed sessions, fail-closed shutdown, approval coordination) and
  its multi-host claim/lease coordination, checked against all nine design
  laws; see the ADR for the full reasoning and the new Workstream C7/C8/C9
  tasks this produced. No Go kernel changes result from either decision.
- **Added 2026-09-26, per external review — the file-inventory CSV (D0,
  `docs/promotion-v2.4.0-file-inventory.csv`) is the source of truth for
  what's actually in scope, not this section's prose.** Every scope
  re-open recorded above is reflected there as classified rows; if the two
  ever disagree, the CSV wins. Before the final pin-move PR, confirm the
  CSV's rows match the scope decisions this section records — zero rows
  whose classification contradicts a decision made here.

## PR boundaries

Implementation work under Workstreams A–H happens across however many PRs
the work naturally needs. The **final pin-move PR is a separate, later PR**
containing only: `docs/upstream-pin.json`, `docs/baseline.md`'s "Stable
Baseline" section, the closing ADR(s), and a **one-page evidence index**
(a short section or file in that same PR — reuse the "Promotion gate"
checklist below verbatim, with each line's blank checkbox replaced by a
direct link to the job run, ADR, or acceptance record that satisfies it;
no separate artifact needed beyond that filled-in list). It does not carry
implementation changes. This makes it possible to review "is the pin move
itself correct and fully gated" as its own, small, auditable change — not
buried inside a large mixed diff, and not requiring a reviewer to go
hunting across a dozen prior PRs to confirm each gate actually has
evidence behind it. Recommended grouping for the implementation PRs
themselves, though not a hard requirement the way the final-PR isolation
is:

1. Kernel capability implementation (Workstream A)
2. TypeScript seam reconciliation and bypass closure (Workstreams B, C)
3. Pure-TS reconciliation (Workstream D)
4. Tests / CI / docs (Workstreams E, F, G)
5. Migration continuity (Workstream H)
6. Final pin-move PR (this section)

## Why this promotion is not a routine version bump

The previous overlap review (ADR-017, 2026-09-03) found v2.3.0 still current
with "no new admission-checked feature work cleared yet." That is no longer
true. Concrete findings from this planning phase's own analysis, checked
against `version-compatibility.md` §1's consumed-contracts table and a full
`src/` diffstat (`54d9d9a5..v2.4.0`, 200 files changed, +17,801/-2,232) —
**this diffstat itself is a planning-phase estimate, not the reviewable
inventory Workstream D now requires; see that workstream for the actual
gating artifact**:

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
  just port. **This specific file move is also the concrete reason
  Workstream D now requires a machine-readable inventory rather than a
  prose diffstat claim** — it was missed by an earlier scan scoped only to
  `src/`, and a prose "the sweep was complete" statement would not have
  caught that miss either.
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

**Resolved 2026-09-25, ahead of the rest of this plan's execution** (the
user explicitly confirmed this direction rather than waiting for
Workstream I's close): no new law number. Instead:

- `docs/design-laws.md` now carries a **LAW-09 annotation** ("LAW-09,
  annotated: a repeatable promotion procedure"), mirroring the existing
  LAW-07 annotation's structure and evidence bar.
- `go-host/docs/upstream-promotion-playbook.md` is the actual reusable
  procedure the annotation points to — a version-agnostic, **eleven-step
  process (Steps 0–10)** extracted directly from this promotion's own
  findings, written so the *next* nanocoai/nanoclaw release doesn't
  require re-deriving this methodology from a long investigation the way
  this one did.

This document remains this specific promotion's findings and tracking; the
playbook is the durable artifact reused every future release. Workstream I
below is now "confirm the playbook holds up once this promotion is actually
executed," not "decide whether to write it."

## What "green" means (baseline test policy)

"Full suite green," used loosely elsewhere in this document, means
specifically:

- **Zero failures** in `pnpm exec vitest run`, `bun test`
  (`container/agent-runner`), and `go test -mod=vendor ./...` (including
  `-race`) — not "zero *new* failures relative to v2.3.0." If a
  pre-existing failure is discovered during this promotion, fix it or
  explicitly add it to a tracked baseline-exceptions list with an owner
  and a reason, before counting the suite as green. Do not let it ride
  silently under "that failure predates this PR."
- The same standard applies to lint (`go-lint`) and vulnerability/audit
  findings (`go-vulncheck`, `pnpm-audit`, `bun-audit`): zero net-new
  findings attributable to this promotion's changes. A finding that
  predates this promotion and is already tracked elsewhere does not block
  this promotion; a new one does.
- Any temporary exception must name an owner and an expiry/review date —
  see "Acceptance-record requirements" under Workstream C for the same
  discipline applied to accepted TS-only security decisions.

### Baseline test exceptions (tracked, not silently ignored)

| Failure | Where | Owner | Reason | Review |
|---|---|---|---|---|
| 77 `vitest` tests fail with `Command failed: git ...` / `xcode-select: note: no developer tools were found` | `scripts/update/transaction.coverage.test.ts`, `scripts/update/transaction.e2e.test.ts`, `scripts/update-skills.coverage.test.ts`, `scripts/update-skills.test.ts`, `src/upgrade-state.test.ts` (5 files) | This sandbox's environment owner (not a code owner — see Reason) | Sandbox-only: `/usr/bin` precedes `/usr/local/bin` on `PATH` here, so bare `git` resolves to the broken Xcode-CLT stub (`xcode-select: note: no developer tools were found`) instead of the real `/usr/local/bin/git` this project's own tooling otherwise uses explicitly. These five files are the only ones in the tree that shell out via a bare `execFileSync('git', ...)`/`spawnSync('git', ...)` instead of an injectable/absolute git path. Confirmed pre-existing and unrelated to this promotion: (a) `git log main..HEAD` for `feat/gateway-provider-seam` touches none of these 5 files — zero commits; (b) re-ran `src/upgrade-state.test.ts` directly against the unrelated, untouched `fix/egress-lockdown-kernel-network-wiring` branch in the separate main checkout and got the identical 3 failures with the identical stub message, confirming this is sandbox state, not branch state. Real CI (GitHub Actions) has a working `git`/no Xcode-CLT gap and is not expected to reproduce this — per this project's own standing guidance, GitHub Actions evidence is authoritative over local sandbox timing/tooling quirks for exactly this reason | Re-check on the next sandbox with a real `/usr/local/bin` ahead of `/usr/bin` on `PATH`, or the next time any of these 5 files' git-shelling helper is refactored to take an injectable git binary path (would close this structurally, matching the rest of the codebase's own `/usr/local/bin/git` convention) |

## What "the gate passed" means (CI evidence policy)

A CI job having **run** is not the same claim as a CI job having
**passed**, and neither is the same claim as that job being **required**
for merge. This plan uses these terms precisely from here on:

- **RUNNING** — the job executed, produced output. On its own, insufficient
  evidence for anything in this plan's promotion gate.
- **PASSED** — the job executed and its own success condition was met.
- **REQUIRED** — the job is in the `ci` gate's `needs:` list in
  `.github/workflows/ci.yml`, so a failure blocks merge. As of this
  writing, the existing live-Docker jobs (`go-ec05-live-docker`,
  `go-egress-live-docker`, `live-host-docker`) are `continue-on-error:
  true` and **not** in that `needs:` list — they report, they do not
  block. That is a deliberate, already-documented posture for those
  existing jobs (shared-runner Docker flakiness), and this plan does not
  propose changing it for them.
- **For this promotion's new behavior specifically** (multi-container
  sessions, private network creation, `gateway-trust` mounts): the
  live-Docker test proving this behavior (A5/E2) must be either REQUIRED,
  or the promotion gate must carry an explicit, named, human-reviewed
  exception recorded in this document — never silently satisfied by a
  report-only run. "The live-Docker job ran" does not by itself mean "the
  promotion was blocked if network isolation or multi-container behavior
  failed," and this plan does not treat it as though it does.
- Wherever this document says a test or CI job "passes" or is required, it
  means PASSED + REQUIRED (or the explicit documented exception), not
  RUNNING.

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
assumption to paper over. Workstream H below now defines concrete
acceptance tests, not just discovery statements — see that section.

## The workstreams

### Workstream A — Kernel port (new capability, belongs in Go)

Scope: `internal/mount`'s new admission rule, `internal/kernel`'s executor
gaining per-session private-network creation and multi-container spawn —
the two real consumed-contract breaks from "Why this promotion is not a
routine version bump," above.

| # | Task | Status |
|---|---|---|
| A1 | `internal/mount`: add `MountClass` value `gateway-trust`, `Policy.GatewayTrustRoot`, admission rule (ro-only, agent-role-allowed) mirroring `types.ts`'s new rule exactly | **Done** — `feat/mount-gateway-trust-class`, commit `5dd6ec64`. Ported class/policy field/admission rule/class-pinning in `ValidateSpec`, `ClassRequiredByPath`, `mountAllowed`, exact TS ordering (gateway-trust checked before identity-material). Also extended this package's own Go-only symlink-escape hardening to the new pinned root. Real bug found and fixed via LAW-06 (run existing suite before assuming correctness): `underRoot(path, "")` matches every absolute path, so unset `GatewayTrustRoot` silently misclassified every mount — fixed with an explicit empty-root fail-closed guard, verified via negative control (reverted the guard, confirmed 3 tests catch it, restored). Full `go-host` suite (`go build`, `go vet`, `gofmt`, `go test -race ./...`, all packages) green |
| A2 | `internal/kernel`: extend the wire payload (`CapabilityRequestPayload`) to carry `networkAccess` and multi-container `SessionSpec.containers`. Produce the **mixed-version compatibility matrix** below as part of this task, not just a yes/no bump decision | **Done** — `feat/mount-gateway-trust-class`, commit `41af3c5f`. Scope turned out narrower than estimated: `mount.Session.Containers` was already a slice (multi-container wire capacity predates this promotion), so the real gap was just `NetworkAccessIntent`/`NetworkAccessTarget` (new types in `internal/mount`) plus the `ProtocolVersion` bump. `internal/kernel/doc.go`'s own pre-existing versioning policy ("a version bump is required for any... shape change") already answered the bump question — not an open design call. Found and fixed a real regression: a pre-existing test hardcoded the literal `"v2"` as its "unsupported version" fixture (written when `ProtocolVersion` was `"v1"`); the bump silently made that fixture describe the current version. Fixed to derive from the live constant instead of a literal |
| A3 | `internal/kernel` executor: implement per-session `docker network create --internal` + auxiliary container spawn, mirroring upstream's `docker-driver.ts` logic in Go (no upstream Go source exists to port from — this is original implementation work, not translation) | **Done** — `feat/mount-gateway-trust-class`, commit `2a093034`. Full `Wake`/`Kill` port: per-session `--internal` network, `--read-only` auxiliary containers with their own bridge uplink, alias-based network connect, agent attached to the private network, ordered start (auxiliaries before agent), and full "allocate all or leave nothing" rollback on any failure — verified for real via a simulated agent-create failure after the auxiliary+network already succeeded, confirming both get torn down. `Kill` extended symmetrically (auxiliaries in reverse order, then network), sourced from `lifecycle.Registry` (`NewRuntimeWithNetwork`), never re-derived or caller-supplied. Full `go-host` suite green including `-race`. **Explicit scope gap, not silently dropped**: upstream's paired `status()` change (auxiliary health-checking — an agent reported "running" also confirms every auxiliary still is) has no equivalent concept in Go's kernel yet; not attempted, flagged for a later task |
| A4 | `internal/containerdefaults`: assess whether auxiliary/gateway-proxy containers need a different hardening posture than the agent container (they're not the agent, but they're not fully trusted either) | **Done (confirmed no further gap)** — directly re-checked the upstream diff line by line: `--read-only` (ported in A3) is the *only* role-based difference `containerCreateArgs` makes anywhere in upstream's own new code; `resourceArgs`/`hardeningArgs`/`userArgs` are applied identically to every container regardless of role, matching what Go's `containerCreateArgs` already does. Going further than upstream (e.g. a stricter seccomp profile for auxiliaries specifically) would be a genuine new hardening decision beyond "port v2.4.0" — noted as a possible future ADR, not attempted here without discussion |
| A5 | Live-Docker tests proving a multi-container session actually gets a working, correctly-isolated private network — real container membership and isolation, not just that the generated argv looks right. **Must be PASSED + REQUIRED per "What 'the gate passed' means," above** — a report-only run does not satisfy this row. This is the `go-multi-container-live-docker` job named under Workstream G; not "Done" until `ci.yml`'s `needs:` actually names it (G1's Definition of done) | **Done, verified against a real daemon.** 2026-09-25: a real Docker daemon became available in this sandbox. Ran `NANOCLAW_EC05_LIVE_DOCKER=1 go test -race ./...` (full `go-host` suite, not just this file) — **all packages pass**, `internal/kernel` included. Both A5 tests actually executed (not skipped) with their own `CONFIRMED LIVE` log lines: `TestLive_Wake_MultiContainerSession_PrivateNetworkIsolatesAgentAndReachesProxy` — "private network ncl-test-sess-1-private is Internal:true with exactly 2 members; agent ncl-test-sess-1 reaches auxiliary ncl-test-sess-1-proxy by alias but not the outside internet"; `TestLive_Wake_MultiContainerSession_AuxiliaryIsReadOnly` — the auxiliary's real read-only rootfs confirmed from inside it. The four pre-existing live-Docker suites (mount confinement, credential boundary, build-image, docker-socket adversarial) passed too — the whole trust kernel now has live-daemon evidence, not just unit tests against a fake CLI recorder. `go-multi-container-live-docker` stays wired into `ci.yml` as required (G1); this is strong local evidence it will pass there too, though the actual GitHub Actions run is still the formal gate. |
| A6 | Unit tests for the new mount class, table-driven, matching `internal/mount`'s existing style | **Done** — `feat/mount-gateway-trust-class`, commit `5dd6ec64`. Table-driven admission suite, a two-container test proving gateway-trust works on a non-agent (auxiliary proxy) role — the real Iron Proxy shape — the empty-root fail-closed regression test, and a `ResolveSymlinks` escape test |

**A2's mixed-version compatibility matrix — resolved, commit `41af3c5f`.**
`internal/kernel/server.go`'s dispatch already checks `env.Version` against
the exact live `ProtocolVersion` string *before* decoding any payload at
all — a pre-existing, deliberate property, not something this promotion
needed to add:

| TS host | Go kernel | Actual result (verified by test, `TestDispatch_OldV1HostAgainstNewKernel_RejectedNotMisparsed`) |
|---|---|---|
| old (`v1`, pre-`networkAccess`) | old (`v1`) | Supported (today's baseline, unaffected) |
| new (`v2`, sends `networkAccess`) | new (`v2`) | Supported (this promotion's target) |
| old (`v1`) | new (`v2`) | **Explicitly rejected** — `ErrUnsupportedVersion`, detail names both versions, checked before payload decode |
| new (`v2`) | old (`v1`) | **Explicitly rejected**, same mechanism, symmetric |

Answers to the questions this row originally posed:

- **Independent rollback**: no — an exact-string version gate means a
  mismatched pair simply refuses to talk at all, in either direction.
  This is the safe property, not a gap: neither side can silently
  misinterpret the other's payload shape.
- **Unknown-field tolerance**: not attempted and not needed — the version
  string itself is the compatibility boundary, checked ahead of any
  payload parsing.
- **Was `networkAccess` optional during rollout**: no — moot given the
  above; a v2 kernel only ever talks to a v2 host, which always sends it.
- **Bump required?** Yes, unconditionally, per `internal/kernel/doc.go`'s
  own pre-existing versioning policy — this was never actually an open
  design question, just an unexecuted one.
- **Operator-facing failure mode**: a clear, explicit error naming both
  versions (`"kernel speaks v2, got v1"`) — not a confusing or silent
  failure. No further fix needed here.

Recorded here for now; folds into the closing ADR (F1) as that gets
written.

### Workstream B — Seam audit (TypeScript call-sites into the kernel)

Scope: the 18 files that call into or compose what the kernel receives.
Already characterized from the "consumed contracts" pass; this workstream
finishes the *call-sequencing and error-handling* half, which that pass
didn't cover (it only checked data shapes).

| File | Data-shape impact (from prior pass) | Call-sequencing impact | Status |
|---|---|---|---|
| `container-runner.ts` | **Revised, larger than the prior pass found** — the ~900-line diff is not two concerns but (at least) **three**: (1) gateway-session-lifecycle wrapping (`claimSessionRun`, `ensureGatewaySession`, `stopGatewaySessionsForUnavailability`, `watchGatewayAvailability`, `abortGatewaySessionObservers` — load-bearing, lease-managed), (2) durable-host shadow-writes (upstream-confirmed inert, same as the `request-wake.ts` row), and (3) **newly found**: a "provider host contract" mount-composition rewrite in `buildMounts` (`getProviderHostContract`, `realizeProviderSpawnSurfaces`, `contract.stateVolumes`/`.skillViews`/`.skillBackings`) that replaces the old `providerProvidesAgentSurfaces`/`providerContribution.mounts` callback pattern with a declarative per-provider mount contract — **this is orthogonal to gateway-trust entirely**, a separate provider-abstraction upgrade affecting how *every* provider's mounts (not just gateway ones) get composed | `composeSessionSpec`'s own diff is small and directly gateway-seam-relevant: `labels: {...gateway.labels, ...}`, `containers: [agent, ...(gateway.containers ?? [])]`, new `networkAccess: gateway.networkAccess` field — this is the actual production call site `drivers/types.ts`'s new `SessionSpec.networkAccess`/gateway-trust support exists to receive, currently unreachable because nothing populates a non-empty `gateway` object (confirms the "composer doesn't yet build gateway-provider specs" premise Workstream A/B's TS changes were built on) | **(3) resolved — see C14, done 2026-09-26.** The provider-host-contract mount-composition rewrite this row flagged as needing its own architectural decision got exactly that (the scope-policy decision in Non-goals, then C14's six-step implementation): `buildMounts` now composes Claude's mounts from a real registered contract, all six steps tested and committed. (1) gateway-session-lifecycle wrapping remains genuinely unresolved — still recommend a dedicated follow-on effort of its own, gated on its own ADR, since it's an independent concern from the mount-composition question this row originally conflated it with |
| `drivers/docker-driver.ts` | Major — see Workstream A | N/A, IS the seam | **Done** (commit `79465865`) — `capabilities().auxiliaryContainers` flipped to `true`; the `prepare()` refusal for non-agent roles removed (Go's `Wake`/A3 now realizes every container in the spec, so the TS-side refusal was a stale backstop); `assertMountSourcesExist` extended from `agent.mounts` to every container's mounts |
| `drivers/types.ts` | Major — see Workstream A | N/A | **Done** (commit `79465865`) — `MountClass` gained `'gateway-trust'`; added `NetworkAccessTarget`/`NetworkAccessIntent`, mirroring the Go/wire types field-for-field; `SessionSpec.networkAccess` added as **optional** (deliberate divergence from Go's required field — this tree's composer doesn't yet build gateway-provider specs, documented inline); `MountPolicy.gatewayTrustRoot` added as required, with the same empty-root fail-closed guard A1 needed on the Go side ported into `classRequiredByPath`/`mountAllowed`; ro-only admission rule added to `validateSpec` |
| `drivers/index.ts` | Minor (wiring) | Not yet assessed | **Done** (commit `79465865`) — `mountPolicy()` supplies a real `gatewayTrustRoot` default (`NANOCLAW_GATEWAY_TRUST_ROOT` env override, mirroring `materialsRoot`'s own pattern); `SETTINGS` allowlist updated |
| `drivers/session-events.ts` | Minor | Assessed — upstream's 2-line addition wires an optional `driver.reconcileNetworkAccess` passthrough onto `withSessionEvents`'s wrapper, mirroring the existing `ensureReady`/`reapResidue` optional-method pattern | **Deferred to Workstream C** — `reconcileNetworkAccess` is part of upstream's durable, lease-managed gateway-session-lifecycle machinery, which the plan's own Non-goals section explicitly leaves to Workstream C's ADR ("not scoped to decide... whether Isthmus adopts upstream's full gateway-session-lifecycle behavior... verbatim, vs. a narrower Isthmus-specific design"). No `SessionDriver` in this tree declares `reconcileNetworkAccess` today, so the passthrough is dead code if ported now with nothing to call — porting the wiring ahead of the C decision would be scope creep, not compatibility work. Zero TS compile/test impact either way (optional method, present or absent) |
| `drivers/spec-fixture.ts` | Test fixture only | N/A | **Done** (commit `79465865`) — `FIXTURE_POLICY` carries `gatewayTrustRoot` |
| `drivers/conformance.test.ts`, `docker-driver.test.ts`, `driver-selection.test.ts` | Test files — compare against Isthmus's own equivalents for coverage gaps | Not yet assessed | `conformance.test.ts` **done** (commit `79465865`) — capability assertion flipped to `true`, stale "refuses whole" comments corrected; the file's own conditional multi-container contract test (`a driver that does not manage auxiliary containers refuses the spec whole`) already covered the realize-them path once the capability flipped, no test code change needed there. `docker-driver.test.ts`/`driver-selection.test.ts` checked — neither references the removed refusal path, no change needed |
| `kernel/client.ts`, `kernel/protocol.ts` | Isthmus-only files (don't exist upstream) — confirm they still model the wire contract correctly once A2 lands | N/A | **Done** (commit `79465865`) — `protocol.ts`: `KERNEL_PROTOCOL_VERSION` bumped to `'v2'` alongside Go's own bump (A2, commit `41af3c5f`), `WireMountSpec.class` gained `'gateway-trust'`, added `WireNetworkAccessTarget`/`WireNetworkAccessIntent`, `WireSession.networkAccess?`. `client.ts`: added `toWireNetworkAccessIntent`, threaded `networkAccess` through `toWireSession` via the file's existing optional-field spread pattern. Full `pnpm exec tsc --noEmit` + `pnpm test` (3972 tests) green after these changes |
| `cli/dispatch.ts`, `cli/guard.ts`, `cli/registry.ts` | Clean (zero commits in range) | Clean | Done — no change needed |
| `cli/resources/groups.ts` | Assessed (48-line diff) — three unrelated concerns bundled: (1) `wakeContainer`→`requestWake(s, 'cli')` in the restart handler (2) a new `--speed` inference-tier flag on `groups config update`, reading `provider-contracts/registry.ts`'s declared tiers — a genuine new feature, unrelated to the gateway/kernel work (3) a new `connect` custom operation calling `connectGatewayAccount` (new core file `src/gateway-connections.ts`, confirmed NOT under `.claude/skills/add-iron-proxy/` — core infra, not the optional skill) | (1) is the only kernel-seam-relevant piece — see request-wake row below, inert | **Kernel-seam piece: clean, no change needed.** (2) and (3) are pure-TS feature additions with zero kernel/mount/wire-protocol involvement — out of Workstream B's scope entirely; **flagged for Workstream D's file inventory** (D0/D1) as two real, unclassified upstream additions Isthmus hasn't ported, neither gated on this promotion's kernel-compatibility goal |
| `self-mod/apply.ts` | Clean — shadow-write + wake-routing only, upstream's own commit message: "byte-equivalent by construction" | Clean | Done — no change needed |
| `modules/agent-to-agent/agent-route.ts`, `create-agent.ts` | Assessed — both files' only change is `wakeContainer(fresh)` → `requestWake(fresh, '<reason>')` | Clean — confirmed by reading upstream's `src/request-wake.ts` directly: `requestWake` is `_reason`-parameter-ignoring pure delegation to `wakeContainer` ("byte-equivalent... MUST stay that way until the durable rows become authoritative: no logging, no signal writes, no behavior" — upstream's own doc comment), the same inert refactor already recorded for the `host-sweep.ts`/`reconcile.ts`/`request-wake.ts` row below | Done — no change needed for kernel-compatibility; **flagged for Workstream D** as a real but behavior-inert pure-TS refactor Isthmus hasn't adopted (adopting it is a rename, not a fix) |
| `modules/kernel-supervisor/index.ts` | N/A — confirmed this file has no upstream equivalent at either v2.3.0 or v2.4.0 (`git show v2.4.0:src/modules/kernel-supervisor/index.ts` fails); it exists only because Isthmus's own Go kernel (EC-02) does. Checked for any version-sensitive logic (protocol version strings, wire-shape assumptions) — none found; it only supervises the `nanogo serve` process's lifecycle | N/A | Done — no change needed, confirmed Isthmus-only |
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
| C0 | Record, via ADR, whether/how Isthmus adopts upstream's gateway-session-lifecycle behavior | **Done, revised** — [ADR-029](../go-host/docs/ADR-029-gateway-session-lifecycle-adoption.md) (2026-09-25) decided to decline/defer; superseded the same day by [ADR-030](../go-host/docs/ADR-030-gateway-adoption-and-multi-host-coordination.md) after two factual corrections (the approval subsystem is not duplicative; gateway-provider selection is mandatory for a ported v2.4.0 host to start) and confirmation that multi-tenant/multi-replica cloud hosting is a real near-term direction. **Decision: adopt all of it** — OneCLI restructured into `GatewayProviderDefinition` (C7), Iron Proxy installed as the second catalogued option (C8), multi-host claim/lease coordination ported in TypeScript (C9). Zero Go kernel changes under either ADR: the kernel admits only the mount/network shape a contribution produces, unchanged since Workstream A/B, one kernel per node regardless of how many TS replicas run. |
| C1 | Trace `ensureGatewaySession`/`stopGatewaySessionsForUnavailability` (`container-runner.ts`) end to end: can a session reach the gateway, or keep reaching it after the gateway becomes unavailable, through any path that skips this function? | **Done, traced against the actual code (not the upstream names, which C7 never ported verbatim).** Isthmus's C7 has no `ensureGatewaySession`/`stopGatewaySessionsForUnavailability` wrapper functions at all — `spawnContainer` (`container-runner.ts`) calls `getGatewayProvider().sessions.ensure(...)` directly, once, inline. Confirmed by grep that `driver.prepare(spec)` has exactly two call sites in the whole tree: `spawnContainer` itself, and `drivers/session-events.ts`'s `withSessionEvents` wrapper — read in full, it is a transparent pass-through (`prepare: async (spec) => { const handle = await driver.prepare(spec); hub.trackPrepared(handle); return new HubHandle(handle, hub); }`) that only adds terminal-event tracking around whatever spec `spawnContainer` already built; it does not construct or rebuild a spec itself. No code path composes a `SessionSpec` or reaches `driver.prepare` without first going through `spawnContainer`'s single `sessions.ensure()` call. **Real gap found, but it's the one already named in C7's own status row, not a new one**: the returned `lease.release`/`lease.onUnavailable` hooks are never called anywhere in `container-runner.ts` (confirmed: zero references outside the inline comment noting the deferral) — a session that starts while the gateway is reachable is not un-spawned if the gateway later goes unavailable mid-session. Not a bypass today: OneCLI's own `sessions.ensure` (`onecli.ts`) returns a lease with no `release`/`onUnavailable` fields at all, so there is nothing being skipped — the hooks don't exist on the one active provider. This becomes a real, must-close item the moment C8's Iron Proxy (which needs them) goes live; tracked there, not re-opened here as a fresh finding |
| C2 | Trace `permitsConfiguredGatewayRead` (`gateway-read-policy.ts`): is the `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` env-var allowlist the *only* gate on read-only gateway destinations, and is it consulted on every code path that makes an outbound gateway request? | **Not applicable — confirmed by direct search, not assumption.** `gateway-read-policy.ts`, `permitsConfiguredGatewayRead`, and `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` do not exist anywhere in Isthmus's tree (`grep -rn` across `src/` returns zero matches). C7 never ported upstream's read-only-gateway-destination allowlist feature — OneCLI's own contribution path (`contributionFromArgs`) has no concept of a "read-only destination" distinct from any other mount/env it contributes. There is currently no gate to audit because the feature it would gate was not adopted. This is a real, named gap in porting coverage (distinct from a security bypass — a bypass requires the guarded capability to exist first), worth a line in Workstream D's inventory rather than silently closing this row as done; revisit if/when Iron Proxy (C8) or any future gateway actually introduces a read-only-destination concept |
| C3 | Confirm the OneCLI-as-skill restructuring doesn't change *how* credentials reach a container — still exclusively via a kernel-admitted `gateway-trust`/`identity-material` mount, never a new env-var or volume path the kernel doesn't validate | **Done** — confirmed by direct code trace, not inference, following C7's own restructuring: `onecli.ts`'s `contributionFromArgs` parses the SDK's argv into a typed `GatewayContribution` and **fails closed on any flag it doesn't recognize** (`onecli.test.ts`'s own "refuses argv outside the grammar" case). That contribution's `mounts` merge into `composeSessionSpec`'s output and pass through `validateSpec` — the same admission gate every other mount goes through, no shortcut — before `driver.prepare` ever sees the spec. Its `env` merges into `contributedEnv`, which `validateSpec` independently runs through `looksLikeCredential()` — "Credential VALUES have no sanctioned channel, from anyone: real material rides mounts by reference" (the check's own comment, `drivers/types.ts`). Isthmus never moved OneCLI to a skill (C7 kept it core, matching upstream's own default-gateway shape) so the literal premise ("skill restructuring") doesn't apply, but the invariant it was checking for holds. |
| C4 | Full re-sweep of the 21 gateway files plus a fresh repo-wide grep (not scoped to `src/` this time — check `container/agent-runner/src/` and `setup/` too) for new `docker`/`exec`/credential-handling code introduced anywhere in the v2.4.0 diff that this plan hasn't already accounted for. Cross-reference against the Workstream D file inventory once it exists, rather than re-deriving file lists independently | **Done, one substantial finding.** Swept the full v2.4.0 diff (`src/`, `container/agent-runner/src/`, `setup/`) for process-spawning and credential-shaped code. Nothing new beyond what's already tracked (C7/C8/C9, the sibling-branch-tracked skills) — **except `src/community-portal/`, entirely new, ~2,990 lines, not previously mentioned anywhere in this plan.** It is a client for `https://portal.nanoclaw.dev` — an **upstream-operated hosted service** ("NanoClaw community portal") — generating a per-machine ECDSA P-256 device identity key (`~/.config/nanoclaw/device-key.json`, self-generated, doesn't leave the machine, so not itself a credential-leak vector), registering the device with the portal, and running a detached worker (`slack-job.ts`, uses `child_process.spawn`) for a "managed Slack app install" flow. **Original recommendation (superseded): do not adopt as part of this promotion.** Reasoning at the time: a product/trust decision (does an Isthmus install register a device identity with and phone home to nanocoai's own hosted infrastructure) with no bearing on kernel compatibility. Flagged for the founder rather than silently porting or silently ignoring it. **Follow-up, in response to a direct question**: would an existing nanoclaw user's portal login survive migrating to Isthmus? Checked `device-client.ts` directly: the identity (`~/.config/nanoclaw/account.json`, `device-key.json`) lives at a machine-level config path H1's `isthmus.sh` migration never touches, and every portal request carries only `authorization: Bearer <token>` plus a device-proof header — no client-version or product-identifying header anywhere in the open-source client. Login would very likely keep working unchanged on the client side; the one unresolvable unknown is nanocoai's own closed-source server-side policy toward fork traffic. **Superseded 2026-09-25 by direct founder decision: adopt it — it's a real, shipped part of nanocoai/nanoclaw's own v2.4.0, matching this promotion's stated goal of adopting new upstream features, not just absorbing them passively.** Two corrections that shaped the decision: (1) it is not redundant with an independent Isthmus feature — `docs/hardened-image.md`'s existing hardened-image opt-in *is* the same Echo/nanocoai hosted service the portal's `echo` perk offers, so Isthmus already depends on part of this ecosystem; (2) the real scope is not purely additive — `setup/registry-login.ts` already exists in Isthmus but in a narrower shape than v2.4.0's, so porting means upgrading a live, already-depended-on file, not just adding new ones. Full reasoning, laws check, and the resulting tasks: [ADR-031](../go-host/docs/ADR-031-community-portal-adoption.md), new tasks **C10**/**C11** below. |
| C5 | For each finding: either close it (route through the kernel, or an existing guard) or produce a full **acceptance record** (see below) — never a bare "accepted and documented" note | **Done — zero acceptance records needed, every finding closed outright.** Final accounting across all of Workstream C: C1 (no bypass found), C2 (feature never ported, nothing to audit), C3 (no gap, credentials stay kernel-admitted), C4 (community-portal — resolved by adoption decision, ADR-031, not an accepted bypass), C6 Findings 1–3 (all three fixed directly, not accepted). No finding in this promotion ever reached "real gap, kernel enforcement not feasible, must be accepted" — the acceptance-record format above is fully specified and ready for a future promotion that needs it, but this one didn't produce a candidate for it. |
| C6 | Security-focused review pass using the `code-review` skill, scoped specifically to trust-boundary findings on this diff (not general bug-hunting) | **Done — three findings, two fixed, one flagged.** The `code-review`/`security-review` skills themselves couldn't run (their own preflight shells out to bare `git`, which is broken in this environment — see the machine-restart/Xcode-CLT thread earlier this session); did the review directly instead, with the same adversarial trust-boundary brief. Every finding verified against the actual code (not doc comments) before being recorded — several earlier findings this session were specifically caught by NOT trusting a comment at face value, so the same discipline applied here. **Finding 1 (fixed, commit `480b5f83`)**: `internal/kernel/naming.go`'s `LabelsForKey` let a gateway-composed `ContainerSpec.labels` (`GatewayContribution.containers`, unvalidated by `mount.ValidateSpec` by design — confirmed directly: its own comment states Labels is a realization-only field) override the four canonical adoption labels (`nanoclaw-install/-group/-session/-role`) that `listSessions`/`watchSessions`/the wake-time collision check trust as ground truth across every install sharing a Docker daemon. Latent — neither OneCLI nor Iron Proxy currently populate `.containers[].labels` — but would become a real cross-install impersonation vector the moment a gateway that composes auxiliary containers goes live. Fixed by applying the canonical four last, unconditionally; verified via `git stash`-based negative control (new regression test fails with the exact expected message against the pre-fix code, passes after). Full `go-host` suite green including `-race`. **Finding 2 (fixed, commit `1de80602`)**: `GatewayApprovalRequest.approverUserId` ("exact verified channel identity selected by the gateway policy") narrowed who got notified but was never written to the persisted row's `approver_user_id` column, so `isAuthorizedApprovalClick` fell through to `hasAdminPrivilege` and let any admin for the group resolve a decision the gateway meant to restrict to one specific identity — not an unauthenticated-actor bypass (the fallback set is still legitimately privileged), but a silent widening of who decides. Latent for the same reason as Finding 1 (neither current provider sets `approverUserId`). Fixed by threading `request.approverUserId` through to `createPendingApproval`, defaulting to `null` — deliberately NOT `resolvedTarget.userId`, which would have wrongly narrowed the common unnamed-approver case down to whichever one admin happened to receive delivery (a real correctness trap the review's own suggested fix contained; caught by tracing `resolvedTarget`'s construction before applying it). New tests drive `decide()` directly via a stub gateway (OneCLI's own translation never reaches this branch), verified via the same negative-control discipline. `tsc --noEmit` clean. **Finding 3 (fixed, commit `66287909`)**: OneCLI's `allowlisted-extra`-class provider mounts (`contributionFromArgs`, `onecli.ts`) carried no host-path restriction at all — the class is unconditionally admitted by both `mount.mountAllowed` implementations, by design ("vetted upstream"), and gateway-origin mounts skip the operator's own `validateAdditionalMounts`/allowlist vetting that operator-supplied mounts of the same class go through. `contributionFromArgs` failed closed on any argv shape outside its `-e K=V`/`-v host:container[:ro]` grammar, but did not restrict *which* host paths a `-v` could name — a compromised or buggy `@onecli-sh/sdk` package or remote OneCLI service could have returned a mount reaching arbitrary host paths (e.g. `~/.ssh`), admitted read-write with no further check. Fixed on explicit founder direction with a grammar-level allowlist rather than a new `MountClass`: read the SDK's actual compiled source directly (not inferred) and found it writes to exactly three fixed locations under `os.tmpdir()` — `onecli-proxy-ca.pem`, `onecli-combined-ca.pem`, `onecli-stubs/onecli-stub-<basename>`. `contributionFromArgs` now refuses any `-v` mount whose `path.resolve`d host path isn't one of those. New test suite (a disallowed path, near-miss sibling/wrong-prefix/traversal attempts, the legitimate paths), verified via `git stash`-based negative control, full `pnpm test` green apart from the pre-existing unrelated bare-`git` environment failures. No findings in: the gateway contract's env/mounts merge path generally (funnels through the same admission as every other contributor); OneCLI's fail-closed argv parsing itself; Iron Proxy's mount classes (correctly restricted) or its approval bridge (fail-closed on every path checked, including a TOCTOU-style identity re-check at decision-settle time); the coordinator's auth/TOCTOU/fail-open behavior beyond Finding 2; the C9 claim/lease CAS mechanism (a live peer's claim cannot be stolen; a network-partition split-brain is an inherent, already-accepted property of lease-based coordination without resource fencing, not a kernel-admission bypass); `provider-contracts/registry.ts`'s static, frozen, hardcoded domain registrations. |
| C7 | **New (ADR-030), sequence first — load-bearing.** Restructure `src/gateway-providers/onecli.ts`/`onecli-approvals.ts` into upstream's `GatewayProviderDefinition` contract (`sessions.ensure`/`approvals.subscribe`, matching `gateway.json`'s `"kind": "onecli", "default": true`). Without this, a ported v2.4.0 `container-runner.ts` refuses to start — there is no implicit default and no open-egress fallback. Stays 100% TypeScript; ports session identity and credential-injection logic Isthmus already has, doesn't invent new logic | **Done** (`feat/gateway-provider-seam`, commit `0bb51506`) — `gateway-provider-registry.ts` widened to the full contract; new `gateway-approval-coordinator.ts` extracts the generic approval flow out of the old OneCLI-only module (approver resolution, delivery, the `pending_approvals` row, card, click, expiry, sweep) so C8's Iron Proxy reuses it rather than re-implementing its own; `onecli.ts` implements `sessions.ensure`/`approvals.subscribe`, wrapping the SDK's callback-based bridge (no native "ended" event) into the generic `subscribe(decide, signal): Promise<void>` shape; `container-runner.ts`'s spawn path threads `networkAccess`/`labels` into `composeSessionSpec`. Existing test suite (`onecli-approvals.coverage.test.ts`, 682 lines) ported behavior-for-behavior — caught two real regressions before they shipped: the card's displayed agent name must come from a `getAgentGroup()` lookup, not the SDK's own `agent.name`, and a request with no external id is "no known scope" (falls through to the global-admin approver path), not a hard validation failure. `pnpm exec tsc --noEmit` clean; full `pnpm test` green (3972 tests); `eslint` clean except pre-existing `no-catch-all` warnings. Remaining: threading the lease's `release`/`onUnavailable` lifecycle through `ActiveSessionRuntime` once C8 gives a provider that actually uses them |
| C8 | **New (ADR-030), sequence third.** Install `/add-iron-proxy` on par with upstream v2.4.0's own catalog: the provider payload, the approval-bridge middleware, the local Docker-built proxy + Iron Control console, `NANOCLAW_IRON_PROXY_PORT`/`NANOCLAW_IRON_CONTROL_PORT` wiring, the gRPC bridge dependencies. First real consumer of Workstream A's `gateway-trust` mount class and multi-container/`networkAccess` executor | **Done (2026-09-26), `feat/gateway-provider-seam` @ `9a72889e` — installed and verified end-to-end, not just cataloged.** Builds on the earlier partial work (`c2b26b83` skill files, `7d45ffc5` narrow `provider-contracts/` port, both still accurate — see below) by actually applying the skill's remaining directives: provider payload copy, `installed.ts` registration (adapted to Isthmus's two-step kind+factory registry, C7, from upstream's single-argument form), the `@grpc/grpc-js`/`@grpc/proto-loader` deps, and — the part that was genuinely blocked before (needed a real Docker daemon with real disk headroom) — `setup.ts --with-control`, which built the pinned Iron Proxy + NanoClaw approval-front image from source and started Iron Control (Rails console) + its own Postgres + the managed proxy. Verified against real, running infrastructure, not a green exit code alone: `docker ps` showed all three new containers healthy, and the proxy's own startup logs showed a real config received from the control plane (by hash), the upstream cloud-metadata/link-local deny-list active, and every listener (HTTP/HTTPS/tunnel/metrics) up. `NANOCLAW_GATEWAY_PROVIDER` was not force-set by this — OneCLI remains the active gateway, matching the original "catalogued, not forced on" scope; the pre-existing `onecli`/`onecli-postgres-1` containers stayed healthy throughout, confirmed both before and after.<br><br>**Applying the skill for real surfaced genuine gaps beyond its own 38 files — all fixed directly, none worked around:** (1) `gateway-compat/onecli-summary/` (a pinned Rust compatibility helper the front-proxy build needs) had never been ported into Isthmus at all — a real D-workstream inventory gap (confirmed absent from the file-inventory CSV too), ported verbatim from the real `v2.4.0` tag. (2) `vitest.config.ts` was missing upstream's own v2.4.0 include pattern for a gateway skill's own `scripts/**/*.test.ts` (tested where they live, not copied into `src/`) — without it, 8 of the Iron Proxy skill's own test files were silently never executed by `vitest run`, "passing" only by never running. (3) `setup/set-env.ts`'s `upsertEnvVar`/`src/env.ts`'s `readEnvFile` were both missing upstream's own v2.4.0 `projectRoot` parameter (needed by the auth-resume-after-interrupted-grant flow to target a specific install root) — ported both, plus their real upstream test files, neither of which existed in Isthmus before this. (4) `build-managed-proxy.ts`'s cross-check against `.claude/skills/add-onecli/versions.json` has no Isthmus equivalent — OneCLI here is a bring-your-own external gateway (`CLAUDE.md`'s own description), not a skill-provisioned one the way upstream's is — removed with the reasoning documented inline, not silently dropped.<br><br>**A real regression was found and fixed via LAW-06 discipline** (ran the existing suite before assuming correctness): registering `iron-proxy.ts` pulls in `@grpc/grpc-js`/`@grpc/proto-loader`, real native-binding dependencies with a real one-time module-load cost. `host-sweep.ts`'s `sweep()` dynamically imports `modules/approvals/index.js` as the last step before rescheduling itself on every tick — once that import transitively touches the gateway registry, the *first* `sweep()` call in a test process absorbs the load cost, its own reschedule lands after that test's own `vi.waitFor` window already closed, and the delayed callback shows up as a spurious extra count in whichever test runs next. Fixed in all three affected files (`host-sweep-incarnation-gate.test.ts`, `host-sweep.coverage.test.ts`, `host-sweep-grace.test.ts`) by warming up that same dynamic import in a `beforeAll` — paying the one-time cost outside any test's timed window, not by weakening what these tests actually assert. Verified via negative control (reverted the registration, confirmed the failure reproduces exactly as first found, restored) and 3x repeated runs per fixed file after the fix.<br><br>Full suite: 4232 pass (up from 4230), identical 5-file/77-test baseline exception as already tracked under E5 (pre-existing, unrelated bare-`git` sandbox issue) — no new failures. `tsc --noEmit`/`pnpm run build`/`eslint` all clean. The skill's own specified validate command (7 test files, 105 assertions) passes in full. `src/provider-contracts/` stays the earlier narrow port (`7d45ffc5`) — still correct, nothing in this pass needed `stateVolumes`/`skillBackings`/`skillViews`/`files`.<br><br>**One real, tracked follow-up, not silently dropped**: C1's row named exactly this — "the one real gap — `lease.release`/`lease.onUnavailable` never called anywhere... becomes a must-close item once C8's Iron Proxy needs them." Checked directly now that Iron Proxy exists: `lease.release` *is* called (`gateway-session-lifecycle.ts:26`, `await control.lease.release?.(event)`), but `iron-proxy.ts` declares `onUnavailable` (line 458) and nothing in core (`gateway-session-lifecycle.ts`) ever registers for it — a real, half-wired gap now that a real `'default'`-trigger, session-lifecycle-aware gateway exists to need it. Not fixed in this pass (out of C8's own scope — "install and verify the skill," not "wire a session-lifecycle consumer for a hook nothing needed until now") — flagged here as the concrete next item C1 anticipated, not left implicit.
**`setup/gateways/` still not built** — upstream's generic gateway-picker/credential-storage UI, needed only for `scripts/setup.ts`'s own interactive install flow, which itself needs a real Docker daemon to finish (building the proxy image, starting Iron Control + Postgres) — unverifiable in this sandbox regardless. Iron Proxy stays catalogued-but-not-runnable until that infrastructure exists and there's a real daemon to prove it against; not a blocker for anything else in this promotion. |
| C9 | **New (ADR-030), sequence second — independent of C7/C8.** Port the multi-host claim/lease coordination (`db/coordination.ts`, `host-instance.ts`, the `session_claims`/`host_instances` tables and migration) in TypeScript, including `availability.publish`/`.read` for the separated-process case. No Go kernel changes — coordination happens over the existing central DB; each host process still only ever talks to its own local kernel once it wins the claim | **Done** (`feat/gateway-provider-seam`, commit `e52c34a5`) — ported `db/coordination.ts`, `host-instance.ts`, migration 024, correcting upstream's own stale "shadow state" doc comments (the claim-acquisition read genuinely gates spawn behavior, confirmed by reading `container-runner.ts`'s own `claimSessionRun` directly). Wired into `container-runner.ts`: claim-before-spawn with release-on-any-failure through `driver.prepare`, and claim-fenced adoption. Host-instance lease started/stopped in `index.ts`'s startup/shutdown sequence. Tests: `coordination.ts`/`host-instance.ts` ported from upstream near-verbatim; new `container-runner.claims.test.ts` (real `DockerSessionDriver` + a real `RecordingKernel` fake-server) proves refusal-when-live-peer-holds-claim, takeover-of-a-dead-claim, normal claim-and-spawn, and release-on-`driver.prepare`-failure — narrower than upstream's own claims test, which assumes the fuller gateway-lease-lifecycle wrapping C7 deliberately deferred. `availability.publish`/`.read` **not yet wired** — that's a `GatewayProviderDefinition` capability a provider declares (see C7), and OneCLI doesn't; revisit once C8 gives a provider that needs it. `pnpm exec tsc --noEmit` clean; full `pnpm test` green (3987 tests, up from 3972); `eslint` clean except pre-existing `no-catch-all` warnings. |
| C10 | **New ([ADR-031](../go-host/docs/ADR-031-community-portal-adoption.md)), sequence first — load-bearing for C11.** Upgrade `setup/registry-login.ts` from its current narrow shape (`AccountCredential`/`run` only) to v2.4.0's fuller device-flow shape (`startDeviceFlow`, `finishDeviceFlow`, `LoginError`, `DeviceFlow`) that `setup/portal.ts` depends on. LAW-06 obligation: characterize the current exported behavior with tests before extending it — the existing hardened-image sign-in flow (`docs/hardened-image.md`) already depends on this file and must not regress | **Done** (`feat/gateway-provider-seam`, commit `f04f3593`) — turned out to be mostly an export, not a port: Isthmus's existing `requestDeviceAuthorization`/`pollForIdpToken`/`probeBroker`/`LoginError`/`IdpConfig` already matched v2.4.0 almost function-for-function (same RFC 8628 handling, same error codes). Exported `LoginError`/`IdpConfig` (were private); extracted `notABroker()` from `run()`'s own inline throw so the new `startDeviceFlow` reuses the identical wording, verified behavior-preserving via a characterization test written and run against the pre-refactor code first (LAW-06); added `DeviceFlow`/`startDeviceFlow`/`finishDeviceFlow` as thin wrappers recombining the existing primitives, matching v2.4.0's split exactly. New tests drive both directly, covering not-a-broker/no-idp refusals, a poll-then-approve happy path, and a declined sign-in. `pnpm exec tsc --noEmit` clean; full `pnpm test` green apart from the pre-existing bare-`git` environment failures |
| C11 | **New (ADR-031), sequence second — depends on C10.** Port `src/community-portal/` and `setup/portal.ts`/`setup/slack-worker.ts`; wire into Isthmus's own setup wizard (confirm or add the `--step registry`-style structure `portal.ts` assumes). Include a LAW-08 security-review pass before this counts as done — confirm the ported code matches upstream's own stated privacy posture (`docs/hardened-image.md`'s "What is collected"/"What is never collected" is the bar) and that nothing lands anywhere the kernel wouldn't admit as a valid mount (expected: nothing here touches mounts at all — confirm, don't assume) | **Done** (`feat/gateway-provider-seam`, commit `e4085087`) — ported `src/community-portal/*` verbatim (self-contained, only cross-imports its own siblings), `setup/portal.ts`, `setup/slack-worker.ts`, and the two new shell-safe git-command helpers (`scripts/git-fetch-branch.ts`, `scripts/git-show-to-file.ts`) upstream introduced alongside this work. **Real, substantial finding along the way**: upstream also modified four *existing* shared files as part of this same change — `setup/channels/run-channel-skill.ts` (114-line diff: `materializeCompanionSkill`→`companionSkillPresent`, `ChannelSkillOverrides` gains `browserConsent`/`requireCompanions`, `runChannelSkillWithPreStep` gains pending-job resume + `__portal_skip`/`__portal_pending` sentinel handling), `setup/channels/companions.ts` (`ChannelPreStep` gains an options param), `setup/channels/slack-auto-register.ts` and `slack-auto.ts` (the portal's managed install now takes precedence over the old direct-token flow, confirmed this doesn't disable the old path — it only supersedes when the portal has a real answer). Missed on the first pass (only checked `portal.ts`'s own import statements, not what else calls into the new exports); caught by the community-portal-perk tests failing against real skill-application machinery instead of a mock gap, traced to the missing sentinel handling. All four reconciled against Isthmus's own divergence (not a blind overwrite — verified each dependency already existed in Isthmus's tree first), with their existing test files updated to match upstream's own test diff line-for-line, not just patched to pass. **LAW-08 check**: confirmed directly (grep, not assumed) that zero ported files reference `drivers/`, `MountSpec`, `SessionSpec`, or `composeSessionSpec`; `device-client.ts`'s only outbound headers are `authorization: Bearer` and the device-proof header, matching `docs/hardened-image.md`'s stated collection posture. `pnpm exec tsc --noEmit` clean; full `pnpm test` green apart from the same pre-existing bare-`git` failures. **Also found and safely handled**: a stray, internally-inconsistent uncommitted change to `src/channels/index.ts`/`package.json`/`pnpm-lock.yaml` (a Slack channel-adapter import and dependency added with no corresponding source file ever written) surfaced mid-session — not produced by anything this session ran intentionally, and very likely cross-talk from another concurrent worktree/session sharing this same repo (this checkout already carries unrelated stash entries from other branches — `coverage-floor-gate`, `uplift-and-ci-wiring`). Stashed rather than discarded (`stash@{0}`, recoverable) to unblock clean verification; worth the founder's awareness as a possible sign of cross-session interference on this shared checkout, independent of anything in this promotion |
| C12 | **New (ADR-031 addendum), Workstream D1 finding.** Adopt `src/modules/community-portal/` — the piece of the community-portal feature living outside `src/community-portal/`/`setup/`, hooking into the main host's own `onHostStart`/`onHostShutdown` lifecycle. Adopt with modification, by direct founder direction: no persistent `CellLink` WebSocket; poll on-demand instead | **Done** (`feat/gateway-provider-seam`, commit `929dbc98`) — `runtime.ts` written without `CellLink` at all; every check (perk-credential reconciliation, resuming a saved Slack install) runs purely off the existing interval timer (`dirty`/`nextSync`-gated), which upstream's own code already used independently of the link — removing the link loses no capability the timer couldn't already reach, just the push-triggered early wake. `index.ts` ported near-verbatim (host-lifecycle wiring, unaffected by the link removal); `registration.test.ts` ported near-verbatim; `runtime.test.ts` rewritten for the no-link shape, covering the same three guarantees upstream's test proves (idle until signed in, reconciles off the timer once signed in, clears credentials on rejection) without a socket to fake. `src/modules/index.ts` gains the one-line self-registration import, matching upstream's own diff exactly. LAW-08 verified: grep-confirmed zero WebSocket/CellLink/mount-spec references anywhere in the module. `pnpm exec tsc --noEmit` clean; full `pnpm test` green apart from the same pre-existing bare-`git` failures |
| C13 | **New, found while investigating the `reconcile-session.ts` cluster during Workstream D1's classification pass.** Isthmus's `host-sweep.ts` (`enforceRunningContainerSla`) already independently duplicates upstream's `reconcile-session.ts` stuck-container detection (`decideStuckAction`, same `ABSOLUTE_CEILING_MS`/`CLAIM_STUCK_MS` constants, same doc-comment header) but predates C9's multi-host claim/lease coordination, so it has no "incarnation gate": it treats `processing_ack` claim timestamps and heartbeat mtimes as evidence about the *current* container regardless of whether that evidence predates the current incarnation's `session_claims.claimed_at`. Confirmed directly that `src/reconcile.ts` and `src/request-wake.ts` — the files upstream's fuller rewrite introduces — do **not** exist in Isthmus (an earlier Workstream B classification row ("Clean — durable-host coordination work... no change needed") had been misread as "already present"; it meant "safe to decline porting," not that the files exist) — so this is scoped narrowly as a correctness fix to the sweep logic Isthmus already has, tying it to C9's already-ported `getSessionClaim`, not a port of the new files | **Done** (`feat/gateway-provider-seam`, commit `cb52a92d`) — `enforceRunningContainerSla` made async, reads `getSessionClaim(session.id)` and derives `incarnationStartMs` from `claimed_at`; heartbeat mtimes older than the incarnation start are gated to `0` (treated as absent, matching the function's own existing "no heartbeat file" fallback), and `processing_ack` claims whose `status_changed` predates the incarnation are gated to look freshly-claimed at `incarnationStartMs` rather than stale. Net effect: a freshly-claimed container (e.g. after host failover) is never killed on its first SLA check purely because it inherited stale `outbound.db` state from the incarnation before it — the same class of problem the existing `justWoke` grace period (`host-sweep-grace.test.ts`) already solves for ordinary wake races, extended to cover claim-transfer races. New regression test (`host-sweep-incarnation-gate.test.ts`, two cases: gated claim → no kill; a claim genuinely stale *within* the current incarnation → still kills), verified via `git stash`-based negative control against the pre-fix code (first case fails as expected pre-fix, second is unaffected either way). `pnpm exec tsc --noEmit` clean; full `pnpm test` green apart from the same pre-existing bare-`git` environment failures (77, unchanged count) |
| C14 | **New, deep-scope of the provider-host-contract mount-composition rewrite** (Workstream B's `container-runner.ts` finding, reopened by the scope-policy decision above). A dedicated agent traced every consumer, not just `buildMounts`, and confirmed directly against `drivers/types.ts` that this reopens **zero** Go-kernel work — the contract only changes *how* the `VolumeMount[]`/`MountSpec[]` array is built, never what `mountClass` values it can carry (`'group-state' \| 'allowlisted-extra'` only, byte-identical union both trees) | **Done — all 6 steps implemented, tested, and committed 2026-09-26** (`feat/gateway-provider-seam`, commits `defa4d29`/`03e884a9`/`56e60edc`/`26b0ae30`/`a5bcbcff`). Summary below; full step-by-step evidence in the progress notes that follow this row and in the changelog. Full report: real host-side surface is four files, not one — `container-runner.ts` (`buildMounts`/`resolveProviderContribution`), `group-init.ts` (state-volume dirs + group-init files, replacing Isthmus's own hand-written `.claude-shared` mkdir), `command-gate.ts` (native command allow/admin lists — target values already match Isthmus's current hardcoded sets), and (opportunistically) `cli/resources/groups.ts`'s `--speed` flag. Six-step ordered plan: (1) widen `provider-contracts/registry.ts` from C8's narrow slice to the full `ProviderHostContract` shape + `assertProviderHostContractShape`; (2) add `file-transformers.ts`/`realize.ts` (new); (3) reconcile `project-doc-compose.ts` (Isthmus already independently ported ~90% of this file's own v2.4.0 security rewrite — only the newer `ProviderInstructionFacts`/`renderBaseInstructions` layer is missing); (4) rewrite `buildMounts`/`resolveProviderContribution`; (5) write Isthmus's own Claude `ProviderHostContract`, reconciling two real divergences (see below); (6) reconcile `group-init.ts`/`command-gate.ts`. Steps 1-4 are testable in isolation (a synthetic test-only contract, no real Claude contract needed) and were assessed as the natural first sub-task; steps 5-6 (Claude's real contract) as the second. Estimated ~2,300 new/changed lines across ~13-15 files — smaller than upstream's raw diff because Isthmus already absorbed real groundwork (`project-doc-compose.ts`'s security rewrite, C8's narrow `registry.ts`/`claude.ts`, `command-gate.ts`'s already-matching values). **Two real divergences found, not assumed**: Isthmus's `DEFAULT_SETTINGS_JSON` carries a `PreCompact` hook (`/app/src/compact-instructions.ts`) and `CLAUDE_CODE_DISABLE_AUTO_MEMORY`/`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` env vars that don't exist in upstream's `CLAUDE_DEFAULT_SETTINGS` — **decision: preserve Isthmus's own settings content as the contract's `files` declaration, build the new transformer from Isthmus's shape, not upstream's** (the conservative default — dropping an existing, working Isthmus-specific behavior would be an unrequested regression, not a port). **One open question left for the founder, not decided here**: whether the *container-side* `container/agent-runner/src/provider-contracts/` runtime contract (execution policy/inference/memory/commands — confirmed a genuinely separate ~2,579-line, 100%-unported abstraction, sharing only a directory-naming convention with the host-side one) is also meant to be in scope of the "provider-host-contract" reopening, or is a distinct decision — see the Non-goals section's new entry. Proceeding to implement the host-side mount-composition rewrite (steps 1-6 above) without waiting on that separate question, since it's unambiguously the item the scope-policy decision named.

**Progress, 2026-09-26: Steps 1-3 of 6 done and committed, all mechanism work** (`feat/gateway-provider-seam`). **Step 3** (commit `defa4d29`): added `ProviderInstructionFacts`, `BASE_INSTRUCTIONS_PATH`, `MEMORY_NOTE_PLACEHOLDER`, `renderBaseInstructions()`, `renderNativeSkillsSection()` to `project-doc-compose.ts` — purely additive, `ProjectDocSpec.baseDocPath` becomes optional (legacy shape) rather than required; `DEFAULT_PROJECT_DOC` deliberately keeps setting it, so every existing spec's behavior is byte-for-byte unchanged (confirmed: all 28 pre-existing tests pass unmodified). Done first, out of the plan's original order, because `registry.ts` (step 1) imports `ProviderInstructionFacts` from it. **Steps 1-2** (commit `03e884a9`): widened `provider-contracts/registry.ts` from C8's narrow slice to the full contract (`projectDocument`, `stateVolumes`, `skillBackings`, `skillViews`, `files`, `legacyHostAdapter`, `commands`), and added `file-transformers.ts` (self-contained, ported verbatim). **A real, deliberate divergence from upstream, not an oversight**: upstream requires `projectDocument` on every registered contract; here every mount/file field stays optional, because Isthmus's shipped `claude.ts` (C8) registers a model-domain-only contract with no mount surface at all and must keep compiling and behaving identically while this rewrite lands in stages — `assertProviderHostContractShape` now encodes the actual invariant instead: a contract declares **no** mount/file surface at all (buildMounts keeps composing that provider's mounts the legacy way, wholly unaffected by this commit) or a **complete** one, `projectDocument` included, with upstream's full validation applying from that point (path canonicalization, mountClass allowlist, id uniqueness, cross-reference checks, container-destination collisions). New `registry.test.ts` (33 cases, the first real coverage this file has had) weights toward the new divergent invariant (6 cases) and the shape-validation failure modes upstream's own 501-line suite exists to catch. **Step 2's `realize.ts`** (commit `56e60edc`): the group-init/spawn-time realization step `buildMounts` will call — state-volume directory creation, prepared-file initialization/reconciliation, skill-backing/view path resolution, shared-skill symlink sync, project-document composition. **A second deliberate divergence, also security-relevant**: upstream imports `writeAtomic` from `migrate-claude-memory-settings.ts`, safe there only because that file runs once at startup before any container exists to race against; this module's file writes land in the same agent-writable, group-shared, read-write-mounted state-volume tree `project-doc-compose.ts`'s own `writeAtomic` (LOAD-BEARING header, the symlink-race fix from earlier this promotion) exists to protect, so `realize.ts` reuses that implementation instead (exported it, zero behavior change to `project-doc-compose.ts` itself). New `realize.test.ts` (19 cases); the two path-escape-rejection tests (the file's most security-critical assertion) verified via a targeted mutation check rather than a stash-based negative control, since this is wholly new code with no pre-existing behavior to diff against — neutering the escape guard makes exactly those two tests fail, restoring it makes all 19 pass. Every step across all three commits verified via `pnpm exec tsc --noEmit` clean and zero regression in every real consumer (`gateway-approval-coordinator.ts`, `provider-surfaces.test.ts`, the C8/C10/C11 test suites, 88+19 tests total in the touched area). Claude's existing C8 registration is untouched throughout — this is why Steps 1-3 could land safely without yet touching the one provider Isthmus runs in production.

**Progress, 2026-09-26 (continued): Step 4 of 6 done and committed** (commit `26b0ae30`). `buildMounts`/`resolveProviderContribution` now consult `getProviderHostContract(provider)` and realize a declared mount surface via `provider-contracts/realize.ts` — state volumes, skill-backing views, and the project document all compose from the contract, with upstream's own two-pass immediate/allowlisted-extra mount ordering. Once a provider has a contract, its legacy `.mounts` are dropped (matching the "silent mount drop" trap the deep-scope report flagged in §1) — only `.env` still passes through. **The load-bearing correctness point**: every branch upstream keys off truthy `contract` is keyed here off `hasProviderMountSurface(provider)` instead (Step 1's mount-surface-invariant divergence) — Claude's shipped C8 registration IS a registered contract but declares no `projectDocument`/`stateVolumes`, so using raw truthy `contract` as the switch would have routed Claude through the new path with an empty surface, silently dropping its `.claude` mount, composed `CLAUDE.md`, and skill symlinks on every spawn the moment this commit landed — before Step 5 even exists. Verified two ways: the 63 pre-existing `buildMounts('claude', ...)` tests across five files pass byte-for-byte unmodified (direct proof Claude is unaffected, satisfying the deep-scope report's §4 recommendation without a separate parity harness, since Claude has no mount-surface contract yet); a new `provider-host-contract-mounts.test.ts` (6 cases, a synthetic contract) proves the new path itself, including the strongest check — the composed spec passing real `mountPolicy()`/`validateSpec` admission end to end. Negative-controlled: all 6 new tests fail against the pre-rewrite file. `pnpm exec tsc --noEmit` clean; full `pnpm test` 4098 passing (up from 4092).

**Progress, 2026-09-26 (final): Steps 5-6 done and committed — Workstream C14 fully complete** (commit `a5bcbcff`). This is the change that actually activated the rewrite in production: `provider-contracts/claude.ts` now declares `projectDocument`/`stateVolumes`/`skillBackings`/`files`, flipping `hasProviderMountSurface('claude')` to true — every live Claude spawn from this commit forward goes through the new contract-driven path, not the legacy one. Settings-content divergence applied as decided earlier: Claude's `files` declaration uses Isthmus's own `DEFAULT_SETTINGS_JSON` (moved unchanged from `group-init.ts` into `migrate-claude-memory-settings.ts` as a single source of truth), not upstream's `CLAUDE_DEFAULT_SETTINGS`. `migrateClaudeMemorySettings` refactored to extract a pure `reconcileClaudeSettingsContent()` with no I/O, reused by a new `'claude-settings'` file transformer — the original function and its own 11-test suite are otherwise untouched. `group-init.ts` now realizes the group-lifetime portion (state-volume dir, settings.json, skills dir) via `initializeProviderGroupSurfaces` when a contract exists, same `hasProviderMountSurface()` gate as `container-runner.ts`, for the same reason. `command-gate.ts`'s `FILTERED_COMMANDS`/`ADMIN_COMMANDS` now derive from every registered contract's `commands` declaration — checked directly against the real v2.4.0 tag rather than assumed, and matched upstream's actual structure exactly: `/clear`/`/upload-trace` stay hardcoded (NanoClaw's own commands, not any provider's), only `/compact`/`/context`/`/cost`/`/files` come from Claude's contract.

**Verification, the strongest in this whole workstream**: the full 176-test suite spanning mount composition, group filesystem provisioning, command gating, and provider-contracts passes with Claude's real contract active and doing the actual work — not a separate parity harness, the *same tests written against the legacy path*, now exercising the new one. One assertion updated (a diagnostic field renamed `settingsFile` → `filePath`, matching the generic transformer interface every future provider's file transformer will also use; the warning text itself is byte-identical). The transitional "no registered host contract" warning (added in step 4) confirmed to no longer fire for claude. Negative-controlled two ways: reverting all three implementation files together restores the pre-step-5 warning and field name exactly; a targeted mutation removing just `claude.ts`'s `commands` block makes `command-gate.test.ts`'s two filtered-command cases fail specifically while its two hardcoded-admin-command cases keep passing, confirming that hardcoded/contract-derived split is real, not incidental. `pnpm exec tsc --noEmit` clean; full `pnpm test` 4098 passing, apart from the same 77 pre-existing bare-`git` environment failures tracked throughout this promotion.

**What C14 leaves for later, explicitly not done here**: `cli/resources/groups.ts`'s `--speed` flag (Claude's contract deliberately omits `inference`, matching C8's original reasoning — nothing reads it yet); the container-side provider-contracts port (a separate, now-founder-approved item, tracked as **C15** below).

**Remaining, in dependency order, none started**: Step 5, Isthmus's own Claude `ProviderHostContract` (the settings-content divergence decision already made — preserve Isthmus's `PreCompact`/env-var behavior, don't adopt upstream's `CLAUDE_DEFAULT_SETTINGS` verbatim) — this is the step that actually flips `hasProviderMountSurface('claude')` to true and puts every live Claude spawn through the new path for real, so it needs `group-init.ts` reconciled in the same pass (Step 6's other half, `command-gate.ts`, is independent and can follow separately): today `group-init.ts` hand-creates `.claude-shared`/`settings.json`/skill dirs directly, and once Claude has a contract, `provider-contracts/realize.ts`'s `initializeProviderGroupSurfaces` does the equivalent work — the two must not both run and fight over the same files. Proceeding directly into this next, per the founder's standing autonomous-work instruction, with the same rigor as Steps 1-4: characterize `group-init.ts`'s current settings.json output before touching it (LAW-06 — this is live provisioning code, not additive mount composition), then reconcile.
| C15 | **New (2026-09-26, direct founder decision), the container-side sibling of C14.** Port `container/agent-runner/src/provider-contracts/*` (the Bun-side execution-policy/inference/memory/command-formatting contract — a genuinely separate abstraction from C14's host-side mount/file contract, see the Non-goals section) and reconcile `container/agent-runner/src/providers/{claude,provider-registry,types,factory}.ts` against it | **Mechanism implemented and committed 2026-09-26** (`feat/gateway-provider-seam` @ `7af29867`, 23 files, +1505/−403). Ports the full resolution mechanism deep-scoped below: new `provider-contracts/{registry,realize,verifier,mock,names,index}.ts`, new `providers/{claude-config,claude-history}.ts`, two-step registration in `provider-registry.ts`, `providers/claude.ts` rewritten to take a resolved `ResolvedRuntimeConfiguration` as a required constructor argument instead of deriving execution policy/inference/mcpServers itself. Full container-side suite: 343 pass, 1 skip, 0 fail (up from 339 pre-C15); `bun run typecheck` and `eslint` both clean. **Deliberately scoped narrower than upstream's full diff, three concrete decisions, not silent gaps:**<br>1. **`poll-loop.ts` excluded entirely.** `AgentProvider.supportsNativeSlashCommands`/`.emitsMidTurnText` stay instance fields on `providers/types.ts` (diverging from upstream's migration to `commands.formatting`/`textDelivery`), because `poll-loop.ts`'s real v2.3.0→v2.4.0 diff (confirmed via `git diff v2.3.0..v2.4.0`, 327 changed lines) bundles that migration together with an unrelated, substantial multi-turn reply-routing rewrite (new `queuedTurns`/`adoptTurn`/`pushRetry` mechanism, `AbortSignal` cancellation, `db/session-routing.ts` +44 lines, `db/session-state.ts` +71 lines) — the same bundled-concerns pattern already found in `container-runner.ts`. Keeping the instance fields means zero `poll-loop.ts` changes; the contract still declares both fields (verifier-checked, correct shape) but they're unconsumed — the same "declared but unconsumed" staging this promotion already used for host-side `inference` before C14 Step 5. **The reply-routing rewrite itself is tracked as a separate, not-yet-scoped follow-on item, not dropped.**<br>2. **`@anthropic-ai/claude-agent-sdk` version bump deferred.** Upstream's `snapshot: false` fix on `systemPrompt`'s preset option (real bug: a resumed session keeps a stale system-prompt append — old agent name/destinations — until compaction) needs the SDK bumped `^0.3.238`→`^0.3.280`. Per CLAUDE.md's "Container Runtime (Bun)" policy (check the npm release date, pin deliberately, never blindly), this bump was not applied in this pass. The fix is deferred, not declined — tracked as its own follow-on decision.<br>3. **Two divergences from upstream's literal content, both applied, both verified against the real tags (not assumed):** `providers/claude-config.ts` keeps `'TaskOutput'` in `TOOL_ALLOWLIST` — upstream's v2.4.0 drops it with zero occurrences anywhere in the v2.4.0 container tree (confirmed via `git grep` against the real tag) and no evidence of a deliberate removal, while it's been present since Isthmus's very first commit. `provider-contracts/claude.ts` corrects `/remote-control` to `nativeFiltered` (the recommendation from the earlier deep-scope pass below, now applied) to match Isthmus's own already-tested categorization instead of upstream's `nativeAdmin`. Both fields remain inert (nothing consumes `contract.commands` for real behavior on the container side yet, same as host-side), so this is a correctness-of-declared-value fix, not a behavior change.<br><br>**Deep-scope findings below (2026-09-26, pre-implementation) — kept for record, now superseded by the completed port above.** Confirmed directly against the real `v2.3.0` tag: every current Isthmus file under `container/agent-runner/src/providers/` (`claude.ts`, `provider-registry.ts`, `types.ts`, `factory.ts`, `mock.ts`) is **byte-identical** to the v2.3.0 baseline, so — unlike C14's host side — there is no Isthmus-specific behavior a port would silently overwrite, only upstream's own diff to apply. That lowers *reconciliation* risk but not *execution* risk: `claude.ts` (691 lines currently, upstream's rewrite is 410) is the file that runs every live Claude conversation turn, and **the blast radius is larger than first estimated** — read `poll-loop.ts` and `index.ts` directly (not assumed) and found real consumers there too: `AgentProvider.supportsNativeSlashCommands`/`.emitsMidTurnText` (instance-level booleans read in `poll-loop.ts`'s command-formatting and mid-turn-delivery logic, 10+ call sites woven through the content-door/suppression logic) move to the contract's `commands.formatting`/`textDelivery` fields; `index.ts` calls `provider.registerMemorySessionHook(hook)` directly, which gains a second `memory?: unknown` parameter core must resolve and pass. This is not a provider-registration-only change — `poll-loop.ts` (the actual message-processing core loop) needs real reconciliation too, a genuinely new finding this pass. Confirmed real diff sizes directly against the actual `v2.4.0` tag (not scratchpad estimates): `providers/claude.ts` **−281 net lines** (94 added, 375 removed — logic extracted into the new contract layer); `providers/provider-registry.ts` +89 net (two-step order-independent registration: `registerProvider`/`registerProviderContract` can fire in either order); `providers/types.ts` ~63 lines churned (the two instance-level booleans replaced by contract fields, `ProviderOptions` gains `speed`, `ProviderEvent`'s `result` variant gains `error?: string`); `providers/factory.ts` +29 net; `providers/claude-history.ts` (330 lines) and `providers/claude-config.ts` (149 lines) are **new files**, not present in Isthmus at all; `container/agent-runner/src/provider-contracts/` (7 files: `registry.ts` 118 lines — the `Capability<I>` function-or-constant type and the full `ProviderRuntimeContract` shape, `realize.ts` 88 lines, `claude.ts` 89 lines, `mock.ts`/`names.ts`/`verifier.ts`/`index.ts`) is an **entirely new directory**. **A real, concrete divergence found, not assumed**: upstream's container-side `provider-contracts/claude.ts` declares `commands.nativeAdmin: ['/remote-control', '/compact', '/context', '/cost', '/files']` — categorizing `/remote-control` as **admin** — but Isthmus's own `formatter.ts` (`ADMIN_COMMANDS`/`FILTERED_COMMANDS`) and the host-side `command-gate.ts`/`provider-contracts/claude.ts` (C14) both categorize `/remote-control` as **filtered**, and `formatter.commandLists.test.ts`'s own header comment explicitly names this exact command as a category that "had already silently diverged... by the time this was caught" in Isthmus's history. Confirmed via direct grep that `contract.commands` is currently **inert** on the container side too — only shape-validated by `verifier.ts` (`assertCommandArray`/`unique`), nothing reads `.nativeAdmin`/`.nativeFiltered` for actual runtime behavior (same "declared but unconsumed" status as host-side `inference` before C14 Step 5) — so this divergence has no live effect today, but a verbatim port would plant a self-contradictory value in the codebase (agreeing with nothing else in the fork) that would surface the moment anything wires `formatter.ts` to read from the contract. **Recommendation, not yet a decision**: when this is implemented, correct `/remote-control` to `nativeFiltered` in the ported contract to match Isthmus's own already-tested categorization, documented as a deliberate divergence — the same class of decision as C14's settings-content and `writeAtomic` choices, not a value judgment call needed from the founder. **This session's capability correction directly applies here**: `container/agent-runner` is now confirmed fully testable in this sandbox (`bun install` + `bun run typecheck` + `bun test`, see the changelog entry on that), so this can be built with real characterization tests and negative controls, not ported on faith. Deliberately not started in this session: the true scope (provider-registration files + `poll-loop.ts` + `index.ts` + two new files + a new directory, ~2,300+ lines) needs its own unhurried pass with the same rigor as C14, not squeezed into the tail of a long one that already shipped C14's own six steps. |

**Acceptance-record requirements (C5)** — every accepted bypass or TS-only
security decision must record all of the following, in
`go-host/docs/compatibility-security-report.md` (or a linked doc), before
it counts as closed rather than open:

- The exact privileged operation the decision covers.
- Every reachable call path to that operation (not just the one this
  review happened to trace first).
- Why Go-kernel enforcement is not currently feasible for this specific
  case (a real constraint, not "ran out of time").
- The threat model and a concrete abuse case — what a malicious or
  compromised actor could actually do through this gap.
- Any compensating control already in place.
- A severity rating and residual risk statement.
- A **named approver** — a person, not "the team."
- A **date of approval**.
- An **expiry/review date** — an acceptance record with no expiry is a
  permanent exception by default, which this plan does not allow. Every
  record gets re-reviewed at or before its expiry.
- Whether this decision blocks `compatibility-matrix.md`'s "Stable" rating
  for the affected row (it should, unless explicitly justified otherwise).
- A regression test proving the accepted boundary stays exactly where it
  was accepted — i.e., a test that fails if the gap silently widens.

Isthmus's existing `admissionEnforced: false` note in `docker-driver.ts`'s
`capabilities()` predates this requirement and should be brought up to this
same bar as part of Workstream C, not grandfathered in.

### Workstream D — Full-diff inventory and pure-TypeScript reconciliation

**D0 — the inventory artifact (new; gates everything else in this
workstream).** Before classifying anything, produce a durable,
machine-readable inventory of every changed path in the pin→v2.4.0 diff —
not the prose "200 files changed under `src/`" estimate in "Why this
promotion is not a routine version bump," which is exactly the kind of
claim that let the OneCLI move go unnoticed once already.

**Format, decided now so every workstream writes to the same shape rather
than each inventing its own** (a Copilot review flagged the earlier
"CSV, JSON, or a table" phrasing as leaving room for drift): **CSV**, at
`docs/promotion-v2.4.0-file-inventory.csv` — plain text, git-diffable,
greppable, no tooling dependency to read or write it (consistent with this
project's own LAW-05 bar: don't add structure a plain format already
covers). Exact header row, in this order:

```
path,status,source,destination,bucket,consumed_contract_row,security_review_status,test_evidence,reconciliation_decision,reviewer,adr_reference
```

Column meanings:

- `path` — the changed file's path in the v2.4.0 tree (or the pre-rename
  path for a pure deletion).
- `status` — one of `added` / `modified` / `deleted` / `renamed`.
- `source` / `destination` — populated only for `status=renamed` (the
  OneCLI move is exactly this case: `source=src/gateway-providers/
  onecli.ts`, `destination=.claude/skills/add-onecli/payload/src/
  gateway-providers/onecli.ts`); empty otherwise.
- `bucket` — one of `A` (seam) / `B` (bypass-risk) / `C` (pure-TS).
- `consumed_contract_row` — the matching `version-compatibility.md` §1 row
  name, if any; empty otherwise.
- `security_review_status` — for Bucket B rows: `closed` (routed through
  the kernel/an existing guard) or a link/ID to the Workstream C
  acceptance record; empty for A/C rows.
- `test_evidence` — link (test file path, or PR/commit) to what covers
  this change.
- `reconciliation_decision` — for Bucket C rows: `port-verbatim` /
  `port-with-modification` / `declined:<reason>`; empty for A/B rows.
- `reviewer` / `adr_reference` — who reviewed this row and, if relevant,
  which ADR it feeds.

A row with any required field blank for its bucket (e.g. a Bucket B row
with an empty `security_review_status`) counts as unclassified for the
promotion gate's "zero unclassified rows" requirement.

The full-repo sweep this inventory is built from must cover `src/`,
`container/agent-runner/src/`, `setup/`, and `.claude/skills/` — not `src/`
alone, per the same lesson.

**Findings already known going into D0** (from Workstream B's audit, 2026-09-25
— seed these rows rather than re-deriving from scratch):

- `src/container-runner.ts`'s `buildMounts`: a **provider-host-contract
  mount-composition rewrite** (`getProviderHostContract`/
  `realizeProviderSpawnSurfaces`, `contract.stateVolumes`/`.skillViews`/
  `.skillBackings`), replacing the old `providerProvidesAgentSurfaces`/
  `providerContribution.mounts` callback pattern. Orthogonal to
  gateway-trust — affects every provider's mount composition, not just a
  gateway's. Bucket **A-adjacent**: its output still terminates in the same
  kernel-validated `MountSpec[]` (A1's admission rules apply regardless of
  how the array was built), so it is not itself a new bypass path, but it
  is a substantial feature decision requiring its own reconciliation pass —
  D3's "genuinely independent vs. needs manual reconciliation" question,
  at real scale.
- `src/cli/resources/groups.ts`: a new `--speed` inference-tier flag
  (`provider-contracts/registry.ts`-declared) and a new `connect` custom
  operation (`src/gateway-connections.ts`, core, not skill-payload). Bucket
  **C**, unrelated to each other and to the gateway work.
- `src/modules/agent-to-agent/agent-route.ts`, `create-agent.ts`,
  `src/cli/resources/groups.ts` (restart handler): `wakeContainer` →
  `requestWake(session, reason)`. Bucket **C**, confirmed behavior-inert
  (upstream's own `request-wake.ts` doc comment: "byte-equivalent...
  no logging, no signal writes, no behavior" until the durable rows become
  authoritative) — same classification as the already-`Done` `host-sweep.ts`/
  `reconcile.ts`/`request-wake.ts` row in Workstream B's table.

| # | Task | Status |
|---|---|---|
| D0 | Produce `docs/promotion-v2.4.0-file-inventory.csv` using the exact header above, covering the full repo diff | **Done** (2026-09-25) — 526 rows, generated mechanically from `git diff v2.3.0 v2.4.0 --name-status -M` across `src/`, `container/agent-runner/src/`, `setup/`, `.claude/skills/` (313 added, 198 modified, 12 deleted, 3 renamed — 2 git-detected, plus `src/gateway-providers/onecli.ts` → `.claude/skills/add-onecli/payload/src/gateway-providers/onecli.ts` paired manually per this doc's own worked rename example, since git's similarity detector didn't catch it across the directory move). `bucket` pre-filled for the 18 rows this session already has real evidence for (the 7 Workstream-B-shipped seam files as Bucket A; `container-runner.ts` as Bucket A pending D3 reconciliation; the inert `request-wake`/`host-sweep`/`reconcile.ts` cluster and the agent-route/create-agent/groups.ts wake-routing swaps as Bucket C; `gateway-read-policy.ts`/`.test.ts` as Bucket B, blocked on C0). The other 508 rows are genuinely left blank rather than guessed — that's D1's job |
| D1 | Classify every row into Bucket A/B/C using the inventory — supersedes the earlier prose-based first pass | **Done — all 526 rows classified (2026-09-25).** After the 280 rows this session's own direct passes resolved (provider-host-contract deferrals, C7/C8/C9/C10/C11 bookkeeping catch-up, sibling-branch verification — see changelog for the full breakdown), the remaining 246 rows were dispatched to three parallel agents, each instructed to read every file's actual diff and apply this plan's established precedents rather than guess. Merged with one correction (`setup/providers/install.ts` + its 2 tests moved from the agent's raw call to `declined:pending-architecture-decision`, verified directly — its `HOST_CONTRACT_BARREL` constant names the same undelivered `src/provider-contracts/index.ts` barrel). Real findings surfaced (not silently classified): a fully new, unreviewed **Bucket B** module (`src/modules/community-portal/*`, 4 rows — see the changelog entry, a real open item, not yet decided); a substantial new stuck-container-detection feature (`reconcile-session.ts`/`reconcile-queue.ts`/`reconcile-feeds.ts`, 547 new lines, claim-aware via C9's coordination primitives but a materially different feature from anything C9 itself ported); an active-branch overlap on `src/egress-lockdown.ts`/`docker-driver.test.ts` (this checkout's own branch name is `fix/egress-lockdown-kernel-network-wiring` — Isthmus has already diverged here, D3 territory, not a blind port); a Mattermost feature Isthmus already has that upstream's own v2.4.0 retires (a straight overwrite would delete working Isthmus functionality); a missed `setup/verify.ts` wiring gap in C10/C11's own prior work, found and fixed directly this session (commit `d6394b4a`) since it was a gap in already-claimed-done work, not a new decision. Also cleaned up 23 stale Bucket B rows left classified from before this session (`src/community-portal/*`, `gateway-read-policy.*`, `gateway-session-lifecycle.*`) whose underlying review had already completed via C2/C7/C10/C11 — `security_review_status` set to `closed` for all of them, correcting the bookkeeping rather than leaving them looking like open questions |
| D2 | Read `migrate-nanoclaw`'s and `update-nanoclaw`'s SKILL.md in full; decide whether either is usable as-is, adaptable, or whether Isthmus's depth of fork needs a bespoke process for this reconciliation specifically | **Done — neither is usable as-is, and this directly resolves H1's open question too, not just D2's.** Both files read in full. `migrate-nanoclaw`'s Phase 0/1.0 resolves an `upstream` remote to `https://github.com/nanocoai/nanoclaw.git` and works entirely off `git merge-base HEAD upstream/<branch>` within that single lineage — every step (diff stats, skill reapply, customization extraction) assumes the live repo and upstream share git history as the same evolving project. `update-nanoclaw` is stricter still: step 1 explicitly requires `git remote get-url origin` to match the `nanocoai/nanoclaw` pattern (or an `upstream` remote pointing there), resolves `upstream_ref` to that remote's own `main`/`master`, and stamps "the exact Git commit/tree" of *that* upstream as the finish condition. Neither skill has any concept of "the destination is a separately-maintained downstream project" — pointed at a plain nanoclaw install, both would (if they ran at all) fast-forward that install to newer plain nanoclaw code, never introduce Isthmus's Go kernel/wire-protocol/ADR layer. This confirms — by reading the actual mechanism, not inferring from descriptions — that no dedicated "come from nanoclaw, end up on Isthmus" path exists today, which is exactly what H1 asks to establish. `migrate-nanoclaw`'s *methodology* remains worth reusing as a design pattern for the bespoke H2/H3 process (extract intent → guide → reapply on a clean worktree base → validate → staged cutover → backup branch/tag rollback) — but as a pattern to build from, not a skill to invoke as-is. Which bespoke process to actually build is a separate decision, left to H1/H2/H3, not decided here |
| D3 | For each Bucket C row: is it a genuinely independent upstream change (safe to port as-is), or does it touch a file Isthmus has already meaningfully modified (needs manual reconciliation, feature-by-feature, preserving both sides)? Record the decision in the inventory's `reconciliation_decision` column | **Done for Mattermost and the reconcile-session cluster; the egress-lockdown item is the one real remaining reconciliation, tracked separately, not blocked.** History below, corrected 2026-09-26 after tracing the actual git ancestry (an earlier version of this row got the `fix/inbox-toctou-batch-revalidation` finding wrong — recorded honestly rather than silently rewritten). **Mattermost — resolved, no coordination risk after all.** The CSV's `port-with-modification` rows (`setup/channels/mattermost-{config,discovery,guidance,response,runtime-verification}.test.ts`, two fixtures) were inconsistent with a sibling group already correctly marked `declined:out-of-scope-tracked-by-sync-sibling-branch-mechanism` (`.claude/skills/add-mattermost/*`) — same feature, two dispositions. Reclassified all 7 to match (all 18 Mattermost rows now agree) — this part was and remains correct. The *reasoning* for not going further was wrong, though: this row originally worried that a local branch, `fix/inbox-toctou-batch-revalidation` (found via `git log --all` on `mattermost-guidance.test.ts`, which predates the `v2.3.0` tag in Isthmus's own history), represented unmerged, parked Mattermost work needing founder sign-off before reconciling. Tracing its actual ancestry (`git merge-base --is-ancestor`) instead of just reading commit subjects shows that's not what it is: the branch's own history **is** `upstream/main` (nanocoai/nanoclaw's default branch, as of 2026-09-23, moments before the real `v2.4.0` release-merge PR #3877 landed) with exactly **one** Isthmus commit on top (`prathish-ks`, `fix(inbox-safety): re-validate the inbox dir per attachment/file, not once per batch`) — confirmed by the founder to be a separate, unrelated branch used to submit a GHSA/security disclosure back to nanocoai/nanoclaw, not promotion work. Isthmus's own `main` already independently carries the equivalent fix (`src/session-manager.ts:378` calls `ensureContainedInboxDir` inside the attachment loop, with a comment describing the identical re-validate-per-write fix), so there is nothing to port from that branch even setting the misattribution aside. The ~20 Mattermost commits reachable from it (`fix(mattermost): ...`, `feat(mattermost): ...`, PR #3507/#3777/#3778/#3780/#3809, all authored by upstream contributor `glifocat`, none on Isthmus's `main`) are pure incidental ancestry from the branch being rooted in `upstream/main` — not a parallel or parked Isthmus effort. No founder coordination is or was actually needed for Mattermost; the CSV correction stands on its own merits. **Real, still-open follow-up** (not this row's job, and not urgent): Isthmus's own `channels`-sibling-branch port of Mattermost may now be behind what's in the `v2.4.0` tag, since upstream's Mattermost work continued through 2026-09-15 — worth a normal `version-compatibility.md` §3.1 drift check (`test-registry-skills.ts --all add-mattermost` against `NANOCLAW_REGISTRY_REMOTE=upstream`) at some point, not gated on this promotion. **Reconcile-session cluster — already closed, this row was stale.** Became **C13** (`enforceRunningContainerSla` async, incarnation-gated via `getSessionClaim`), done and committed (`cb52a92d`) well before this correction — scoped narrowly as a correctness fix to logic Isthmus already had, deliberately not a full port of upstream's new `reconcile-session.ts`/`reconcile-queue.ts`/`reconcile-feeds.ts` files. This row's earlier "remains not started" language for it was simply not kept in sync with C13 landing. **Egress-lockdown auxiliary-gateway generalization — done (2026-09-26), `feat/gateway-provider-seam` @ `bca1b20e`.** D1's original hold-off cited `fix/egress-lockdown-kernel-network-wiring` (a different, real Isthmus branch, unrelated to the GHSA branch above) — confirmed merged (PR [#47](https://github.com/prathish-ks/isthmus/pull/47)), closing that concern. Investigating the actual upstream diff found a mechanical port didn't apply: upstream generalizes `ensureEgressNetwork()` from hardcoded OneCLI to a per-session `NetworkAccessIntent`, called from `drivers/index.ts`'s `dockerNetworkArgs(spec)` — but that call site is confirmed dead code in Isthmus's architecture (EC-02/ADR-016 already moved real container creation behind the Go kernel, making network topology kernel-startup config, not per-session; Isthmus's own `docker-driver.ts` comment says so explicitly). The live enforcement point is a different function in `kernel-supervisor/index.ts` (ADR-024/025/026's own fix), which still hardcoded OneCLI. Scoped and recorded in **[ADR-033](../go-host/docs/ADR-033-egress-lockdown-gateway-generalization.md)**: `GatewayProviderDefinition` gains an install-wide, session-independent `egressGateway()` descriptor (deliberately separate from the per-session `GatewayContribution.networkAccess`, which answers a different question and remains C7's own placeholder); OneCLI implements it with the same value that was hardcoded before; `kernel-supervisor`'s startup check now resolves the configured gateway's descriptor and fails closed if it declares none, instead of assuming OneCLI. Isthmus's own `gatewayAttached()` hardening (newline-exact-match membership check, a real fix over upstream's weaker space-split version) preserved verbatim, not reverted. `drivers/index.ts`'s confirmed-dead per-session call site left untouched, deliberately. Verified via negative control (temporarily removed the new fail-closed check, confirmed the new test catches it, restored); full affected-file suite green (56 tests); `tsc`/`eslint` clean. Workstream D3 is now fully closed. |
| D4 | Confirm zero rows remain unclassified and zero Bucket B rows lack a security-review status before this workstream counts as done — this is also a promotion-gate line, not just an internal target | **Done.** C12 closed the one remaining gap (`src/modules/community-portal/*`, `security_review_status: closed`). Zero unclassified rows, zero Bucket B rows without a security-review status, across all 526 |

### Workstream E — Testing

See "What 'green' means" and "What 'the gate passed' means," above, for
what "passes"/"green" mean in every row below.

| # | Task | Status |
|---|---|---|
| E1 | Go: unit tests for every new/changed `internal/mount` rule (Workstream A) | **Done** — same evidence as A6 |
| E2 | Go: live-Docker tests for multi-container sessions and network isolation (Workstream A). **PASSED + REQUIRED, not report-only** — see A5 and G1's Definition of done | **Done** — same evidence as A5: ran for real against a live Docker daemon 2026-09-25, `-race` included, full `go-host` suite green. Formal CI run (the actual GitHub Actions gate) still outstanding, but local real-daemon evidence now exists where none did before |
| E3 | TS: update/extend the seam tests this project already built (the 6 seam-real tests from the wiring-boundary-coverage effort, merged 2026-09-24) to cover any new wake/kill/build-image call shape from Workstream B | **Done (2026-09-26)**, `feat/gateway-provider-seam` @ `25c071c1`. Checked all 6 seam-real tests (`src/drivers/seam-real-setup.ts`'s consumers) against Workstream A/B's new `SessionSpec.networkAccess`/`WireSession.networkAccess` field — found it has been crossing the real `composeSessionSpec` → `toWireSession` → real socket path in every one of the 6 tests since Workstream A/B landed (the shared `seam-real-setup.ts` no-op gateway stub always contributes a concrete `{endpoint:'', target:{kind:'host'}}` intent), with no seam-level assertion pinning its shape — the exact ADR-024/ADR-028 failure shape (a real field on a real path, silently droppable with nothing noticing). Added one assertion to `cli-channel-kernel-smoke.test.ts` (the seam with the richest existing envelope-shape assertions) pinning the wire shape exactly. Verified with a negative control: temporarily dropped `networkAccess: gateway.networkAccess` from `composeSessionSpec`, confirmed the new assertion fails with the expected message, reverted. Deliberately does not duplicate A5/E2's job of proving the kernel *admits* a real non-`host` intent against a live daemon — this only proves the field isn't silently dropped in transit for the always-on no-gateway case. `wakeContainer`/`killContainer`/`buildAgentGroupImage`'s own call shapes (arguments, return types) are unchanged by this promotion — confirmed directly, no seam-test update needed for those. All 6 tests still pass (13/13); `tsc --noEmit` clean |
| E4 | TS: parity/security-regression coverage for the gateway trust-boundary findings from Workstream C (matching LAW-06/LAW-08's "contracts before rewrites" / "no weaker security than upstream" bar), including the regression test each Workstream C acceptance record requires | **Done — closed by audit, zero new tests needed (2026-09-26).** "The regression test each Workstream C acceptance record requires" is vacuous: C5's own accounting is zero acceptance records (every finding was closed outright, not accepted). The remaining question is whether every actual trust-boundary *finding* — the 3 real ones C6 produced, the only Workstream C items that changed enforced behavior rather than confirming there was nothing to change (C1/C2/C3 found no bypass/no feature/no gap to fix) — carries its own dedicated regression test, per LAW-06/LAW-08. Checked directly, not assumed: Finding 1 (`LabelsForKey` canonical-label precedence) → `go-host/internal/kernel/naming_test.go`, re-ran now: `TestLabelsForKey_CarriesAllFourCanonicalLabels`/`_ExtraLayersOnTopWithoutDroppingCanonical`/`_CanonicalWinsOverColludingExtra`, all PASS. Finding 2 (`approverUserId` persistence) → `src/gateway-approval-coordinator.default-approval.test.ts` (plus coverage in `guard.test.ts`/`message-gate.test.ts`/`approvals/primitive.coverage.test.ts`), re-ran now: 13/13 pass. Finding 3 (OneCLI mount-path allowlist) → `src/gateway-providers/onecli.test.ts`, included in the same re-run, passing. All three were originally verified via `git stash`-based negative control at fix time (C6's own row), not merely "added and assumed correct." The broader Workstream C feature-port items (C7/C9/C10/C11/C12/C13/C14/C15) each carry their own dedicated test suites already (176 tests for C14 alone, 343 for C15, etc.) — already counted in E5's full-suite green run, not a separate gap this row needed to fill. No new test-writing required; this row closes as a verification pass, not an implementation one |
| E5 | Full suite green (per "What 'green' means," above): `pnpm exec vitest run`, `bun test` (container/agent-runner), `go test -mod=vendor ./...` including `-race`. Pre-existing live-Docker jobs (`go-ec05-live-docker`, `go-egress-live-docker`) run and pass; the *new* multi-container/network test (E2) is additionally required per "What 'the gate passed' means" | **Done (local evidence), 2026-09-26**, `feat/gateway-provider-seam` @ `7af29867`. `bun test` (`container/agent-runner`): 343 pass, 1 skip, 0 fail. `go test -mod=vendor ./... -race`: every package ok. `pnpm exec vitest run`: 4098 pass, 77 fail across exactly 5 files — all 5 confirmed pre-existing and sandbox-only (this branch touches none of them; the identical failures reproduce on an unrelated, untouched branch in the separate main checkout), not a code regression from this promotion. Recorded per policy as a named baseline exception rather than silently discounted — see the new "Baseline test exceptions" table under "What 'green' means," above. Live-Docker jobs and E2's specific multi-container/network evidence: see A5/E2 (real daemon, `-race`, local); the formal required-CI-gate run (PASSED + REQUIRED per "What 'the gate passed' means") is still outstanding — tracked under G3/G4, not re-duplicated here |
| E6 | `wiring-registry-check` passes against any new privileged function this promotion introduces (Workstream A/C may add real callers/seam tests that need registering) | **Done (2026-09-26).** `pnpm exec tsx scripts/check-wiring-registry.ts` in `feat/gateway-provider-seam`: `13 entries OK`. Checked whether this promotion introduced a genuinely *new* privileged function of the class ADR-028 registers (a `wakeContainer`/`killContainer`/`buildAgentGroupImage`/`validateAdditionalMounts`-shaped function that could silently lose its last caller): A3's Go-side Wake/Kill port extends those same, already-registered functions to multi-container gateway specs — not a new function, so no new entry. Workstream C's bypass-closure audit (C1-C15) is itself this promotion's "successor audit" per ADR-028's own bar ("found by one of these two audits or a successor, not merely 'seemed privileged enough'") and closed with zero acceptance records needed (C5) — no new bypass-prone privileged surface was found across gateway-provider-registry.ts, gateway-approval-coordinator.ts, OneCLI, or C14/C15's contract rewrites. No registry entry added; none warranted |

### Workstream F — Documentation

| # | Task | Status |
|---|---|---|
| F1 | New ADR(s) recording the architectural decisions: (a) mount/network model in the Go kernel, including A2's mixed-version compatibility matrix and rollout answers; (b) gateway-provider trust-boundary scope (what's kernel-enforced vs. accepted TS-side, referencing every Workstream C acceptance record); (c) OneCLI trunk-vs-skill placement decision. One ADR or several, whichever keeps each decision reviewable independently — decide when the decisions are actually made, not now | **(b) and (c) done — see [ADR-030](../go-host/docs/ADR-030-gateway-adoption-and-multi-host-coordination.md).** **New, added 2026-09-26**: [ADR-032](../go-host/docs/ADR-032-provider-contract-rewrites.md) records C14 (host-side provider-host-contract mount-composition rewrite, done) and C15 (container-side provider-runtime-contract port, mechanism implemented and committed) — a decision this list didn't originally name, surfaced by Workstream B's deep-scope pass after F1 was first written. **Also new**: [ADR-033](../go-host/docs/ADR-033-egress-lockdown-gateway-generalization.md) records the D3 egress-lockdown gateway-generalization decision (done) — another decision this list didn't originally name. **(a) done, 2026-09-26**: [ADR-034](../go-host/docs/ADR-034-go-kernel-mount-network-model.md) records Workstream A's mount/network model additions (gateway-trust class, multi-container network isolation) — checked first, not assumed: A1-A6's own rows cite **zero** ADRs (confirmed by grep), so "Workstream A's own ADRs may already cover this" was not actually true until this ADR existed. Includes the mixed-version compatibility matrix F1(a) explicitly asked for, filled in against `upstream-promotion-playbook.md`'s own required questions — it turned out the honest answer already existed as `protocol.go`'s own doc comment (A2's commit), just never packaged as the ADR this row wanted; ADR-034 formalizes and tabulates it rather than duplicating prose. F1 is now fully closed: (a), (b), and (c) all done |
| F2 | `go-host/docs/version-compatibility.md` §1's consumed-contracts table updated to reflect the new v2.4.0-based contracts | **Done (2026-09-26)**, `feat/gateway-provider-seam` @ `710603e6`. Updated the mount/session-admission-shape row (gateway-trust `MountClass`, `Policy.GatewayTrustRoot`, `SessionSpec.networkAccess`) and the Docker-chokepoint row (`Executor.Wake`/`Kill`'s multi-container/network-isolation extension, plus its one named scope gap — auxiliary health-checking in `status()`, not ported). Added a staging note distinguishing "this table describes the code on this branch" from "the pin has moved to v2.4.0" (that's §3's "Promote" step / Workstream G4, a separate, later action) so the table isn't misread as claiming the pin already moved |
| F3 | `go-host/docs/compatibility-matrix.md` Stable/Preview/Unsupported ratings re-issued against the new baseline — any row covered by an open (non-expired) Workstream C acceptance record stays below Stable unless that record explicitly says otherwise | **Done (2026-09-26)**, `feat/gateway-provider-seam` @ `710603e6`. Added two new Stable rows (gateway-trust mount admission — A1/A6's table-driven suite; multi-container wake/kill with real network isolation — A3/A5's live-Docker evidence, not just a fake-CLI unit suite) and one Unsupported row (the auxiliary health-check gap). No row held below its earned rating by an acceptance record — Workstream C5 produced zero open ones, so every rating reflects actual verification status |
| F4 | `docs/traceability.md` updated with this promotion's ADR(s) and any new/changed law-breach entries | **Done (2026-09-26)**, `docs/v2.4.0-promotion-plan` @ `705d054d`. Added ADR-029 through ADR-032 to the ADR index (029 superseded same-day by 030; 030/032 as compliant LAW-07/08/LAW-06 citations; 031 as N/A, a feature-adoption decision). Added ADR-030 to LAW-07/LAW-08's Known-exceptions columns (the same trust-boundary-scoping role ADR-016 already plays for LAW-07). Added three new Boundary-verification rows for C6's three real findings, matching the existing live/negative-control-verified format exactly. Updated the "Channel → kernel wake" seam row for E3's new assertion. Added a Known-gaps bullet naming the two deliberately-deferred items (gateway-session-lifecycle wrapping, poll-loop.ts's reply-routing rewrite) so they're visible outside this document too |
| F5 | `CLAUDE.md`'s "Secrets / Credentials / OneCLI" section updated if Workstream C/D's OneCLI decision changes how it's documented | **Done (2026-09-26)**, `feat/gateway-provider-seam` @ `710603e6`. It did change: C7 generalized `src/modules/approvals/onecli-approvals.ts` (which CLAUDE.md still named, and which no longer exists) into the provider-generic `src/gateway-approval-coordinator.ts`, with `gateway-providers/onecli.ts`'s `approvals.subscribe` now the thin protocol-specific adapter into it. Updated both the prose (which file owns approver resolution/delivery/expiry/sweep now, and why — so a future provider like Iron Proxy doesn't reimplement it) and the Key Files table entry. OneCLI's own approval UX is unchanged (C7 extracted behavior-for-behavior) |
| F6 | This document's own findings folded into `go-host/docs/ADR-017`-style closure, or superseded by a new numbered ADR referencing it | **Correctly blocked, not silently unstarted (2026-09-26).** `ADR-017` was the closing review for the *v2.3.0* pin promotion — this row's job is the v2.4.0 equivalent, a single dated review ADR that supersedes/extends it once the pin actually moves. Writing that now would be premature and likely wrong: the pin has not moved (Workstream G4, gated on G3, gated on Workstream H's migration-continuity work, none of which is done), and an "ADR-017-style closure" written before the thing it closes is finished would either have to be revised again at G4 or would misrepresent the promotion as complete. The individual decision ADRs this promotion already produced (ADR-029 through ADR-032) are NOT a substitute for this row — they're per-decision records, the same granularity as ADR-004/006/013 always were; F6 is specifically the ADR-017-shaped *dated review* one level up. Sequenced immediately after G4 lands, not before |

### Workstream G — CI / PR-check uplift (required, not optional)

Every new privileged surface this promotion introduces to Isthmus's own
core (Workstreams A and C's findings) must have equivalent CI coverage
before the pin moves — not "consider adding a check," but "identify the
gap and close it," the same way `wiring-registry-check` became a required
gate the last time a comparably-sized surface (the wiring/recurrence-
prevention registry) was added. This explicitly excludes adopting the
`add-iron-proxy` *skill* or its own `iron-front` CI job (see Non-goals) —
this workstream is about covering what the *core pin itself* adds, not
about a downstream optional feature. Every "required" below means PASSED +
REQUIRED per "What 'the gate passed' means."

**Definition of done for every row in this workstream** (a Copilot review
of this plan correctly pointed out that "this must be required" is a
sentence, not enforcement): the task is not complete until
`.github/workflows/ci.yml` itself has been edited so that (a) the new job
exists, (b) its name appears in the `ci` gate's `needs:` array, and (c) the
`ci` job's own step asserts `needs.<job-name>.result == success` for it,
matching the exact pattern `wiring-registry-check`/
`sync-sibling-branch-script-test` already establish. A task in this table
does not move to "Done" on the strength of a design decision alone — link
the actual `ci.yml` diff (commit or PR) as the evidence.

**Placeholder job names** (to be finalized during Workstream A/C
implementation, not decided here — named now only so the requirement isn't
purely abstract while this plan is still pre-implementation):

- `go-mount-gateway-trust-check` — unit coverage for A1's new `MountClass`
  rule (feeds A6/E1).
- `go-multi-container-live-docker` — the new required live-Docker job for
  A5/E2's multi-container/private-network behavior. Distinct from the
  existing report-only `go-ec05-live-docker`/`go-egress-live-docker` —
  this is a new job, not a re-flagging of an existing report-only one.
- `gateway-bypass-guard-check` (or one per closed Workstream C finding, if
  they don't share a natural single check) — G2's coverage.

| # | Task | Status |
|---|---|---|
| G1 | For each new Go kernel surface from Workstream A (multi-container sessions, `gateway-trust` mount class, network-creation executor logic): identify what a required CI job needs to verify, and add it as a **required** gate — mirroring `wiring-registry-check`'s precedent, not just noting the gap. Done when `.github/workflows/ci.yml`'s `needs:` array and its success-check step both name the job, per the Definition of done above | **Done** — checked what actually already runs before assuming a new job was needed for everything: the existing required `go-host` job already runs `go test -mod=vendor ./... -race` unconditionally, so A1/A2/A3's unit tests (mount class, wire payload, executor argv/rollback/teardown) were already required the moment they were added — no new job needed for those, the earlier placeholder name `go-mount-gateway-trust-check` turned out unnecessary. The one genuine gap was A5's live-Docker coverage (gated behind an env var, excluded from the normal test run) — closed via the new `go-multi-container-live-docker` job (commit `1c9b6903`), required per its own row above |
| G2 | For each Workstream C finding that gets closed via a new guard/check rather than an accepted-and-recorded exception: confirm that guard/check has its own CI coverage (unit test at minimum; a dedicated required job if the finding's severity warrants it, matching G1's bar) | **Done — verified against the actual `.github/workflows/ci.yml`, not assumed.** Every Workstream C finding closed this promotion (C6 Findings 1-3, C9's claim-fencing, C13's incarnation gate, every C14 divergence) shipped as a plain unit/integration test, not a live-Docker-only case — so G1's "does this need a *dedicated* required job" question resolves the same way it did for A1-A3 there: no, because the existing required `test` job already runs unconditionally and already picks up every new test file with zero additional wiring. Confirmed directly: `test` job runs `pnpm exec vitest run --config vitest.config.ci.ts` (line 89) — `vitest.config.ci.ts`'s `exclude` list is generic boilerplate (`node_modules`, `dist`, tool configs), not a specific-file denylist, so every new `*.test.ts` this promotion added is included automatically — *and*, same job, `bun test` for `container/agent-runner` (line 93, right after the vitest run). `test` is in the `ci` gate's `needs:` list. No finding in this promotion's history needed severity-driven dedicated-job treatment the way A5's live-Docker coverage did in G1 |
| G3 | For any new script/automation this promotion introduces (e.g. a migration-continuity check, Workstream H): add `sync-sibling-branch-script-test`-style regression coverage, run on every PR — required, not report-only, unless there's a specific reason it can't be (state the reason if so) | **Done — resolves to N/A, confirmed rather than assumed now that H2/H3 have actually landed.** Re-checked all three places a new standalone script could plausibly have appeared: (1) Workstream A added zero new script files. (2) Workstream C did add new files — the Iron Proxy skill's own installer scripts (C8) plus `setup/portal.ts`/`slack-worker.ts` and two small git-command-builder utilities (C11) — but every one is ordinary feature code with test coverage already wired into the required `test` job: the Iron Proxy skill's ported tests run via the `.claude/skills/*/scripts/**/*.test.ts` pattern added to `vitest.config.ts` during C8, and confirmed (not assumed) that `vitest.config.ci.ts` — the config the actual CI `test` job runs — `mergeConfig`s on top of `vitest.config.ts` rather than replacing its `include` list, so those 8 files genuinely run in CI, not just locally; the git-command builders are exercised indirectly via `setup/channels/slack-auto.test.ts`. (3) Workstream H — the one place this row originally flagged as "a new script is expected" — turned out not to introduce one: H2/H3/H4 were satisfied via a **manual, non-interactive acceptance test with a recorded command-log artifact** (`docs/promotion-v2.4.0-rollback-v2.3.0.md`/`-v2.4.0.md`), matching H2/H3's own stated evidence bar ("an executed command log... not a hypothetical sequence") — not a new checked-in script. Confirmed via `git diff --diff-filter=A` against both the H2/H3 commits and the full `docs/v2.4.0-promotion-plan` branch: zero new files under `scripts/`. This task has nothing to add coverage for, and that absence is now verified rather than merely projected |
| G4 | Update `docs/upstream-pin.json`'s `$comment`/fields and `docs/baseline.md`'s "Stable Baseline" section together, in the same commit as the closing ADR (per LAW-09's own discipline, already established) — this is the final-pin-PR step, see "PR boundaries" above | Not started (final step) |

### Workstream H — Migration continuity (nanoclaw → Isthmus)

H1 (find/confirm the actual onboarding path) is discovery, as before. H2
and H3 are no longer open-ended "verify that path handles X" statements —
each is a concrete, executable acceptance test with explicit pass/fail
criteria, run once per source version.

**Rollback artifact requirement** (added per a Copilot review: migration/
rollback documentation is exactly where these plans tend to go ambiguous
in practice, so "rollback behavior is documented" is not itself
sufficient — a prose sentence is not evidence a rollback actually works).
Each of H2 and H3 must produce a **recorded rollback artifact**: either an
executed command log (the literal commands run to roll back, with their
real output, not a hypothetical sequence) or a step-by-step operator
checklist that was actually walked through and checked off during the
test run — checked into the repo alongside the acceptance-test evidence
(e.g. `docs/promotion-v2.4.0-rollback-v2.3.0.md` and
`docs/promotion-v2.4.0-rollback-v2.4.0.md`, or a shared doc with one
section per source version). A rollback claim with no artifact does not
satisfy H2/H3.

| # | Task | Status |
|---|---|---|
| H1 | Resolve the open question above: identify or confirm the actual current onboarding path from a plain nanocoai/nanoclaw install to Isthmus | **Done, corrected — an earlier version of this row was wrong.** That version checked only `migrate-nanoclaw`/`update-nanoclaw` and concluded no path exists — correct about those two skills (they operate on a different axis: catching a customized fork up with `nanocoai/nanoclaw`'s own upstream, nothing to do with adding the Isthmus kernel layer) but wrong as an answer to H1's actual question, because it never checked `isthmus.sh`, sitting in this same repo's own root and named directly in `CLAUDE.md`. Caught by the user, not by this review. **The real path**: `isthmus.sh` is an **in-place** migration, not a separate onboarding flow — same checkout, same `data/` directory, no new repo. It detects an existing install via `data/upgrade-state.json`, installs the `nanogo` kernel binary (`go-host/scripts/install.sh`), hands off to the ordinary `nanoclaw.sh` installer, and stamps the upgrade marker so the startup tripwire (`docs/upgrade-recovery.md`) doesn't fire. Rollback is a full revert to stock NanoClaw (`docs/rollback-runbook.md`) — not a runtime toggle, since `container-runner.ts`'s three privileged operations call the Go kernel exclusively as of the EC-02 enforcement-wiring work, so there's no native-TS fallback to flip back to at runtime. **This is genuinely tested, not just designed**: `docs/rollback-runbook.md` records a real dry run, closed 2026-09-06, on one real machine — stock NanoClaw → Isthmus → stock, live Telegram round trip confirmed at every stage, the existing agent container **adopted, not recreated**, in both directions, zero data loss. Still only one machine's one dry run (the runbook's own caveat: "treat the backup step as required until more testers confirm this in practice"), and it predates this promotion's own v2.4.0 pin move — H2/H3 below are about extending an already-proven mechanism to the specific source versions this promotion cares about, not building something from nothing |
| H2 | **Acceptance test, source = nanoclaw v2.3.0**: starting from a clean plain nanoclaw v2.3.0 install, run the identified path end to end and verify all of: existing user data and configuration preserved; credentials are not copied into any location the kernel wouldn't admit as a valid mount; groups, sessions, mounts, and central DB state remain valid after migration; the resulting installation is running Isthmus pinned to the new v2.4.0 baseline; a deliberately-induced failure partway through leaves a recoverable state (not partial/corrupt); rollback behavior is documented **and produces the recorded rollback artifact above**; the whole procedure runs from a fresh checkout with no reliance on undocumented local state | **Done.** Full transcript, real commands and output: [`docs/promotion-v2.4.0-rollback-v2.3.0.md`](promotion-v2.4.0-rollback-v2.3.0.md). Ran on a disposable scratch worktree against the real `v2.3.0` tag, migrated (via the real `isthmus.sh`, non-interactively) to a local-only merge of this promotion's own branches standing in for the pinned v2.4.0 baseline (never pushed — those branches aren't merged to `main` yet). `data/v2.db` byte-identical (SHA-256 match) before migration, after migration, and after rollback back to v2.3.0; full `nanogo doctor` clean (zero FAIL) post-migration; a mid-flight `pkill -9` during the container step left one momentarily-orphaned re-exec'd child process and a transient lock file, both self-resolved with no manual intervention and no data corruption, and a subsequent run completed cleanly. **Caveat, stated plainly in the artifact**: this run skipped `auth`/`channel`/`onecli`/`service` to make full non-interactive automation possible (no known non-interactive preset for the channel picker; deliberately avoided triggering a real OAuth device-flow or OneCLI registration unprompted), so "credentials land nowhere kernel-inadmissible" and "a live running container is adopted, not recreated" are **not** re-proven by this run — they rest on H1's 2026-09-06 real-auth, real-Telegram dry run. Also surfaced, not a promotion blocker but worth a follow-up: the setup wizard's stall-detector prompt (`setup/lib/windowed-runner.ts`'s `handleStall()`) has no default and hangs forever on non-TTY/closed stdin after 60s of silence from a slow step — worked around here by pre-building the container image out-of-band before invoking the wizard |
| H3 | **Acceptance test, source = nanoclaw v2.4.0**: the same full checklist as H2, including its own rollback artifact, against a clean plain nanoclaw v2.4.0 install instead | **Done.** Full transcript: [`docs/promotion-v2.4.0-rollback-v2.4.0.md`](promotion-v2.4.0-rollback-v2.4.0.md). Same disposable-worktree method as H2, same migration target (the local-only throwaway merge standing in for the pinned baseline), `data/v2.db` byte-identical across migrate and rollback, `nanogo doctor` clean post-migration. A v2.4.0 source surfaced three things a v2.3.0 source didn't: (1) the setup wizard's skip-step name changed from `onecli` to `gateway` as a direct consequence of this same promotion's gateway-provider generalization — a real note for anyone with `NANOCLAW_SKIP=onecli` automation, not a defect; (2) running that step for real (before catching #1) hit 2 test failures in `onecli.test.ts`, root-caused to this machine's own ambient `ANTHROPIC_BASE_URL` env var beating the test's fixture value — confirmed a sandbox artifact of running nested inside a Claude Code session, not a real defect; (3) the failed attempt's partial file writes left uncommitted debris that blocked the next `git checkout` until precisely cleaned — a second, different-shaped demonstration of "a partial failure leaves recoverable state," resolved the same way H2's process-kill test was. Same caveat as H2: `auth`/`channel`/`gateway`/`service` were skipped, so real-credential and live-container-adoption claims still rest on H1's dry run |
| H4 | Confirm both H2 and H3 land the user on the identical resulting state (same pinned baseline, same expected behavior) — a v2.3.0-sourced and a v2.4.0-sourced migration are not allowed to diverge in outcome | **Done.** H2 and H3 both land on: the same `nanogo doctor` result (4 PASS, the same 2 documented WARNs — ADR-009 kernel-socket gap, ADR-013 darwin-egress gap — 0 FAIL), the same "You're ready!" wizard completion, and byte-identical `data/v2.db` preservation across their own migrate+rollback round trips. See the comparison table in `docs/promotion-v2.4.0-rollback-v2.4.0.md`'s H4 section. No divergence in outcome between the two source versions |

### Workstream I — Design Law closure (resolved: LAW-09 annotation + playbook, not a new law)

| # | Task | Status |
|---|---|---|
| I1 | Write up the methodology as a reusable, version-agnostic procedure | **Done** — `go-host/docs/upstream-promotion-playbook.md` |
| I2 | Record why an annotation, not a new law, under the existing LAW-09 rule | **Done** — `docs/design-laws.md`, "LAW-09, annotated: a repeatable promotion procedure" |
| I3 | Confirm the playbook actually holds up once Workstreams A–H are executed for real; amend it (it's a living document too) if any step proves wrong or incomplete in practice | Not started — depends on A–H |

## Promotion gate — do not move the pin until every box below is checked

Every box means PASSED + REQUIRED (or a named, dated, expiring exception
recorded per Workstream C's acceptance-record format), per "What 'the gate
passed' means" above — not merely attempted or run. **This section doubles
as the final PR's evidence index** ("PR boundaries," above): at promotion
time, each line below gets its blank checkbox replaced with a direct link
to the evidence satisfying it, and that filled-in version ships as part of
the final pin-move PR.

**Status as of 2026-09-26** (interim snapshot for external review on this
plan's own PR, [#50](https://github.com/prathish-ks/isthmus/pull/50) —
not yet the final filled-in version this section describes above, which
still ships only with the pin-move PR itself once every line below is
truly checked): implementation for every workstream is complete and
locally verified across two branches (`feat/mount-gateway-trust-class`,
`feat/gateway-provider-seam`) plus this planning branch's own docs. The
one thing genuinely outstanding across the board is **real GitHub
Actions CI evidence** — neither implementation branch has a PR open yet
(see "PR boundaries," above, and the reply on this thread), so every
green result below is `pnpm`/`go test`/`bun test` run locally in a
worktree, not yet the formal required-gate run itself. That's exactly
what opening PR #1 (kernel capability) and PR #2 (gateway bypass
closure) resolves — flagged per-line below rather than glossed over.

- [x] Workstream A complete and tested (E1, E2 PASSED + REQUIRED, A6) — A1–A6 all closed, `feat/mount-gateway-trust-class`. E2/A5's live-Docker evidence is real (a real daemon, `-race`, both new tests executed with `CONFIRMED LIVE` log lines — see A5's row) but run locally; the formal GitHub Actions run of `go-multi-container-live-docker` is pending PR #1
- [x] Workstream B: every row resolved, no "not yet assessed" remaining — closed across `feat/mount-gateway-trust-class` (commit `79465865`) and `feat/gateway-provider-seam` (C14)
- [x] Workstream C: every finding closed, or covered by a complete acceptance record (C5) — zero bare "accepted" notes — C0–C15 closed, `feat/gateway-provider-seam`; C5's own accounting is zero acceptance records (every finding closed outright, see E4)
- [x] Workstream D: the file-inventory artifact (D0) exists, has zero unclassified rows and zero Bucket B rows without a security-review status (D4) — `docs/promotion-v2.4.0-file-inventory.csv`, 526 rows, this branch. This one doesn't depend on CI — it's a real, already-merged-to-this-branch file, reviewable now
- [ ] Workstream E: full suite green per "What 'green' means" on real CI, not local-only — **the one row this snapshot cannot check.** Locally: `pnpm exec vitest run` 4098 pass / 77 pre-existing-and-recorded-exception fail (E5), `bun test` 343 pass/1 skip/0 fail, `go test -mod=vendor ./... -race` all packages ok. E5's own row already says it plainly: "the formal required-CI-gate run... is still outstanding." Resolves the moment PR #1/#2 are opened and `ci.yml` runs green on GitHub
- [x] Workstream F: ADR(s) merged, compatibility docs current — ADR-028 (F1(a)), ADR-029–034 (F4), all on this branch; F6 deliberately not written yet (correctly blocked on G4 — see F6's own row)
- [x] Workstream G: CI coverage added and REQUIRED for every new privileged surface this promotion introduces (G1–G3), no report-only substitutions — G1 (`go-multi-container-live-docker`, commit `1c9b6903`), G2 (verified against the real `ci.yml`, no new job needed), G3 (confirmed N/A — see G3's row for the full re-verification). All three are about whether `ci.yml`'s *configuration* names the right required jobs, which is true today regardless of whether a GitHub-hosted run has executed it yet — that's what E's outstanding box tracks
- [x] Workstream H: H2 and H3 acceptance tests both pass, each with its recorded rollback artifact, H4 confirms matching outcomes — [`docs/promotion-v2.4.0-rollback-v2.3.0.md`](promotion-v2.4.0-rollback-v2.3.0.md), [`docs/promotion-v2.4.0-rollback-v2.4.0.md`](promotion-v2.4.0-rollback-v2.4.0.md), H4 comparison table in the latter. This workstream's evidence is command-log transcripts, not CI — already real and reviewable now
- [ ] **Tag/commit immutability re-check**: re-run Workstream B/C/D's classification against the *live* v2.4.0 tag one more time immediately before promoting (catches drift since Step 0); confirm the tag still resolves to the same commit (`143db6c9`) captured at the start of this plan and has not moved; record the final verified commit SHA in this document's changelog at promotion time — by design, not done until immediately before promoting (G4)
- [ ] `docs/upstream-pin.json` + `docs/baseline.md` updated together with the closing ADR (G4) — in the final pin-move PR only, per "PR boundaries" above — by design, this is G4 itself, the last step

## Open questions / risks (living list)

- Migration entry point for nanoclaw→Isthmus not yet confirmed to exist as a
  named, current skill (see "Migration continuity" section).
- `container-runner.ts`'s ~900-line diff combines two independently-landed
  upstream efforts (gateway-session-lifecycle, load-bearing; durable-host
  coordination, upstream-confirmed inert) — reconciling Isthmus's own
  modifications against this file needs to track which lines belong to
  which stream, not treat it as one block.
- Whether `internal/kernel`'s wire protocol needs a version bump (A2) is
  undetermined — now gated on producing the mixed-version compatibility
  matrix, not a standalone yes/no call.
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
- 2026-09-25 — Design Law question resolved (confirmed by the user, ahead
  of Workstream I's original "decide at the end" scoping): no new law.
  Wrote `go-host/docs/upstream-promotion-playbook.md` (the reusable,
  version-agnostic procedure) and the LAW-09 annotation in
  `docs/design-laws.md` that points to it. This document updated to
  reference the playbook rather than carrying the methodology inline.
  Workstream I's remaining task is confirming the playbook holds up once
  Workstreams A–H actually execute.
- 2026-09-25 — Clarified the second non-goal, which read as excluding CI
  coverage for the core pin's own new surfaces (it did not mean that —
  it excludes adopting the optional `add-iron-proxy` *skill* and its own
  `iron-front` job, a separate downstream decision). Strengthened
  Workstream G from "assess whether" to a required deliverable (renumbered
  G1–G4), updated the promotion-gate checklist line to match, and carried
  the same correction into the reusable playbook's Step 6 so it holds for
  every future promotion, not just this one.
- 2026-09-25 — Addressed a Copilot PR review on this plan's own first
  draft (all points assessed as sound and incorporated, none disputed):
  fixed the "ten-step" claim (playbook is eleven steps, 0–10); fixed a
  stale `(G3)` reference in the promotion gate to `(G4)` after the earlier
  renumbering; added Workstream D0, a required machine-readable file
  inventory artifact, replacing the earlier prose diffstat as the gating
  evidence; added full acceptance-record requirements to Workstream C's
  C5 (named approver, expiry, threat model, regression test, etc.,
  replacing bare "accepted and documented"); added "What 'the gate passed'
  means" distinguishing RUNNING/PASSED/REQUIRED, and applied it to A5/E2/
  G1 so the new live-Docker coverage can't be satisfied by a report-only
  run; added A2's mixed-version TS-host/Go-kernel compatibility matrix and
  rollout questions; converted Workstream H's H2/H3 into concrete,
  itemized acceptance tests instead of open-ended "verify it handles X"
  statements; added "What 'green' means" (baseline test policy: zero
  failures, not zero-new-failures, with a named/expiring exception process
  matching Workstream C's); added tag/commit immutability re-verification
  to the promotion gate's final line; added the "PR boundaries" section
  separating implementation PRs from the final pin-only PR. Corresponding
  durable corrections (step count, CI-required language, acceptance-record
  requirements) also applied to `go-host/docs/upstream-promotion-playbook.md`
  so future promotions inherit them.
- 2026-09-25 — Addressed a follow-up (explicitly non-blocking) Copilot
  review round, three points: (1) G1/A5/E2 now carry an explicit
  Definition-of-done requiring the actual `.github/workflows/ci.yml`
  `needs:`/success-check edit as evidence, not just a design decision, plus
  placeholder job names (`go-mount-gateway-trust-check`,
  `go-multi-container-live-docker`) so the requirement isn't purely
  abstract pre-implementation; (2) the file-inventory artifact (D0) now has
  a fixed, decided-once CSV schema with an exact header row, rather than
  leaving "CSV, JSON, or a table" open to drift; (3) Workstream H's H2/H3
  now require a recorded rollback artifact (an executed command log or a
  walked-through operator checklist, checked into the repo) per source
  version, not just a "rollback behavior is documented" claim. All three
  carried into `go-host/docs/upstream-promotion-playbook.md`'s Steps 2, 6,
  and 7 so future promotions inherit them too.
- 2026-09-25 — A further review round raised four points; two (the CSV
  inventory schema, the migration rollback artifact requirement) were
  already fully addressed in the immediately preceding commit
  (`4f3f89b1`) — verified directly against the pushed file before
  concluding that, rather than assumed — so this round's review appears
  to have run against a version of the PR from before that push landed.
  The two genuinely new points were incorporated: added an "Artifact
  index" section near the top of this document (one line per evidence
  type — diff inventory, security acceptance records, ADRs, CI evidence,
  migration rollback artifacts, the final pin update — naming exactly
  where each lives); and formalized the final pin-move PR's "links to the
  evidence" requirement into a concrete one-page evidence index, defined
  as the Promotion Gate checklist itself with each line's checkbox
  replaced by a direct evidence link at promotion time (no new artifact
  invented beyond reusing that existing section). Both carried into
  `go-host/docs/upstream-promotion-playbook.md`'s Step 9 and the
  per-promotion instance template.
- 2026-09-25 — Execution begins. Workstream A1/A6 done:
  `feat/mount-gateway-trust-class`, commit `5dd6ec64` (separate worktree/
  branch, per "PR boundaries" — not this planning branch). Ported the
  `gateway-trust` `MountClass` to `internal/mount`, found and fixed a
  real bug the port itself exposed (an unset `GatewayTrustRoot` silently
  misclassified every mount, caught by running the existing test suite
  before assuming the port was correct), added table-driven tests
  including a genuine two-container case proving the class works on a
  non-agent auxiliary role. Full `go-host` suite green including
  `-race`. A2 (wire payload + mixed-version compatibility matrix), A3
  (executor: network creation + multi-container spawn — no upstream Go
  source to port from), A4 (hardening posture), and A5 (live-Docker
  tests, blocked on A3) remain. Continuing sequentially.
- 2026-09-25 — Workstream A2 done: `feat/mount-gateway-trust-class`,
  commit `41af3c5f`. Added `NetworkAccessIntent`/`NetworkAccessTarget` to
  `internal/mount`, bumped `ProtocolVersion` to `v2` per
  `internal/kernel/doc.go`'s own pre-existing versioning policy (not a new
  design decision, an unexecuted existing one), and resolved the
  mixed-version compatibility matrix by reading `server.go`'s actual
  dispatch logic rather than guessing: exact-string version check before
  any payload decode means a mismatch is always a clean, explicit
  rejection in both directions, never a silent misparse. Found and fixed
  a real regression: a pre-existing test hardcoded `"v2"` as its
  "unsupported version" fixture, which the bump silently made correct
  instead of wrong — fixed to derive from the live constant. Confirmed
  via reading `exec.go` that A3's actual job is replacing
  `findAgentContainer`'s current explicit refusal of any non-agent-role
  container (mirroring old pre-Iron-Proxy TS exactly) — the multi-
  container wire *shape* already existed (`mount.Session.Containers` was
  already a slice), narrowing A2's real scope versus the original
  estimate. Full `go-host` suite green including `-race`. Continuing to
  A3 next (the executor — the largest, most security-critical remaining
  piece of Workstream A).
- 2026-09-25 — Workstream A3 done: `feat/mount-gateway-trust-class`,
  commit `2a093034`. The executor itself — the largest, most
  security-critical piece of Workstream A. Full `Wake`/`Kill` port of
  upstream's multi-container/network logic (per-session `--internal`
  network, `--read-only` auxiliary containers, alias-based network
  connect, ordered start, full atomic-rollback-on-failure, symmetric
  teardown). Real regression tests, not just argv assertions: a positive
  test proving the accepted multi-container case actually creates and
  starts everything correctly, a rollback test simulating a mid-sequence
  failure and confirming the already-created auxiliary and network both
  get torn down, and a teardown-order test with two auxiliaries so
  "reverse order" is observed, not assumed. Updated the old blanket
  "auxiliary containers denied" tests (both the exec.go-level and
  capability.go-level ones) rather than deleting them — they still
  correctly deny the no-matching-networkAccess-target case, just for the
  accurate reason now. Full `go-host` suite green including `-race`.
  Explicit scope note: upstream's paired auxiliary health-check addition
  (DockerHandle.status()) has no Go equivalent yet — named as a gap, not
  silently dropped. A5 (live-Docker tests against a real daemon) is now
  unblocked; A4 partially addressed (the `--read-only` hardening),
  broader posture assessment still open.
- 2026-09-25 — Workstream A closed out (A4, A5) and G1 resolved. A4:
  confirmed no further gap by re-checking upstream's own diff directly —
  `--read-only` (already ported in A3) is the only role-based hardening
  difference upstream makes anywhere; going further would be a genuine
  new hardening decision beyond this promotion's scope, noted as a
  possible future ADR rather than silently added. A5: live-Docker tests
  written (`feat/mount-gateway-trust-class`, commit `1c9b6903`) against
  `mount_confinement_live_docker_test.go`'s exact conventions — real
  `--internal` network + membership check, DNS-based reachability/
  isolation proof, real read-only-filesystem write-attempt proof — and
  `go-multi-container-live-docker` wired into `ci.yml` as **required**
  (a deliberate departure from every other live-Docker job in the file,
  all report-only), matching this document's own "What 'the gate passed'
  means" policy for the one new capability this promotion adds. **Not yet
  verified on a real daemon** — no Docker in this sandbox; the first real
  CI run is genuinely the test, not this compile-and-skip-cleanly check.
  G1: confirmed the existing required `go-host` job already runs A1/A2/A3's
  unit tests unconditionally (`go test -race ./...`), so no new job was
  needed for those — only the live-Docker piece genuinely required new,
  required CI, which the above closes. Workstream A is now
  code-complete; its only open item is real-CI verification of A5/E2.
  Moving to Workstream B (seam call-sequencing audit) next.
- 2026-09-25 — Workstream B's urgent slice closed: the TS↔Go protocol-version
  mismatch A2 introduced (Go bumped to `"v2"`; TS's `KERNEL_PROTOCOL_VERSION`
  was still `'v1'`, which would have been a clean-but-total
  `unsupported-version` break for every real wake/kill/build-image call) is
  fixed, along with the rest of the gateway-trust/networkAccess TS-side port
  (`feat/mount-gateway-trust-class`, commit `79465865`): `kernel/protocol.ts`,
  `kernel/client.ts`, `drivers/types.ts`, `drivers/index.ts`,
  `drivers/spec-fixture.ts`, `drivers/docker-driver.ts`,
  `drivers/conformance.test.ts` — full row detail in the Workstream B table
  above. `drivers/docker-driver.ts`'s `auxiliaryContainers` capability
  flipped to `true`: Go's `Wake` (A3) already owns realizing every container
  in a spec, so the TS-side refusal for non-agent roles was a stale
  backstop once A3 landed, not a real constraint. `pnpm exec tsc --noEmit`
  clean; full `pnpm test` green (3972 tests, 325 files); `eslint` on every
  touched file shows only pre-existing `no-catch-all` warnings, zero errors,
  nothing new. Remaining Workstream B rows (`session-events.ts`,
  `container-runner.ts`, `cli/resources/groups.ts`, the agent-to-agent and
  kernel-supervisor modules) are the seam's non-urgent half — no protocol
  break behind them — continuing next per the standing "proceed
  autonomously" instruction.
- 2026-09-25 — Workstream B's remaining rows assessed. Four resolved clean
  with no change needed (`session-events.ts`'s `reconcileNetworkAccess`
  deferred to Workstream C by design, not ported ahead of that ADR;
  `agent-route.ts`/`create-agent.ts`'s `wakeContainer`→`requestWake` swap
  confirmed inert by reading upstream's own `request-wake.ts` doc comment;
  `cli/resources/groups.ts`'s kernel-seam slice (same wake-routing swap)
  confirmed clean, its two unrelated feature additions (`--speed` tiers,
  the `connect` gateway-account-connection operation) flagged for
  Workstream D instead of assessed here, since neither touches the kernel
  seam; `kernel-supervisor/index.ts` confirmed Isthmus-only, no upstream
  equivalent, no version-sensitive logic). One row **escalated**:
  `container-runner.ts`'s diff, read in full, turns out to bundle a third,
  previously-uncharacterized concern beyond the two the data-shape pass
  had already flagged — a "provider host contract" mount-composition
  rewrite (`getProviderHostContract`/`realizeProviderSpawnSurfaces`) that
  is orthogonal to gateway-trust and changes how *every* provider's
  mounts get composed, not just a gateway's. `composeSessionSpec`'s own
  small, gateway-specific diff (`networkAccess: gateway.networkAccess`,
  `containers: [agent, ...(gateway.containers ?? [])]`) is exactly the
  production call site the Workstream A/B kernel-side work exists to
  receive, and confirms it stays unreachable until composition actually
  builds a non-empty `gateway` object — consistent with everything else
  found this session. Given the security-sensitive blast radius of a
  mount-composition rewrite on a fork whose entire premise is a hardened
  mount/trust boundary, and that this finding was not visible in the
  original planning pass, this is being surfaced to the user rather than
  ported autonomously — see the chat turn following this entry for the
  full writeup and the two follow-on ADR decisions this implies
  (gateway-session-lifecycle adoption, already anticipated by Workstream
  C's Non-goals carve-out; and, newly, provider-host-contract adoption).
  Workstream B is otherwise complete: every row assessed, the urgent
  kernel-compatibility slice shipped and tested.
- 2026-09-25 — Workstream C0 resolved: read upstream's gateway-session-
  lifecycle bundle in full (`container-runner.ts`'s gateway functions,
  `gateway-provider-registry.ts`, `gateway-session-lifecycle.ts`) to
  understand what it actually does, rather than deciding from the earlier
  surface-level read. Checked it against all nine design laws in
  `go-host/docs/design-laws.md` and recorded the decision in
  [`ADR-029-gateway-session-lifecycle-adoption.md`](../go-host/docs/ADR-029-gateway-session-lifecycle-adoption.md):
  decline the multi-host claim/lease layer (`session_claims`/
  `host_instances`) outright — it is distributed-system machinery solving
  session ownership across multiple concurrent host processes, a topology
  Isthmus's single-host architecture doesn't have, which is LAW-05's named
  failure signal almost verbatim. Defer the gateway-provider orchestration
  layer itself (typed contribution, fail-closed availability watching, and
  its own parallel approval-subsystem contract) until Isthmus actually
  adopts a concrete gateway provider — nothing registers one today, and
  porting the orchestration with no consumer is feature growth ahead of an
  actual need (LAW-03), while the provider's own approval contract would
  otherwise sit beside `guard()`/`modules/approvals/` as a second,
  incoherent approval surface (LAW-04) if ever wired up unmodified. The
  kernel-side admission work from Workstream A/B needs no changes under
  either branch of this decision — it was already scoped to just the
  mount/network shape a contribution produces, independent of what
  composes it (LAW-07's "exclusive enforcement" reading, already annotated
  in this same design-laws.md). C1/C2 stay correctly blocked; 11 more file-
  inventory rows (the multi-host coordination files, plus
  `gateway-provider-registry.ts`/`gateway-read-policy.ts`/
  `gateway-session-lifecycle.ts` and their tests) classified in the CSV
  citing this ADR. C3/C4 remain open and independently executable.
- 2026-09-25 — **ADR-029 superseded by ADR-030, same day.** Reading
  upstream's actual `docs/gateway-seam.md` contract doc (rather than
  inferring from the `GatewayProviderDefinition` type signatures alone, as
  ADR-029 had) surfaced two corrections: the gateway-provider's approval
  subsystem is not a second, parallel approval engine — it's a thin
  protocol translator feeding the single core-owned
  `gateway-approval-coordinator.ts` flow every provider shares, so ADR-029's
  LAW-04 concern doesn't hold; and gateway-provider selection turns out to
  be **mandatory**, not optional, for a ported v2.4.0 host to start at all
  ("With no provider registered, the host refuses to start: there is no
  implicit default and no open-egress fallback" — upstream, verbatim),
  which invalidates ADR-029's LAW-03 "defer, nothing consumes it yet"
  reasoning. Separately, direct confirmation landed that multi-tenant,
  multi-replica cloud hosting is a real near-term direction, not
  speculative — which flips the LAW-05 calculus on the multi-host
  claim/lease layer specifically, since a confirmed real use case changes
  "unjustified distributed-system complexity" into "cheap, already-tested
  infrastructure worth adopting now rather than rebuilding later." **New
  decision, [ADR-030](../go-host/docs/ADR-030-gateway-adoption-and-multi-host-coordination.md):
  adopt all of it** — OneCLI restructured into `GatewayProviderDefinition`
  (new task C7, sequenced first since it's load-bearing for the host to
  start), the multi-host claim/lease coordination ported in TypeScript (C9,
  independent of C7/C8), and `/add-iron-proxy` installed on par with
  upstream's own gateway catalog (C8, sequenced last as the most involved:
  a local Docker-built proxy, an Iron Control console, gRPC bridge
  dependencies). The Go kernel needs zero changes under this decision
  either — confirmed again directly against `go-host/internal/kernel/
  server.go`'s `net.Listen("unix", socketPath)`: the kernel is inherently
  machine-local, one per node regardless of how many TypeScript host
  replicas run, and none of C7/C8/C9 asks it to become anything else. The
  Non-goals section's stance against installing `add-iron-proxy` is
  reversed; 49 file-inventory rows reclassified from `declined:non-goal`
  (citing ADR-029) to adopted (citing ADR-030) — 38 the `add-iron-proxy`
  skill payload itself (Bucket C, Workstream C8), 11 the ADR-029-tagged
  gateway/multi-host files (2 moved to Bucket B where they're literally
  C1/C2's subject — `gateway-read-policy.ts`, `gateway-session-lifecycle.ts`
  — the rest to Bucket A as seam-adjacent). C7/C8/C9 are real, substantial
  implementation work, not documentation — none of it has been written yet.
- 2026-09-25 — **C7 and C9 shipped, real code with real tests, per the
  standing "proceed autonomously" instruction.** C7 (`feat/gateway-provider-
  seam`, commit `0bb51506`): OneCLI restructured onto the full
  `GatewayProviderDefinition` contract; new `gateway-approval-coordinator.ts`
  extracts the generic approval flow out of the old OneCLI-only module so
  Iron Proxy (C8) reuses it. Porting the existing 682-line test suite
  caught two real regressions before they shipped — the card's displayed
  agent name has to come from a DB lookup, not the SDK's own name, and a
  request with no external id is "no known scope," not a hard denial.
  C9 (commit `e52c34a5`): `session_claims`/`host_instances` ported and
  wired into `container-runner.ts`'s spawn/adoption path, correcting
  upstream's own stale "shadow state" doc comments along the way (the
  claim-acquisition read genuinely gates spawn behavior — confirmed by
  reading `claimSessionRun` directly, not by trusting the module header).
  Both: `pnpm exec tsc --noEmit` clean, full `pnpm test` green (3987 tests,
  up from 3972 pre-C7), `eslint` clean except pre-existing warnings.
  C3/C4 done too: C3 confirmed by direct code trace (not inference) that
  OneCLI's credentials still route exclusively through the kernel-admitted
  mount/env validation path, no new bypass. C4's repo-wide sweep found one
  substantial, previously-unmentioned item — `src/community-portal/`
  (~2,990 lines, new in v2.4.0): a client for `portal.nanoclaw.dev`, an
  upstream-operated hosted service, with its own per-machine device
  identity key and a managed-Slack-install worker process. Recommended
  **not** to adopt as part of this promotion — a separate product/trust
  decision (does an Isthmus install register with and phone home to
  nanocoai's own infrastructure?), not a compatibility question — flagged
  for the founder rather than silently ported or silently dropped. C5 has
  nothing to process yet (no accepted bypass exists); C1/C2/C6 remain
  blocked on C8 landing a real gateway provider.
- 2026-09-25 — **C8 started, hit a real, evidence-based blocker.** Copied
  all 38 `add-iron-proxy` skill files verbatim from upstream v2.4.0
  (commit `c2b26b83`) — the skill is now present and catalogued
  (`gateway.json`'s `"default": false` correctly leaves OneCLI active),
  matching what "on par with upstream's catalog" means for Isthmus's own
  skill-invocation convention (direct `/add-<name>`, no generic picker UI
  needed or built). Tracing the skill's own imports before attempting to
  run anything found 7 files depending on two pieces of infrastructure
  that don't exist in this tree: `setup/gateways/credential-store.js`
  (upstream's generic gateway-picker/credential-storage machinery, never
  needed before since OneCLI is core-baked) and `src/provider-contracts/
  index.js` — which is not a new discovery: it's the exact provider-host-
  contract rewrite Workstream B flagged as its own undecided architectural
  question back when it was found tangled in `container-runner.ts`'s
  diff. This confirms that finding was substantive, not speculative —
  Iron Proxy cannot function without a decision on it. Stopping here
  rather than unilaterally deciding to also adopt `provider-contracts`
  and build `setup/gateways/` from scratch — both are real scope
  expansions beyond what ADR-030 decided, and the kind of decision the
  standing "proceed autonomously... as far as you don't need any key
  decisions" instruction doesn't cover. The proxy binary/console/gRPC
  bridge pieces stay unverifiable in this sandbox regardless (no Docker),
  so even a decision to proceed only gets C8 to "code written, CI-
  verification pending" the way A5 already is.
- 2026-09-25 — **`provider-contracts` blocker resolved — narrow, not the
  full port, per direct discussion.** Checked precisely what the 7
  dependent Iron Proxy files call (`getProviderModelEndpoint`/
  `providerModelAllowedHosts`, plus `--speed`'s `inference.speedTiers`) and
  confirmed none of it touches the mount/file-composition half of upstream's
  `ProviderHostContract` — the half that would have meant rewriting
  `buildMounts` for Claude/Codex/OpenCode, not just the gateway. Ported only
  what's used (commit `7d45ffc5`): `src/provider-contracts/registry.ts` +
  `claude.ts`, field names matching upstream's contract for painless
  extension later if the mount-composition rewrite is ever separately
  decided. This also completed a real functional gap in C7:
  `gateway-approval-coordinator.ts` now auto-approves `'default'`-trigger
  requests (ordinary provider API traffic) to a declared model domain,
  instead of asking a human to click through every normal Claude API call —
  matching upstream's own design, which C7 shipped without. Verified with a
  new test file driving `decide()` through a stub gateway provider, since
  OneCLI's own requests are always `trigger: 'policy'` and can never reach
  this branch. Full `pnpm test` green (3999 tests, up from 3987).
  `setup/gateways/` (the interactive picker/credential-storage UI) remains
  unbuilt — needed only for Iron Proxy's own `scripts/setup.ts`, which
  can't finish in this sandbox anyway (no Docker daemon to build the proxy
  image or start Iron Control). Iron Proxy stays catalogued but not
  runnable; nothing else in this promotion is blocked on it.
- 2026-09-25 — **A real Docker daemon became available in this sandbox.**
  Immediately used it for the evidence this whole promotion has been
  explicitly caveating as missing: `NANOCLAW_EC05_LIVE_DOCKER=1 go test
  -race ./...` against the full `go-host` module — every package green,
  `internal/kernel` included, both A5 multi-container tests actually
  executing (not skipping) with real `CONFIRMED LIVE` proof of the private-
  network isolation and auxiliary-read-only properties Workstream A3 was
  built to provide. A5 and E2 move from "code done, unverified" to
  genuinely done. The formal GitHub Actions run of `go-multi-container-
  live-docker` is still the actual required-CI gate (G1), but there is now
  real local evidence behind it where there was only reasoning before.
- 2026-09-25 — **C7/C9 verified live against the real TS host + real
  `nanogo` kernel + real Docker container** (`feat/gateway-provider-seam`,
  commit `18194f42`), complementing A5/E2's Go-level live-Docker evidence
  with the TS-side path those tests don't reach: `gateway-approval-
  coordinator.ts` (C7) and `container-runner.ts`'s claim/spawn wiring (C9)
  driven by an actual running kernel, not the fake NDJSON one the vitest
  suite uses. Found and fixed a real regression in the process: `scripts/
  ec07-live-host-smoke.sh` and `scripts/ec08-egress-lockdown-live-smoke.sh`
  each registered a `'none'` stand-in `GatewayProviderDefinition` using the
  pre-C7 single-`contribute()` shape; C7 widened the contract to
  `sessions.ensure()`/`approvals.subscribe()`, and since these are `tsx`
  scripts with no type-check step, the mismatch went undetected until a
  live run threw `Cannot read properties of undefined (reading 'subscribe'/
  'ensure')` out of `startGatewayApprovalCoordinator` and `spawnContainer`.
  Fixed both stubs to match the shape `drivers/seam-real-setup.ts`'s
  `noGateway` already uses correctly. After the fix: `ec07` passes 2/2
  (real kernel-mediated container wake, message round trip, kernel-mediated
  kill, confirmed gone); `ec08` passes (real container confirmed attached
  to exactly the internal `nanoclaw-egress` network with no default route
  out, round trip completes fully network-isolated, gateway-attach path
  exercised against a stand-in OneCLI container — the real `onecli`
  gateway container on this machine was identified via `docker inspect`
  before running anything and deliberately not touched, using
  `ONECLI_GATEWAY_CONTAINER` to point the harness at a disposable stand-in
  name instead).
- 2026-09-25 — **C1 and C2 resolved.** C1: traced end to end against the
  actual C7 code (upstream's `ensureGatewaySession`/
  `stopGatewaySessionsForUnavailability` names don't exist in this port —
  C7 calls `getGatewayProvider().sessions.ensure()` directly, once, inline
  in `spawnContainer`). Confirmed by grep that `driver.prepare(spec)` has
  exactly two call sites tree-wide: `spawnContainer` itself, and
  `session-events.ts`'s `withSessionEvents` wrapper, read in full and
  confirmed to be a transparent pass-through that adds event tracking only
  — it does not build or rebuild a spec, so it is not an independent path
  into the driver. No bypass found. The one real gap — `lease.release`/
  `lease.onUnavailable` never called anywhere — is the same one C7's own
  status row already named as a deliberate deferral (OneCLI's lease
  declares neither hook, so nothing is currently being skipped); becomes a
  must-close item once C8's Iron Proxy needs them, not a new finding today.
  C2: `gateway-read-policy.ts`, `permitsConfiguredGatewayRead`, and
  `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` do not exist anywhere in this tree
  (confirmed by repo-wide grep, zero matches) — upstream's read-only-
  gateway-destination allowlist was never ported, so there is no gate to
  audit yet. Recorded as a real porting-coverage gap for Workstream D's
  inventory, not silently closed as though the row's question had been
  answered. Both rows move C5 closer to processable but do not themselves
  add anything to C5 — C1 found no bypass to close, C2 found no feature to
  gate. C6 (security-review pass) is next.
- 2026-09-25 — **C6 done: three findings, two fixed, one flagged.** The
  `code-review`/`security-review` skills' own preflight couldn't run (bare
  `git` is broken in this environment, the same Xcode-CLT gap from earlier
  this session) — did the review directly with the same adversarial
  trust-boundary brief instead. Finding 1 (fixed, `feat/gateway-provider-
  seam` commit `480b5f83`): `internal/kernel/naming.go`'s `LabelsForKey` let
  a gateway-composed `ContainerSpec.labels` override the four canonical
  adoption labels every install's session-adoption logic trusts as ground
  truth — latent (no registered provider populates `.containers[].labels`
  yet) but a real cross-install impersonation vector the moment one does.
  Closed outright rather than deferred, verified via `git stash`-based
  negative control, full `go-host` suite green with `-race`. Finding 2
  (fixed, commit `1de80602`): a gateway-named `approverUserId` was never
  written to the persisted approval row, so `isAuthorizedApprovalClick`
  silently widened "this one verified identity decides" to "any admin for
  the group decides." Fixed narrowly — `request.approverUserId ?? null`,
  deliberately not the reviewing agent's own suggested `?? resolvedTarget.
  userId`, which would have wrongly over-narrowed the common unnamed-
  approver case (caught by tracing where `resolvedTarget` actually comes
  from before trusting the suggested fix). New tests via a stub gateway,
  same negative-control discipline, `tsc --noEmit` clean. Finding 3
  (flagged, not fixed): OneCLI's `allowlisted-extra`-class provider mounts
  carry no host-path restriction at kernel admission at all, by design —
  fixing this properly means a new restricted `MountClass` or grammar-level
  path validation, a real design decision rather than something to build
  unilaterally, held to the same bar as C8's `provider-contracts` blocker,
  C4's `community-portal` finding, and H1's migration-path finding. Full
  findings, severities, and fix rationale recorded in the C6 table row
  above. Workstream C now has only C5 (blocked on Finding 3's disposition)
  and the founder decisions from C4/H1/C6-Finding-3 outstanding.
- 2026-09-25 — **C6 Finding 3 fixed, on explicit direction.** OneCLI's
  `allowlisted-extra` provider mounts had no host-path restriction at
  kernel admission; fixed with a grammar-level allowlist rather than a new
  `MountClass` — read `@onecli-sh/sdk`'s actual compiled source (not
  inferred) and found it writes to exactly three fixed locations under
  `os.tmpdir()`: `onecli-proxy-ca.pem`, `onecli-combined-ca.pem`, and
  `onecli-stubs/onecli-stub-<basename>`. `contributionFromArgs`
  (`onecli.ts`) now refuses any `-v` mount whose (`path.resolve`d, so a
  `..` traversal can't escape it) host path isn't one of those, before it
  ever reaches `composeSessionSpec`. Existing test fixtures used made-up
  paths that never matched the SDK's real output shape — updated them to
  the real paths, and added a dedicated suite covering the new allowlist
  (a disallowed path, a near-miss sibling/wrong-prefix/traversal set, the
  combined-CA path, and an arbitrary correctly-prefixed stub name), all
  verified via the same `git stash`-based negative-control discipline as
  the other two fixes. Full `pnpm test` green apart from the pre-existing,
  unrelated bare-`git` environment failures (`scripts/update-skills*`,
  `scripts/update/transaction*`, `src/upgrade-state.test.ts` — all shell
  out to real `git` subprocesses for their own fixtures, broken since the
  machine restart earlier this session, not caused by this change).
  `feat/gateway-provider-seam`, commits pending.
- 2026-09-25 — **H1 corrected — the user caught a real miss.** The earlier
  H1 entry checked only `migrate-nanoclaw`/`update-nanoclaw` and concluded
  no nanoclaw→Isthmus path exists. Both skills were read correctly (they
  operate on a different axis entirely — catching a customized fork up
  with `nanocoai/nanoclaw`'s own upstream), but that was the wrong answer
  to H1's actual question, because `isthmus.sh` — sitting in this same
  repo's root, named directly in `CLAUDE.md` — was never checked. The real
  path is an **in-place** migration (same checkout, same `data/`
  directory): `isthmus.sh` detects an existing install via
  `data/upgrade-state.json`, installs the `nanogo` kernel binary, hands
  off to the ordinary installer, and stamps the upgrade marker. It is
  genuinely tested, not just designed: `docs/rollback-runbook.md` records
  a real dry run (closed 2026-09-06) — stock NanoClaw → Isthmus → stock,
  on one real machine, live Telegram round trip confirmed at every stage,
  the agent container adopted rather than recreated in both directions,
  zero data loss. H1 marked done with the corrected finding; H2/H3
  unblocked and reframed as extending this already-proven mechanism to the
  specific v2.3.0/v2.4.0 sources and this promotion's new pin, not
  building a path from nothing. Also answered a follow-up question this
  correction enabled: whether an existing nanoclaw user's community-portal
  login survives migrating to Isthmus — very likely yes on the client side
  (the identity files live outside anything `isthmus.sh` touches, and the
  portal client sends no product-identifying header), with the genuine
  unknown being nanocoai's own closed-source server-side policy, which no
  amount of reading this repo's code can resolve. Recorded in C4's row.
- 2026-09-25 — **C6 Finding 3 marked fixed** (the table row previously said
  "flagged, not fixed" after the fix had already landed — corrected to
  match the actual commit, `66287909`, from the same session).
  **Community-portal adoption reversed, by direct founder decision:
  [ADR-031](../go-host/docs/ADR-031-community-portal-adoption.md).** Two
  corrections drove the reversal: it is not redundant with an independent
  Isthmus feature (`docs/hardened-image.md`'s existing hardened-image
  opt-in *is* the same Echo/nanocoai hosted service the portal's `echo`
  perk offers — Isthmus already depends on part of this ecosystem), and
  the real scope is not purely additive (`setup/registry-login.ts` already
  exists in Isthmus but in a narrower shape than v2.4.0's — porting means
  upgrading a live, already-depended-on file, not just adding new ones).
  Checked against all nine design laws in the ADR; no law blocks adoption,
  LAW-05's real complexity cost is named rather than minimized, and
  LAW-06/LAW-08 name concrete obligations (contract-test the existing
  `registry-login.ts` behavior before extending it; verify the ported
  code matches upstream's own stated privacy posture) the new tasks below
  must satisfy before they count as done. New tasks: **C10** (upgrade
  `registry-login.ts` under contract tests, sequenced first — load-bearing
  for C11) and **C11** (port `src/community-portal/` +
  `setup/portal.ts`/`setup/slack-worker.ts`, wire into the setup wizard,
  LAW-08 security-review pass). Neither started yet — this session's work
  was the decision and its recording, not the port itself.
- 2026-09-25 — **C10 and C11 done, community-portal fully ported and
  wired.** C10 (commit `f04f3593`): upgrading `registry-login.ts` turned
  out to be mostly an export, not a port — Isthmus's existing device-flow
  implementation already matched v2.4.0 almost function-for-function.
  Added `startDeviceFlow`/`finishDeviceFlow` as thin wrappers around the
  already-correct primitives, extracted `notABroker()` (verified
  behavior-preserving via a pre-refactor characterization test, LAW-06).
  C11 (commit `e4085087`): ported the portal client and setup-wizard
  wiring. The real work here was a finding, not just a copy — upstream
  also modified four *existing* Isthmus files (`run-channel-skill.ts`,
  `companions.ts`, `slack-auto-register.ts`, `slack-auto.ts`) as part of
  the same upstream change, missed on the first dependency pass (which
  only checked `portal.ts`'s own imports) and caught only because the
  ported tests hit real skill-application machinery instead of a
  superficial mock gap. All four reconciled against Isthmus's own
  divergence feature-by-feature, not overwritten; every touched file's
  existing test suite updated to match upstream's own test diff, not
  just patched until green. LAW-08 check done and clean (zero mount/spec
  references anywhere in the ported code, confirmed by grep; outbound
  headers limited to exactly what `docs/hardened-image.md` discloses).
  Both workstreams green on `pnpm exec tsc --noEmit` and the full test
  suite, apart from the same pre-existing bare-`git` environment
  failures tracked throughout this session. One more finding along the
  way, unrelated to correctness: a stray, inconsistent uncommitted
  change surfaced in `src/channels/index.ts`/`package.json` mid-session
  — not produced by anything run intentionally here, most likely
  cross-talk from another concurrent worktree sharing this repo (this
  checkout already carries unrelated stashes from other branches).
  Stashed rather than discarded, recorded in C11's row for the founder's
  awareness. With C10/C11 done, Workstream C is now fully closed —
  correction to this entry's own earlier draft, which wrongly implied
  C5 and H1 were still open: C5 closed the same session (zero
  acceptance records ever needed — every finding was fixed outright,
  not accepted), and H1 was already corrected and resolved earlier
  (`isthmus.sh` is the real, dry-run-tested migration path). Nothing in
  Workstream C remains open.
- 2026-09-25 — **Scope-policy decision recorded, C12 (community-portal
  runtime, adopt-with-modification) and C13 (host-sweep incarnation-gate
  fix) done; autonomous execution begins.** Founder direction, verbatim
  intent: the scope bar for this promotion is "genuinely part of v2.4.0,"
  not "small enough to be convenient" — reopens the provider-host-contract
  mount-composition rewrite, the community-portal runtime module, and the
  `reconcile-session.ts` cluster for adoption; does not reopen
  OneCLI-stays-core or Iron Proxy's sandbox-blocked `setup/gateways/`.
  Recorded in this doc's Non-goals section. C12 (commit `929dbc98`):
  `src/modules/community-portal/` ported with the founder's required
  modification — `CellLink`'s persistent WebSocket removed entirely,
  every reconciliation driven purely by the existing interval timer
  (poll on demand, not push). C13 (commit `cb52a92d`): while scoping the
  `reconcile-session.ts` cluster, found that Isthmus's own
  `host-sweep.ts` already independently duplicates upstream's
  stuck-container detection logic but predates C9's claim/lease
  coordination and so lacks an "incarnation gate" — a freshly-claimed
  container (e.g. after host failover) could be killed on its first SLA
  check purely because it inherited stale `outbound.db` state from the
  incarnation before it. Fixed directly in the existing function (not a
  port of the new `reconcile-session.ts`/`request-wake.ts` files, which
  were confirmed via direct `ls`/grep to not exist in this tree — an
  earlier Workstream B classification row had been misread as "already
  present" when it meant "safe to decline porting"). Both changes
  typecheck-clean and test-verified via `git stash`-based negative
  control, full `pnpm test` green apart from the same 77 pre-existing
  bare-`git` environment failures tracked throughout this session.
  Per the founder's direction to proceed autonomously to the end of the
  plan while away, a background agent was dispatched to deep-scope the
  provider-host-contract mount-composition rewrite (`container-runner.ts`
  `buildMounts`, `src/provider-contracts/*`) — its report is recorded in
  the next entry.
- 2026-09-26 — **C14 Steps 1-3 of 6 implemented and committed** (registry.ts
  widening, file-transformers.ts, realize.ts, project-doc-compose.ts's
  instruction-facts layer — see C14's own row for full detail, commits
  `defa4d29`/`03e884a9`/`56e60edc`). Two deliberate, documented divergences
  from upstream found and applied along the way, both correctness/security
  decisions rather than straight ports: the mount-surface-invariant
  relaxation in `registry.ts` (every mount/file field optional, so Claude's
  existing C8 registration keeps working unchanged while this lands in
  stages), and `realize.ts` reusing `project-doc-compose.ts`'s hardened
  `writeAtomic` instead of upstream's weaker startup-only one, since
  `realize.ts`'s file writes land in the same agent-writable, group-shared
  state-volume tree the original symlink-race fix protects. Step 4 (the
  `buildMounts` rewrite itself — the highest-blast-radius file in this
  promotion) deliberately deferred to its own session rather than rushed.
- 2026-09-26 — **C15 opened: the container-side provider-contracts port
  is also in scope, by direct founder decision.** The founder asked why
  the container-side abstraction couldn't just be imported, since Isthmus
  had "never touched" it — checked directly against the `v2.3.0` tag and
  confirmed correct: every current file under `container/agent-runner/src/
  providers/` is byte-identical to the v2.3.0 baseline. This is a genuine
  correction to this document's own C14 row, which had stated (without
  this direct verification) that the container-side files "diverge from
  v2.3.0's baseline" — they don't; that claim is removed from the record
  here and replaced with the verified fact. Real diff sizes measured
  directly against the v2.4.0 reference already pulled during C14's
  scoping: `providers/claude.ts` shrinks by 281 net lines as its logic
  moves into a new declarative contract layer; `claude-history.ts` and
  `claude-config.ts` are new files; the whole `provider-contracts/`
  directory (7 files) is new. Tracked as C15, not started — recommended
  to follow C14's completion rather than run concurrently with it, since
  both touch provider-registration surfaces and conflating them in one
  sitting risks confusing which contract a given change belongs to.
- 2026-09-26 — **C14 fully implemented (all 6 steps), a real regression
  found and fixed in the same pass, and a sandbox-capability correction.**
  Steps 4-6 (`buildMounts`/`resolveProviderContribution` rewrite, Claude's
  real `ProviderHostContract`, `group-init.ts`/`command-gate.ts`
  reconciliation) landed on top of the mechanism from Steps 1-3, in commits
  `26b0ae30` and `a5bcbcff` — see C14's own row and progress notes above
  for full detail on the `hasProviderMountSurface()` gate, the settings-
  content and `writeAtomic` divergence decisions, and the 176-test
  byte-identical-behavior verification. **Correction to this session's own
  earlier assumption**: `container/agent-runner/` (the Bun-side tree) was
  previously treated as untestable here because `bun-types` wasn't
  installed — that's fixed by simply running `bun install` in that
  directory (never attempted before), which restores both `bun run
  typecheck` and `bun test` fully. This matters directly for C15 (the
  container-side port, below) — it can be built with the same
  test-and-verify discipline as everything else in this promotion, not
  ported on faith. **Regression found this way, not assumed absent**:
  Step 6's `command-gate.ts` change (literal `Set([...])` → contract-
  derived) broke `container/agent-runner/src/formatter.commandLists.test.ts`,
  a drift guard that parses `command-gate.ts`'s source text to keep the
  container side's own hand-maintained command lists in sync (the two
  runtimes share no modules). Fixed in commit `52cfcc31` by teaching the
  guard to reconstruct the host side's expected sets from both
  `command-gate.ts`'s remaining literal strings and each registered
  provider contract's own `nativeAdmin`/`nativeFiltered` arrays, verified
  via a mutation test (a deliberately-added bogus command makes exactly
  the expected assertion fail) and the full container-side suite (343
  pass, 1 skip, 0 fail, up from 339 pass/4 fail). This is exactly the kind
  of dual-runtime drift this promotion's own "what 'green' means" section
  warns about — closing it required actually running the Bun suite, not
  trusting the Node-side green alone.
- 2026-09-26 — **C15 deep-scoped with real files, not the earlier
  estimate.** Pulled every relevant file directly from the real `v2.4.0`
  tag (`git show v2.4.0:<path>`, not the scratchpad copies the background
  agent used for C14's initial pass) and read the actual mechanism:
  `provider-contracts/registry.ts`'s `Capability<I>` function-or-constant
  type, `realize.ts`'s resolution path, `verifier.ts`'s shape/probe
  checks, `provider-registry.ts`'s two-step order-independent
  registration. Found the scope is larger than the earlier estimate in a
  concrete way: `poll-loop.ts` (the actual message-processing core loop,
  not just provider registration) reads `AgentProvider
  .supportsNativeSlashCommands`/`.emitsMidTurnText` directly in over ten
  call sites woven through content-door and mid-turn-delivery logic —
  both move to the contract (`commands.formatting`/`textDelivery`) in
  upstream's rewrite, so `poll-loop.ts` needs real reconciliation, not
  just the provider files. Also found a genuine, concrete divergence:
  upstream's container-side Claude contract categorizes `/remote-control`
  as an admin command, but Isthmus's own `formatter.ts` and host-side
  `command-gate.ts`/`provider-contracts/claude.ts` (both C14) categorize
  it as filtered — and `formatter.commandLists.test.ts`'s own header
  names this exact command as one that had already silently diverged in
  this fork's history. Confirmed the field is currently inert either way
  (only shape-validated, nothing reads it for real behavior), so no live
  bug today, but a verbatim port would plant a self-contradictory value.
  Recommended correction (not yet applied): match Isthmus's own
  already-tested categorization when this is implemented, the same class
  of decision as C14's settings-content divergence. Full findings
  recorded in C15's own row. Deliberately not implemented this session —
  the honest scope (provider files + `poll-loop.ts` + `index.ts` + two
  new files + a new directory, 2,300+ lines of live conversation-path
  code) needs its own unhurried pass, not the tail end of a session that
  already shipped all six of C14's steps plus a real regression fix.
- 2026-09-26 — **C15 mechanism implemented, tested, and committed**
  (`feat/gateway-provider-seam` @ `7af29867`). Ported the full container-side
  `ProviderRuntimeContract` resolution path scoped in the previous entry:
  `provider-contracts/{registry,realize,verifier,mock,names,index}.ts` (new),
  `providers/{claude-config,claude-history}.ts` (new, extracted from the old
  monolithic `claude.ts`), two-step order-independent registration in
  `provider-registry.ts`, `providers/claude.ts` rewritten to accept a resolved
  `ResolvedRuntimeConfiguration` as a required second constructor argument.
  Fixed 27 then 2 residual test failures across 7 test files as each one's
  direct `new ClaudeProvider(options)` calls needed the new argument, or
  needed to route memory-hook registration through the new module-level
  `registerProviderMemorySessionHook` (settings.json writing moved out of the
  provider class into the contract's lifecycle callback). Final: 343 pass, 1
  skip, 0 fail; clean `bun run typecheck`; clean `eslint`.
  **Scoped narrower than upstream's full diff, on purpose, not by oversight**
  — see the updated C15 row for the three reasons (poll-loop.ts's bundled
  reply-routing rewrite excluded; the SDK version bump deferred per
  CLAUDE.md's Bun-runtime policy; `TaskOutput` preserved and `/remote-control`
  corrected, both verified against the real tags). None of these are silent
  gaps — each is recorded as its own explicit follow-on item, not dropped.
- 2026-09-26 — **E5/E6 closed with local evidence.** E6:
  `scripts/check-wiring-registry.ts` re-run in `feat/gateway-provider-seam`,
  13/13 entries OK; confirmed this promotion introduced no new
  ADR-028-class privileged function (A3's Wake/Kill port extends
  already-registered `wakeContainer`/`killContainer`; Workstream C's own
  bypass-closure audit is this promotion's "successor audit" per ADR-028's
  bar and closed with zero new acceptance records). E5: ran all three
  suites for real. `bun test` 343/1/0, `go test -race ./...` all packages
  ok, `pnpm exec vitest run` 4098 pass / 77 fail. The 77 failures are
  entirely `Command failed: git ...` / Xcode-CLT-stub errors across exactly
  5 files this branch never touches; reproduced identically on an
  unrelated branch in the separate main checkout, confirming sandbox
  `PATH` state (`/usr/bin` ahead of `/usr/local/bin`), not a regression.
  Per this document's own "zero failures, not zero *new* failures" policy,
  recorded as a named, owned baseline exception (new table under "What
  'green' means") rather than waved off. Formal required-CI-gate evidence
  (PASSED + REQUIRED, not just local) remains G3/G4's job, not
  re-duplicated here.
- 2026-09-26 — **Workstream E fully closed (E1-E6).** E3: audited all 6
  seam-real tests against Workstream A/B's new `SessionSpec.networkAccess`
  field and found it crosses the real composition path in every one of
  them today with no seam-level assertion pinning its shape — added one to
  `cli-channel-kernel-smoke.test.ts`, verified with a negative control
  (`feat/gateway-provider-seam` @ `25c071c1`). E4: audited Workstream C's
  trust-boundary findings against LAW-06/LAW-08 and found the question was
  already answered — C5's own accounting is zero acceptance records, and
  the 3 real findings C6 produced (the only Workstream C items that
  changed enforced behavior) each already carry a dedicated regression
  test verified via negative control at fix time; re-ran all three now,
  still passing. No new test-writing needed for E4 — closed by
  verification, not implementation. Workstream E (Testing) is now
  entirely done.
- 2026-09-26 — **Workstream F (Documentation) closed: F2-F5 done, F6
  correctly blocked, not a gap.** F2/F3: `version-compatibility.md`/
  `compatibility-matrix.md` updated with Workstream A's gateway-trust
  mount class, `networkAccess`, and multi-container Wake/Kill (new Stable
  rows backed by A5's real live-Docker evidence, not just unit tests; one
  new Unsupported row for the one named scope gap — auxiliary health-
  checking). Both docs get a staging note: they now describe code ahead
  of the pin, which is a deliberate, separate, later action (Workstream
  G4), not something these architecture docs should wait on or that
  should be misread as the pin having already moved. F4:
  `traceability.md` gets ADR-029 through -032 indexed, three new
  Boundary-verification rows for C6's real trust-boundary findings, and a
  Known-gaps bullet keeping the two deliberately-deferred items
  (gateway-session-lifecycle wrapping, `poll-loop.ts`'s reply-routing
  rewrite) visible outside this one document. F5: found and fixed a real
  staleness bug while checking — CLAUDE.md still named
  `src/modules/approvals/onecli-approvals.ts`, a file C7 deleted when it
  generalized that flow into `src/gateway-approval-coordinator.ts`;
  updated both the prose and the Key Files table. F6 (the ADR-017-style
  *closing* review for this whole promotion) stays explicitly blocked on
  the pin actually moving (Workstream G4, gated on G3, gated on H) —
  writing that closure now would either misrepresent the promotion as
  finished or need rewriting at G4; the per-decision ADRs (029-032)
  already exist and are not a substitute for it.
- 2026-09-26 — **D3 corrected: the `fix/inbox-toctou-batch-revalidation`
  founder-coordination worry was wrong, traced properly this time.** The
  prior entry read that branch's commit *subjects* (Mattermost-shaped
  messages, PR numbers) and inferred unmerged, parked Isthmus Mattermost
  work needing sign-off. Actually tracing its ancestry
  (`git merge-base --is-ancestor`) shows it is `upstream/main` — nanocoai/
  nanoclaw's own default branch, as of 2026-09-23, just before the real
  `v2.4.0` release-merge PR (#3877) landed — plus exactly one Isthmus
  commit on top (`prathish-ks`'s inbox-safety TOCTOU fix). Confirmed by
  the founder: a separate, unrelated branch used to submit a GHSA/security
  disclosure back to nanocoai/nanoclaw, not promotion work. Also confirmed
  Isthmus's own `main` already independently carries the equivalent fix
  (`session-manager.ts:378`) — nothing to port from that branch regardless.
  The ~20 Mattermost commits reachable from it are real upstream commits
  (author `glifocat`, PR #3507 and follow-ups, Aug 24 - Sep 15) present
  purely because the scratch branch is rooted in `upstream/main` — none
  are on Isthmus's own `main`, confirming no parallel Mattermost effort
  ever existed to coordinate with. The CSV reclassification (Mattermost →
  `declined:out-of-scope-tracked-by-sync-sibling-branch-mechanism`) stands
  on its own merits and needed no founder input after all. Also caught two
  adjacent staleness bugs in the same row while correcting it: the
  "reconcile-session cluster... not started" line was stale (closed via
  C13 well before this correction), and "egress-lockdown auxiliary-gateway
  generalization" had been conflated with the GHSA branch above when it
  actually names a completely different, real, currently-checked-out
  Isthmus branch (`fix/egress-lockdown-kernel-network-wiring`) — separated
  out as the one item in this row that's still genuinely open. Lesson
  applied: when a git-history finding drives a "needs founder input"
  conclusion, trace the actual ancestry before writing that down, not just
  the commit subjects.
- 2026-09-26 — **D3 fully closed: egress-lockdown gateway generalization
  implemented per ADR-033.** Confirmed `fix/egress-lockdown-kernel-network-
  wiring` merged (PR #47), closing the coordination concern D1 originally
  flagged. The actual upstream diff (hardcode-OneCLI → per-session
  `NetworkAccessIntent`) didn't port mechanically: its call site,
  `drivers/index.ts`'s `dockerNetworkArgs(spec)`, is confirmed dead code —
  EC-02/ADR-016 already moved real container creation behind the Go
  kernel, and Isthmus's own `docker-driver.ts` comment says the per-session
  network-args callback "no longer participates in container creation
  itself... none does today." The live enforcement point is a different,
  same-named function in `kernel-supervisor/index.ts` (ADR-024/025/026's
  own fix), which still hardcoded OneCLI. Wrote ADR-033 recording the
  translation: `GatewayProviderDefinition.egressGateway()`, an install-wide
  descriptor resolved at kernel-supervisor startup (deliberately not the
  same field as the per-session `GatewayContribution.networkAccess`, which
  answers a different question and stays C7's own placeholder), OneCLI
  implementing it with the value that was hardcoded before, and
  kernel-supervisor failing closed if the configured gateway declares
  none — closing the real gap (the moment a second gateway like Iron
  Proxy becomes default, this would otherwise silently mis-target).
  Preserved Isthmus's own `gatewayAttached()` hardening rather than
  reverting to upstream's weaker check. Implemented, committed
  (`bca1b20e`), verified with a negative control on the new fail-closed
  path, full affected-file suite green, `tsc`/`eslint` clean. Workstream
  D3 (all three items: Mattermost, reconcile-session, egress-lockdown) is
  now entirely closed.
- 2026-09-26 — **F1(a) closed: ADR-034 written for Workstream A's Go-
  kernel mount/network model.** Checked first rather than assumed: A1-A6's
  own rows cite zero ADRs (confirmed by grep), so F1(a)'s prior "may
  already cover this" note was speculative, not verified. ADR-034 records
  A1 (gateway-trust mount class, plus the real empty-`GatewayTrustRoot`
  fail-closed bug found and fixed), A2 (the wire-protocol version bump and
  its mixed-version compatibility matrix — the exact table
  `upstream-promotion-playbook.md`'s Step 4 asks for, filled in against
  its required questions), A3 (multi-container Wake/Kill, with its one
  named scope gap), A4 (hardening-posture confirmation), A5/A6
  (verification). The mixed-version answer itself turned out to already
  exist, in the clearest form available: `protocol.go`'s own doc comment
  on `ProtocolVersion`, written as part of A2's own commit — old×new and
  new×old are both rejected outright (no partial compatibility, no
  rollback of just one side), which the ADR tabulates rather than
  restates. F1 is now fully closed — (a), (b), and (c) all done.
- 2026-09-26 — **C8 (Iron Proxy) fully closed: installed and verified
  end-to-end, not just cataloged.** With Docker confirmed available,
  applied the skill's remaining directives for real — provider payload,
  registry adaptation, gRPC deps, and `setup.ts --with-control`, which
  built the pinned Iron Proxy + NanoClaw approval-front image from source
  and started Iron Control + its own Postgres + the managed proxy.
  Verified against real running infrastructure (all three containers
  healthy, the proxy's own logs showing a real config received from the
  control plane, the deny-list active, every listener up) — not just a
  green exit code. `NANOCLAW_GATEWAY_PROVIDER` was not force-set; OneCLI
  stayed the active gateway throughout, and its own pre-existing
  containers stayed healthy the whole time. This surfaced and closed four
  real gaps beyond the skill's own 38 files
  (`gateway-compat/onecli-summary/` never ported at all — a real
  D-workstream inventory miss; `vitest.config.ts` missing upstream's own
  v2.4.0 include pattern, silently never running 8 of the skill's own
  test files; `setup/set-env.ts`/`src/env.ts` missing upstream's own
  `projectRoot` parameter, plus their real, never-ported upstream test
  files; a cross-check against a skill-provisioned OneCLI that doesn't
  exist in Isthmus's bring-your-own model), and one real regression this
  same registration caused (a one-time `@grpc/grpc-js` module-load cost
  racing `host-sweep.ts`'s own dynamic-import-then-reschedule pattern in
  three sweep test files — fixed with a `beforeAll` warm-up, verified via
  negative control, not by weakening the tests). One real follow-up
  tracked, not fixed here: Iron Proxy declares `lease.onUnavailable` but
  core never registers for it — C1's own predicted "must-close item once
  C8 needs it," now concretely true, left as its own next step.
  Along the way: a real disk-space crisis (this sandbox's disk filled
  during the first build attempt, taking the Docker daemon down with it)
  was found, root-caused (unrelated to this build's own footprint — the
  host's Data volume was already at 96GB/121GB before any of this),
  and resolved with the user's help (two large downloaded VM images
  moved out, Trash emptied by the user — an action outside what this
  assistant will do itself) before the retry succeeded cleanly.
- 2026-09-26 — **H2 closed: a real end-to-end migration acceptance
  test, not a design-only claim.** Non-interactively drove the actual
  `isthmus.sh` migration against a real nanoclaw v2.3.0 install on a
  disposable scratch worktree, to a local-only merge of this
  promotion's own branches standing in for the pinned v2.4.0 baseline
  (never pushed — those branches aren't merged to `main` yet).
  `data/v2.db` byte-identical across migrate and rollback; `nanogo
  doctor` clean post-migration; a mid-flight `pkill` during the
  container step left a momentarily-orphaned process and a transient
  lock file, both self-resolved with no data corruption. Along the
  way, found and worked around a real, separate UX gap in the setup
  wizard itself (its stall-detector prompt hangs forever on non-TTY
  stdin after 60s of silence from a slow build step) by pre-building
  the container image out-of-band first. Full transcript:
  `docs/promotion-v2.4.0-rollback-v2.3.0.md`. Explicitly does not
  re-prove real-credential handling or live-container adoption — both
  still rest on H1's 2026-09-06 dry run, stated plainly in the artifact.
- 2026-09-26 — **H3 and H4 closed.** Same test, sourced from the real
  v2.4.0 tag instead of v2.3.0. Same clean result (byte-identical
  `data/v2.db`, clean `nanogo doctor`), plus three things a v2.3.0
  source didn't surface: the setup wizard's skip-step name changed
  from `onecli` to `gateway` as a direct effect of this same
  promotion's gateway-provider generalization; running that
  un-skipped step for real hit 2 test failures traced to this
  machine's own ambient `ANTHROPIC_BASE_URL` env var beating a test
  fixture (confirmed sandbox artifact, not a defect); and a failed
  attempt's partial file writes left uncommitted debris blocking the
  next `git checkout`, cleanly recovered — a second, differently-shaped
  demonstration of the "partial failure leaves recoverable state"
  property H2 tested via a process kill. H4: H2 and H3 land on
  identical resulting state on every axis compared. Full transcript:
  `docs/promotion-v2.4.0-rollback-v2.4.0.md`.
- 2026-09-26 — **G3 closed: re-verified, not left on its earlier
  "blocked on H2/H3" assumption.** With H2/H3 actually landed, checked
  all three places a new standalone script could have appeared:
  Workstream A added none; Workstream C's new files (Iron Proxy skill
  scripts, portal/slack-worker, two git-command-builder utilities) are
  ordinary feature code already covered by the required `test` job —
  confirmed `vitest.config.ci.ts` merges on top of `vitest.config.ts`
  rather than replacing its `include` list, so C8's skill-payload
  tests genuinely run in CI; Workstream H, the one place this row
  originally expected a new script, in fact introduced zero — `git
  diff --diff-filter=A` against the H2/H3 commits confirms it.
  Resolves to N/A.
- 2026-09-26 — **Promotion-gate checklist filled in with an interim
  status snapshot**, ahead of the final pin-move PR that formally owns
  it, so [PR #50](https://github.com/prathish-ks/isthmus/pull/50) has
  something concrete for external review before PR #1 (kernel
  capability) opens. Every workstream's implementation is complete and
  locally verified; the one gap flagged honestly rather than glossed
  over is that no GitHub Actions run has executed either implementation
  branch yet (no PR open for `feat/mount-gateway-trust-class` or
  `feat/gateway-provider-seam`) — E5's own row already said this
  plainly ("the formal required-CI-gate run... is still outstanding"),
  so the checklist's Workstream E line stays unchecked until PR #1/#2
  open and `ci.yml` runs green for real. Tag-immutability re-check and
  `docs/upstream-pin.json`/`docs/baseline.md` (G4) remain unchecked by
  design — both belong only to the final pin-move PR.
- 2026-09-26 — **Independent code review on PR #1
  (`feat/mount-gateway-trust-class`) before opening it, two findings, both
  fixed.** Read the actual diff fresh rather than re-trusting this
  document's own "Done" rows: (1) `validateNetworkAccessTarget`'s second
  rejection branch (a session-container target naming a role with no
  matching auxiliary container, `internal/kernel/exec.go`) had zero test
  coverage, unlike every sibling rule in the same diff — added
  `TestDockerExecutor_Wake_SessionContainerTargetNamesNonexistentRole_Rejected`.
  (2) `mount.ClassRequiredByPath` (Go) checks `GatewayTrustRoot` before
  `MaterialsRoot`; the TS mirror (`classRequiredByPath`,
  `drivers/types.ts`) checked the opposite order — the two "byte-identical
  mirror" implementations disagreed on precedence for a hostPath under
  both roots, a misconfiguration nothing else prevents. Reordered TS to
  match Go exactly; added a pinning test on both sides. One plausible
  cross-branch bug was chased and ruled out, not just assumed fine: Iron
  Proxy's (C8) `networkAccess.target.kind: 'runtime'` looked like it might
  collide with this PR's "auxiliary containers require a session-container
  target" rule — confirmed by reading `ironProxyContribution`'s actual
  return shape that it never populates `containers`, so the rule never
  fires for Iron Proxy sessions. Fixed in commit `513f3cb4`; full
  `go-host` suite and full `drivers/` suite green after. See
  `docs/promotion-v2.4.0.md`'s own commit history for the reported
  findings' exact wording.

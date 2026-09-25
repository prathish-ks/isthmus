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
| A5 | Live-Docker tests proving a multi-container session actually gets a working, correctly-isolated private network — real container membership and isolation, not just that the generated argv looks right. **Must be PASSED + REQUIRED per "What 'the gate passed' means," above** — a report-only run does not satisfy this row. This is the `go-multi-container-live-docker` job named under Workstream G; not "Done" until `ci.yml`'s `needs:` actually names it (G1's Definition of done) | **Code done, real-world verification still outstanding** — `feat/mount-gateway-trust-class`, commit `1c9b6903`. Two tests written against `mount_confinement_live_docker_test.go`'s exact conventions (real `--internal` network + membership check, DNS-resolution-based reachability/isolation proof, real read-only-filesystem write-attempt proof for the auxiliary). `go-multi-container-live-docker` wired into `ci.yml` as **required** (added to the `ci` gate's `needs:`), a deliberate departure from every other live-Docker job in this file (all report-only) — matches this document's "What 'the gate passed' means" policy for the one new capability this promotion adds. **Important**: this sandbox has no Docker daemon, so neither test has been run for real — only compiled and confirmed to skip cleanly. This job's first real CI run is genuinely load-bearing; treat a failure there as the mechanism catching a real problem, not as a sign this was rushed. Do not consider this row fully closed until that first real run is green |
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
| `container-runner.ts` | **Revised, larger than the prior pass found** — the ~900-line diff is not two concerns but (at least) **three**: (1) gateway-session-lifecycle wrapping (`claimSessionRun`, `ensureGatewaySession`, `stopGatewaySessionsForUnavailability`, `watchGatewayAvailability`, `abortGatewaySessionObservers` — load-bearing, lease-managed), (2) durable-host shadow-writes (upstream-confirmed inert, same as the `request-wake.ts` row), and (3) **newly found**: a "provider host contract" mount-composition rewrite in `buildMounts` (`getProviderHostContract`, `realizeProviderSpawnSurfaces`, `contract.stateVolumes`/`.skillViews`/`.skillBackings`) that replaces the old `providerProvidesAgentSurfaces`/`providerContribution.mounts` callback pattern with a declarative per-provider mount contract — **this is orthogonal to gateway-trust entirely**, a separate provider-abstraction upgrade affecting how *every* provider's mounts (not just gateway ones) get composed | `composeSessionSpec`'s own diff is small and directly gateway-seam-relevant: `labels: {...gateway.labels, ...}`, `containers: [agent, ...(gateway.containers ?? [])]`, new `networkAccess: gateway.networkAccess` field — this is the actual production call site `drivers/types.ts`'s new `SessionSpec.networkAccess`/gateway-trust support exists to receive, currently unreachable because nothing populates a non-empty `gateway` object (confirms the "composer doesn't yet build gateway-provider specs" premise Workstream A/B's TS changes were built on) | **Not portable in the scope of this promotion's remaining budget without a real architectural decision.** (1) and (3) are each substantial, independent features — (3) especially, since it is NOT part of the gateway/Iron-Proxy work the plan's Non-goals section already scoped out, and was not visible in the prior data-shape-only pass. Recommend: split into two explicit follow-on efforts, each gated on its own ADR — gateway-session-lifecycle adoption (already anticipated by Workstream C's Non-goals carve-out) and, newly, a provider-host-contract adoption decision. Flagging this to the user rather than proceeding to port (3) unreviewed: it changes how every session's mounts are composed, on a fork whose entire premise is a hardened mount/trust boundary |
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
| C1 | Trace `ensureGatewaySession`/`stopGatewaySessionsForUnavailability` (`container-runner.ts`) end to end: can a session reach the gateway, or keep reaching it after the gateway becomes unavailable, through any path that skips this function? | **Unblocked by ADR-030** — real diligence once C7/C8 land a working gateway provider; a LAW-08 obligation, not optional. Not started |
| C2 | Trace `permitsConfiguredGatewayRead` (`gateway-read-policy.ts`): is the `NANOCLAW_GATEWAY_READ_ONLY_HOSTS` env-var allowlist the *only* gate on read-only gateway destinations, and is it consulted on every code path that makes an outbound gateway request? | **Unblocked by ADR-030** — same reason as C1. Not started |
| C3 | Confirm the OneCLI-as-skill restructuring doesn't change *how* credentials reach a container — still exclusively via a kernel-admitted `gateway-trust`/`identity-material` mount, never a new env-var or volume path the kernel doesn't validate | **Done** — confirmed by direct code trace, not inference, following C7's own restructuring: `onecli.ts`'s `contributionFromArgs` parses the SDK's argv into a typed `GatewayContribution` and **fails closed on any flag it doesn't recognize** (`onecli.test.ts`'s own "refuses argv outside the grammar" case). That contribution's `mounts` merge into `composeSessionSpec`'s output and pass through `validateSpec` — the same admission gate every other mount goes through, no shortcut — before `driver.prepare` ever sees the spec. Its `env` merges into `contributedEnv`, which `validateSpec` independently runs through `looksLikeCredential()` — "Credential VALUES have no sanctioned channel, from anyone: real material rides mounts by reference" (the check's own comment, `drivers/types.ts`). Isthmus never moved OneCLI to a skill (C7 kept it core, matching upstream's own default-gateway shape) so the literal premise ("skill restructuring") doesn't apply, but the invariant it was checking for holds. |
| C4 | Full re-sweep of the 21 gateway files plus a fresh repo-wide grep (not scoped to `src/` this time — check `container/agent-runner/src/` and `setup/` too) for new `docker`/`exec`/credential-handling code introduced anywhere in the v2.4.0 diff that this plan hasn't already accounted for. Cross-reference against the Workstream D file inventory once it exists, rather than re-deriving file lists independently | **Done, one substantial finding.** Swept the full v2.4.0 diff (`src/`, `container/agent-runner/src/`, `setup/`) for process-spawning and credential-shaped code. Nothing new beyond what's already tracked (C7/C8/C9, the sibling-branch-tracked skills) — **except `src/community-portal/`, entirely new, ~2,990 lines, not previously mentioned anywhere in this plan.** It is a client for `https://portal.nanoclaw.dev` — an **upstream-operated hosted service** ("NanoClaw community portal") — generating a per-machine ECDSA P-256 device identity key (`~/.config/nanoclaw/device-key.json`, self-generated, doesn't leave the machine, so not itself a credential-leak vector), registering the device with the portal, and running a detached worker (`slack-job.ts`, uses `child_process.spawn`) for a "managed Slack app install" flow. **Recommendation: do not adopt as part of this promotion.** This is a separate, more clearly out-of-scope decision than gateway-session-lifecycle ever was — it's not a compatibility question, it's "should Isthmus installs register a device identity with and phone home to nanocoai's own hosted infrastructure," a product/trust decision with no bearing on kernel compatibility or the gateway work already decided. Flagging for the founder rather than silently porting or silently ignoring it. |
| C5 | For each finding: either close it (route through the kernel, or an existing guard) or produce a full **acceptance record** (see below) — never a bare "accepted and documented" note | Nothing to process yet — C3 found no gap (credentials stay kernel-admitted), C4's one finding (`community-portal`) is declined/not-adopted, not an accepted bypass, so it doesn't need an acceptance record (there is nothing running to accept a gap in). Stays open pending C1/C2, which are blocked on a real gateway provider existing (C8) |
| C6 | Security-focused review pass using the `code-review` skill, scoped specifically to trust-boundary findings on this diff (not general bug-hunting) | Not started |
| C7 | **New (ADR-030), sequence first — load-bearing.** Restructure `src/gateway-providers/onecli.ts`/`onecli-approvals.ts` into upstream's `GatewayProviderDefinition` contract (`sessions.ensure`/`approvals.subscribe`, matching `gateway.json`'s `"kind": "onecli", "default": true`). Without this, a ported v2.4.0 `container-runner.ts` refuses to start — there is no implicit default and no open-egress fallback. Stays 100% TypeScript; ports session identity and credential-injection logic Isthmus already has, doesn't invent new logic | **Done** (`feat/gateway-provider-seam`, commit `0bb51506`) — `gateway-provider-registry.ts` widened to the full contract; new `gateway-approval-coordinator.ts` extracts the generic approval flow out of the old OneCLI-only module (approver resolution, delivery, the `pending_approvals` row, card, click, expiry, sweep) so C8's Iron Proxy reuses it rather than re-implementing its own; `onecli.ts` implements `sessions.ensure`/`approvals.subscribe`, wrapping the SDK's callback-based bridge (no native "ended" event) into the generic `subscribe(decide, signal): Promise<void>` shape; `container-runner.ts`'s spawn path threads `networkAccess`/`labels` into `composeSessionSpec`. Existing test suite (`onecli-approvals.coverage.test.ts`, 682 lines) ported behavior-for-behavior — caught two real regressions before they shipped: the card's displayed agent name must come from a `getAgentGroup()` lookup, not the SDK's own `agent.name`, and a request with no external id is "no known scope" (falls through to the global-admin approver path), not a hard validation failure. `pnpm exec tsc --noEmit` clean; full `pnpm test` green (3972 tests); `eslint` clean except pre-existing `no-catch-all` warnings. Remaining: threading the lease's `release`/`onUnavailable` lifecycle through `ActiveSessionRuntime` once C8 gives a provider that actually uses them |
| C8 | **New (ADR-030), sequence third.** Install `/add-iron-proxy` on par with upstream v2.4.0's own catalog: the provider payload, the approval-bridge middleware, the local Docker-built proxy + Iron Control console, `NANOCLAW_IRON_PROXY_PORT`/`NANOCLAW_IRON_CONTROL_PORT` wiring, the gRPC bridge dependencies. First real consumer of Workstream A's `gateway-trust` mount class and multi-container/`networkAccess` executor | **Partially done, genuinely blocked on the rest.** All 38 skill files copied verbatim from upstream v2.4.0 into `.claude/skills/add-iron-proxy/` (commit `c2b26b83`, `feat/gateway-provider-seam`) — `gateway.json`'s `"default": false` correctly keeps OneCLI the active gateway; nothing forces Iron Proxy on. This satisfies "catalogued, matching upstream" — the skill is present and directly invokable (`/add-iron-proxy`, Isthmus's own convention for every other `/add-*` skill; Isthmus has no generic gateway-picker UI to register with, unlike upstream's `setup/gateways/catalog.ts`, and doesn't need one for this). **Actually installing/running it is blocked**: 7 of the skill's own files (`scripts/setup.ts`, `credential-store.ts`, `provider-credentials.ts`, `auth.ts` + 3 tests, `payload/src/gateway-providers/iron-proxy.ts`) import `setup/gateways/credential-store.js` and `src/provider-contracts/index.js` — **neither exists in Isthmus.** `setup/gateways/` is upstream's generic gateway-picker/credential-storage infrastructure Isthmus never built (OneCLI being core-baked, it never needed one). `src/provider-contracts/` is the provider-host-contract mount-composition rewrite Workstream B already escalated (2026-09-25) as its own undecided architectural question, tangled in the same `container-runner.ts` diff as the gateway-lifecycle work — **this is now confirmed to be a hard prerequisite for Iron Proxy to function, not just an abstract concern.** Building the proxy binary, the Iron Control console, and the gRPC bridge is also unverifiable in this sandbox regardless (no Docker daemon — same "real CI evidence over local" limit as A5's live-Docker tests). Not proceeding further without a decision on the `provider-contracts` question and, separately, whether to build `setup/gateways/` — flagging both rather than guessing. |
| C9 | **New (ADR-030), sequence second — independent of C7/C8.** Port the multi-host claim/lease coordination (`db/coordination.ts`, `host-instance.ts`, the `session_claims`/`host_instances` tables and migration) in TypeScript, including `availability.publish`/`.read` for the separated-process case. No Go kernel changes — coordination happens over the existing central DB; each host process still only ever talks to its own local kernel once it wins the claim | **Done** (`feat/gateway-provider-seam`, commit `e52c34a5`) — ported `db/coordination.ts`, `host-instance.ts`, migration 024, correcting upstream's own stale "shadow state" doc comments (the claim-acquisition read genuinely gates spawn behavior, confirmed by reading `container-runner.ts`'s own `claimSessionRun` directly). Wired into `container-runner.ts`: claim-before-spawn with release-on-any-failure through `driver.prepare`, and claim-fenced adoption. Host-instance lease started/stopped in `index.ts`'s startup/shutdown sequence. Tests: `coordination.ts`/`host-instance.ts` ported from upstream near-verbatim; new `container-runner.claims.test.ts` (real `DockerSessionDriver` + a real `RecordingKernel` fake-server) proves refusal-when-live-peer-holds-claim, takeover-of-a-dead-claim, normal claim-and-spawn, and release-on-`driver.prepare`-failure — narrower than upstream's own claims test, which assumes the fuller gateway-lease-lifecycle wrapping C7 deliberately deferred. `availability.publish`/`.read` **not yet wired** — that's a `GatewayProviderDefinition` capability a provider declares (see C7), and OneCLI doesn't; revisit once C8 gives a provider that needs it. `pnpm exec tsc --noEmit` clean; full `pnpm test` green (3987 tests, up from 3972); `eslint` clean except pre-existing `no-catch-all` warnings. |

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
| D1 | Classify every row into Bucket A/B/C using the inventory — supersedes the earlier prose-based first pass | **In progress** — 116 of 526 rows classified (2026-09-25): the 18 seeded from Workstream B's firsthand analysis, plus 98 more resolved directly from the plan's own Non-goals text — `add-opencode/`, `add-mattermost/`, `add-codex/` (60 rows: sibling-branch-tracked, "already-tracked threads" per Non-goals, see `sync-sibling-branches-*` CI jobs) and `add-iron-proxy/` (38 rows: `declined:non-goal`, "not scoped to install the add-iron-proxy skill itself"). **410 rows remain**, concentrated in `setup/` (97), `container/agent-runner/src/` (72), `src/modules/` (36), `.claude/skills/slack-agent-flow/` (26), `.claude/skills/add-onecli/` (~20, most belongs to Workstream C3 rather than generic D1 triage), `src/community-portal/` (19 — an entirely new upstream feature with no prior mention anywhere in this plan, not yet looked at at all), `src/db/` (13), and smaller clusters elsewhere. Not auto-classified further because each of these needs real per-file judgment this pass hasn't done yet — `slack-agent-flow`/`slack-a2a-rooms`/`add-dial`/`add-slack` were deliberately NOT swept in with the sibling-branch-tracked group above despite the naming pattern, because the plan's Non-goals text names Mattermost and Codex/OpenCode specifically and this pass is not extending that by inference |
| D2 | Read `migrate-nanoclaw`'s and `update-nanoclaw`'s SKILL.md in full; decide whether either is usable as-is, adaptable, or whether Isthmus's depth of fork needs a bespoke process for this reconciliation specifically | Not started |
| D3 | For each Bucket C row: is it a genuinely independent upstream change (safe to port as-is), or does it touch a file Isthmus has already meaningfully modified (needs manual reconciliation, feature-by-feature, preserving both sides)? Record the decision in the inventory's `reconciliation_decision` column | Not started |
| D4 | Confirm zero rows remain unclassified and zero Bucket B rows lack a security-review status before this workstream counts as done — this is also a promotion-gate line, not just an internal target | Not started |

### Workstream E — Testing

See "What 'green' means" and "What 'the gate passed' means," above, for
what "passes"/"green" mean in every row below.

| # | Task | Status |
|---|---|---|
| E1 | Go: unit tests for every new/changed `internal/mount` rule (Workstream A) | **Done** — same evidence as A6 |
| E2 | Go: live-Docker tests for multi-container sessions and network isolation (Workstream A). **PASSED + REQUIRED, not report-only** — see A5 and G1's Definition of done | **Code done, unverified** — same evidence and caveat as A5: written, wired into `ci.yml` as required, not yet run against a real daemon (no Docker in this sandbox). Not "Done" until the first real CI run is green |
| E3 | TS: update/extend the seam tests this project already built (the 6 seam-real tests from the wiring-boundary-coverage effort, merged 2026-09-24) to cover any new wake/kill/build-image call shape from Workstream B | Not started |
| E4 | TS: parity/security-regression coverage for the gateway trust-boundary findings from Workstream C (matching LAW-06/LAW-08's "contracts before rewrites" / "no weaker security than upstream" bar), including the regression test each Workstream C acceptance record requires | Not started |
| E5 | Full suite green (per "What 'green' means," above): `pnpm exec vitest run`, `bun test` (container/agent-runner), `go test -mod=vendor ./...` including `-race`. Pre-existing live-Docker jobs (`go-ec05-live-docker`, `go-egress-live-docker`) run and pass; the *new* multi-container/network test (E2) is additionally required per "What 'the gate passed' means" | Not started |
| E6 | `wiring-registry-check` passes against any new privileged function this promotion introduces (Workstream A/C may add real callers/seam tests that need registering) | Not started |

### Workstream F — Documentation

| # | Task | Status |
|---|---|---|
| F1 | New ADR(s) recording the architectural decisions: (a) mount/network model in the Go kernel, including A2's mixed-version compatibility matrix and rollout answers; (b) gateway-provider trust-boundary scope (what's kernel-enforced vs. accepted TS-side, referencing every Workstream C acceptance record); (c) OneCLI trunk-vs-skill placement decision. One ADR or several, whichever keeps each decision reviewable independently — decide when the decisions are actually made, not now | Not started |
| F2 | `go-host/docs/version-compatibility.md` §1's consumed-contracts table updated to reflect the new v2.4.0-based contracts | Not started |
| F3 | `go-host/docs/compatibility-matrix.md` Stable/Preview/Unsupported ratings re-issued against the new baseline — any row covered by an open (non-expired) Workstream C acceptance record stays below Stable unless that record explicitly says otherwise | Not started |
| F4 | `docs/traceability.md` updated with this promotion's ADR(s) and any new/changed law-breach entries | Not started |
| F5 | `CLAUDE.md`'s "Secrets / Credentials / OneCLI" section updated if Workstream C/D's OneCLI decision changes how it's documented | Not started |
| F6 | This document's own findings folded into `go-host/docs/ADR-017`-style closure, or superseded by a new numbered ADR referencing it | Not started |

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
| G2 | For each Workstream C finding that gets closed via a new guard/check rather than an accepted-and-recorded exception: confirm that guard/check has its own CI coverage (unit test at minimum; a dedicated required job if the finding's severity warrants it, matching G1's bar) | Not started |
| G3 | For any new script/automation this promotion introduces (e.g. a migration-continuity check, Workstream H): add `sync-sibling-branch-script-test`-style regression coverage, run on every PR — required, not report-only, unless there's a specific reason it can't be (state the reason if so) | Not started |
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
| H1 | Resolve the open question above: identify or confirm the actual current onboarding path from a plain nanocoai/nanoclaw install to Isthmus | Not started |
| H2 | **Acceptance test, source = nanoclaw v2.3.0**: starting from a clean plain nanoclaw v2.3.0 install, run the identified path end to end and verify all of: existing user data and configuration preserved; credentials are not copied into any location the kernel wouldn't admit as a valid mount; groups, sessions, mounts, and central DB state remain valid after migration; the resulting installation is running Isthmus pinned to the new v2.4.0 baseline; a deliberately-induced failure partway through leaves a recoverable state (not partial/corrupt); rollback behavior is documented **and produces the recorded rollback artifact above**; the whole procedure runs from a fresh checkout with no reliance on undocumented local state | Not started |
| H3 | **Acceptance test, source = nanoclaw v2.4.0**: the same full checklist as H2, including its own rollback artifact, against a clean plain nanoclaw v2.4.0 install instead | Not started |
| H4 | Confirm both H2 and H3 land the user on the identical resulting state (same pinned baseline, same expected behavior) — a v2.3.0-sourced and a v2.4.0-sourced migration are not allowed to diverge in outcome | Not started |

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

- [ ] Workstream A complete and tested (E1, E2 PASSED + REQUIRED, A6)
- [ ] Workstream B: every row resolved, no "not yet assessed" remaining
- [ ] Workstream C: every finding closed, or covered by a complete acceptance record (C5) — zero bare "accepted" notes
- [ ] Workstream D: the file-inventory artifact (D0) exists, has zero unclassified rows and zero Bucket B rows without a security-review status (D4)
- [ ] Workstream E: full suite green per "What 'green' means" on real CI, not local-only
- [ ] Workstream F: ADR(s) merged, compatibility docs current
- [ ] Workstream G: CI coverage added and REQUIRED for every new privileged surface this promotion introduces (G1–G3), no report-only substitutions
- [ ] Workstream H: H2 and H3 acceptance tests both pass, each with its recorded rollback artifact, H4 confirms matching outcomes
- [ ] **Tag/commit immutability re-check**: re-run Workstream B/C/D's classification against the *live* v2.4.0 tag one more time immediately before promoting (catches drift since Step 0); confirm the tag still resolves to the same commit (`143db6c9`) captured at the start of this plan and has not moved; record the final verified commit SHA in this document's changelog at promotion time
- [ ] `docs/upstream-pin.json` + `docs/baseline.md` updated together with the closing ADR (G4) — in the final pin-move PR only, per "PR boundaries" above

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

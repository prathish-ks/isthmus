# Design Law → Enforcement Traceability

Status: living document, established 2026-09-24. Answers one question for
each of the nine [design laws](design-laws.md): if this law were silently
violated by a future PR, what — today, mechanically — would actually catch
it? Not "what test exists somewhere," but "what runs on every PR, what runs
on a schedule, and what isn't checked by anything except code review."

## Why this exists

The egress-lockdown regression (`go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md`)
was a LAW-07 violation that shipped, passed every existing test, and sat
undetected across an architectural change (EC-02) until someone re-derived
the invariant from first principles. The tests that would have caught it
either didn't exist yet or existed but weren't wired to anything that ran
automatically against the right code path. This document exists so that
class of gap is visible by inspection instead of by incident.

This is not a new governance layer. It is the existing laws, ADRs, and CI
jobs — cross-referenced, once, so the gaps are honest and named rather than
implicit. Where nothing enforces a law today, the table says so instead of
inventing a check that doesn't exist yet.

## Provenance and scope — what the nine laws are, and aren't

`docs/design-laws.md` was committed 2026-08-30 as task P1-05, at the very
start of the Go-kernel decomposition effort, to answer one specific
question: what should move into Go versus stay in TypeScript. They are the
**Go/TypeScript boundary constitution**, not a general project constitution
— LAW-02 explicitly keeps them out of ordinary TypeScript work by design.

The project has since matured past the phase the laws were written for. Per
`go-host/docs/ADR-027-feature-growth-phase-transition.md` (2026-09-24):
LAW-03 ("upstream compatibility before feature growth") is now satisfied for
the currently-decomposed, "Stable"-rated contract surface
(`go-host/docs/compatibility-matrix.md`), so feature growth and TypeScript
hardening are active, ongoing work streams — not deferred ones. This does
not retire LAW-03; new contract surface the kernel takes a dependency on
still needs parity work first, checked per-contract against the
compatibility matrix rather than as a blanket gate.

Two streams now run concurrently, both needing a regression net, but not the
*same* one:

1. **Go-kernel migration** (LAW-01–09) — continues to be a standing goal, not
   a finished milestone: every new privileged action a feature introduces
   still gets checked against LAW-07's exclusive-enforcement bar, bounded by
   LAW-01/02/09 (must not require Go for ordinary customization; must not
   weaken the upstream-independence promise). The table below covers this
   stream.
2. **TypeScript feature growth and hardening** — by LAW-02's own design, the
   nine laws mostly don't reach this stream. Its regression net is the
   "General regression safety net" section further down, not the law table.

## How to read the table

- **Enforced by** — the specific test file(s) or Go package(s) that exercise
  the invariant. "None (ADR/review discipline only)" means the law is a
  judgment call checked by whoever reviews the PR, not by CI.
- **CI gate** — where that enforcement runs. **Required** = in the `ci` job's
  `needs:` list in [.github/workflows/ci.yml](../.github/workflows/ci.yml);
  a failure blocks merge. **Report-only** = runs on every PR (or on a
  schedule) and is visible, but does not block merge — per the project's own
  standing decision recorded in `ci.yml`'s "Report-only jobs" comment, this
  is deliberate, not an oversight: promote a job into `needs:` once it fails
  only on genuine regressions rather than permanently-known noise (pnpm-audit
  is the one precedent so far).
- **Known exceptions** — ADRs that record a deliberate, reasoned departure
  from the law, per `design-laws.md`'s own rule that any intentional
  violation requires one.

## Law-to-enforcement matrix

| Law | Invariant checked | Enforced by | CI gate | Known exceptions |
|---|---|---|---|---|
| **LAW-01** — Flexible above, rigid below | Go packages under `go-host/internal/` contain no product/prompt/business logic — only security- and liveness-critical mechanism. | None (ADR/review discipline only). No automated check inspects *what kind* of logic lands in a Go package; this is caught, if at all, by PR review against the law's failure signal. | — | — |
| **LAW-02** — No Go for ordinary customization | A channel/workflow/prompt change never requires touching `go-host/`. | None (ADR/review discipline only). There is no "customization regression suite" today; `git diff --stat` scoped to `go-host/` on a customization PR is a manual check, not an automated one. | — | — |
| **LAW-03** — Upstream compatibility before feature growth *(satisfied for the current contract surface — see Provenance note above)* | TypeScript-observable behavior (guard decisions, channel registration, outbound delivery, unknown-sender handling) matches recorded fixtures; checked per-contract against `compatibility-matrix.md` before that specific contract is extended, not as a blanket hold on all feature work. | `src/differential/fixtures*.test.ts` (guard-catalog, channel-registration, outbound-delivery, unknown-sender, batch2), `go-host/internal/parity/parity_test.go` | **Required** — `src/differential/*` runs inside the `test` job; `go-host/internal/parity` runs inside the `go-host` job. | `docs/ADR-002-differential-parity-scope.md` (scope of what's covered); `go-host/docs/ADR-027-feature-growth-phase-transition.md` (phase-transition reading) |
| **LAW-04** — Every security control needs low-friction UX | Guard decisions are explicit allow/hold/deny (never a blanket re-prompt), and a live grant can be revalidated instead of re-asked. | `src/guard/conformance.test.ts` | **Required** — inside `test`. | — |
| **LAW-05** — Every component must justify itself | No new daemon/service/queue is added without a complexity trade-off being written down. | None (ADR/review discipline only). Dependency-graph growth (`go.mod`, `package.json`) is reviewed by eye on each PR; no CI check flags a new runtime dependency category. | — | — |
| **LAW-06** — Contracts before rewrites | Every ported Go kernel slice has a behavioral-equivalence fixture captured *before* the TypeScript path is superseded. | `src/differential/fixtures*.test.ts`, `go-host/internal/parity/parity_test.go` (same suite as LAW-03 — the contract-capture and the compatibility-preservation checks are the same tests, read from two directions) | **Required** — `test` + `go-host` jobs. | — |
| **LAW-07** — Mechanism in Go; experience in flexible layer ("exclusive enforcement" — see `design-laws.md`'s annotated reading) | The three Docker-facing functions (`wakeContainer`, `buildAgentGroupImage`, `killContainer`) and the decisions that gate them are *physically* unreachable except through the Go kernel — not merely decided by it. Concretely today: zero `docker create/start/kill/build` calls outside the kernel path; egress-lockdown network topology is kernel-enforced, not TypeScript-advisory. | `src/drivers/docker-driver.test.ts`, `src/guard/conformance.test.ts`, `src/modules/kernel-supervisor/index.test.ts` (egress-lockdown network-wiring block), `go-host/internal/kernel` (+ `FuzzDispatch`), `scripts/ec08-egress-lockdown-live-smoke.ts` | **Required**: `test`, `go-host`, `live-egress-lockdown` (the only required *live-Docker* proof of this law). **Report-only**: `go-ec05-live-docker`, `go-egress-live-docker`, `live-host-docker`, `go-fuzz-smoke` (`FuzzDispatch` target). | `go-host/docs/ADR-016-p9-ec02-narrow-enforcement-boundary.md` (defines the boundary); `ADR-024/025/026` (the regression this law's own annotation warns about, found and fixed 2026-09-24 — the concrete reason this document exists) |
| **LAW-08** — No weaker security than upstream | Mount allow-listing, path-traversal checks, credential-sensitive path blocking, credential isolation, and container restrictions are at least as strong as upstream NanoClaw's. | `src/modules/mount-security/index.test.ts` + `index.coverage.test.ts`, `go-host/internal/mount` (+ `FuzzValidateSpec`), `go-host/internal/ownership` (+ `FuzzValidateID`, `FuzzSafeMailboxPath`), `go-host/internal/containerdefaults` (+ `FuzzEnforceSafeDefaults`), `go-host/internal/security`, `go-host/internal/securitycheck`, `go-host/internal/credential`, `go-host/internal/credentialbroker` | **Required**: `test`, `go-host`, `pnpm-audit`. **Report-only**: `bun-audit`, `go-vulncheck`, `semgrep` (full `go-host/` scan), `go-fuzz-smoke` (mount/ownership/containerdefaults targets). | `go-host/docs/ADR-004-p5-02-mount-hardening.md`, `ADR-006-p5-05-credential-isolation.md`, `ADR-013-p8-05-egress-network-controls.md`, `ADR-021-hardened-runtime-class-check.md` |
| **LAW-09** — Upstream moves independently | A routine upstream NanoClaw release that doesn't change a contract the kernel consumes requires zero Go source changes; the pin is a deliberate, reviewed promotion, not silent drift. | `docs/upstream-pin.json` (machine-readable pin, hand-updated only), `go-host/docs/compatibility-matrix.md`, `go-host/docs/version-compatibility.md` | **Report-only, scheduled**: `upstream-watch` (diffs live upstream release tag against the pin), `egress-image-watch` (diffs the live `alpine:3.20` digest against the pinned helper-image digest in `go-host/internal/egress/egress.go`). Neither blocks merge — both alert-only by design (`continue-on-error: true`); a mismatch means "re-run the review," not "CI failed." | `go-host/docs/ADR-017-p9-07-upstream-overlap-review.md` (the dated review the pin's claims are current as of) |

## Non-functional / security requirements

`docs/threat-model.md` (+ `docs/threat-model-addendum-p5.md`) is the closest
thing this project has to a maintained NFR/security-requirements document —
an exhaustive trust-boundary map (`host` / `human` / `agent` / `system`
actors) and a table of every Docker-facing call site, who can reach it, and
whether it's guarded. It is actively cross-referenced (README, several
ADRs) and was last updated 2026-09-12. Treat it as the canonical NFR source
rather than duplicating its content here — this document's job is to point
at it and note when it goes stale, not restate it.

**Known staleness risk**: `threat-model.md`'s trust-boundary map was last
verified against the pinned upstream commit recorded in
`docs/upstream-pin.json`. Any PR that changes `container-runner.ts`'s
Docker-facing surface, `src/guard/`, or the `ncl` command catalog should
re-check that map by eye — nothing currently re-verifies it automatically.

## General regression safety net (TypeScript feature growth and hardening)

This section covers the second stream from the Provenance note above: new
TypeScript features and TS-side hardening that the nine laws don't govern
(LAW-02 keeps them out on purpose). "Don't break the project" for this
stream comes from CI/PR hygiene, applied uniformly to every change,
Go-kernel or not — not from a law-by-law table.

| Safety net | What it catches | CI gate |
|---|---|---|
| `test` (host + differential + guard + mount-security + kernel-supervisor unit suites) | Any behavioral regression in changed or adjacent TypeScript code — including a new feature accidentally breaking an existing guard, mount, or delivery invariant even though no design law names it directly. | **Required** |
| `coverage-gate` (`scripts/check-coverage-baseline.ts` vs. `.github/coverage-baseline.json`) | New code shipped with materially less test coverage than the existing baseline across statements/branches/functions/lines. | **Required** |
| `performance-gate` (`PERF-GATE:`-tagged tests) | A new feature or hardening change silently degrading a latency/throughput bound an earlier PR established. | **Required** |
| `pnpm-audit` | A new host-side dependency (direct or transitive) with a known vulnerability. | **Required** |
| `bun-audit` | Same, for `container/agent-runner`'s dependency tree. | Report-only |
| `semgrep` (`go-host/` full scan) | Common Go security anti-patterns, independent of whether a design law names the specific file. | Report-only |
| PR hygiene (`git diff upstream/main --stat`, `git log upstream/main..HEAD --oneline`, per `CLAUDE.md`) | Accidental inclusion of installation-specific files, or a diff larger/different than the PR description implies. | Manual, pre-submission checklist |

Unlike the law table above, this section is not trying to be exhaustive
about *invariants* — it's the general net that catches "something broke"
regardless of which invariant, for the stream the nine laws were never
meant to cover. A feature PR that also introduces a new privileged action
still needs the LAW-07 question asked (see Provenance note) — this table is
what catches everything else.

## End-to-end wiring / seam coverage

Design-law violations aren't the only way this project breaks: ADR-024 shipped
because a real, guard-gated, production-reachable function (`dockerNetworkArgs`)
had no remaining caller, and every test for it mocked the exact seam where the
disconnect happened. `go-host/docs/ADR-022-cli-channel-kernel-seam-test.md`
established the right methodology for catching this — enumerate every test
touching a privileged path, check whether they all mock the same middle layer,
and if so write one test that doesn't. A 2026-09-24 audit applied that same
methodology to every other privileged path in the codebase. Full findings:
`go-host/docs/ADR-024-*.md` through `ADR-026-*.md` (the fixed case) and the
table below (open cases, not yet fixed).

| Path | Verdict | Evidence |
|---|---|---|
| Channel → kernel wake (`wakeContainer` via `router.ts`) | **Spans the seam** | `src/cli-channel-kernel-smoke.test.ts` (ADR-022) |
| OneCLI credential-approval callback | **Spans the seam** | `src/modules/approvals/onecli-approvals.coverage.test.ts` — only the external gateway SDK is faked, everything else (DB, approver resolution, delivery, resolution) is real |
| Mount structural validation (`validateSpec`) | **Spans the seam** | `src/mount-composition.test.ts` — real `buildMounts`/`mountPolicy`/`validateSpec` with negative cases |
| Egress lockdown network wiring | **Spans the seam** (as of ADR-026) | `scripts/ec08-egress-lockdown-live-smoke.ts`, required CI gate |
| Go kernel `container.wake` / `container.kill` | **Spans the seam** | `adversarial_live_docker_test.go`, EC-07 (`go-host/docs/ADR-023-*.md`) |
| `buildAgentGroupImage` / Go `container.build_image` | **Spans the seam** (closed 2026-09-24) | `src/modules/self-mod/apply.test.ts` + `apply-install-packages.smoke.test.ts` (TS side, real business logic + real kernel socket) and `go-host/internal/kernel/build_image_live_docker_test.go` (Go side, live-verified: a real `docker build` produces a real tagged image) |
| CLI-derived `restart`/`--rebuild` guard path | **Spans the seam** (closed 2026-09-24) | `src/cli/resources/groups-restart-cli-kernel-smoke.test.ts` — proves, over a real kernel socket, that `container.build_image` carries no guard (ADR-016's accepted gap) while `container.kill` carries the `cliRestart` `GuardContext` (ADR-015) |
| Mount allowlist check (`validateAdditionalMounts`, operator-facing) | **Spans the seam** (closed 2026-09-24) | `src/mount-composition-additional-mounts.test.ts` — a malicious `additionalMounts` entry pushed through the real `buildMounts` composition is dropped; an allowlisted one survives into a validated `SessionSpec` |
| Agent-to-agent messaging (`a2a.send`, `agents.create`) | **Spans the seam** (closed 2026-09-24) | `src/modules/agent-to-agent/create-agent-kernel-smoke.test.ts` (a successful `create_agent` wakes the real source session over a real kernel socket) and `agent-route-kernel-smoke.test.ts` (a self-send `a2a.send` route resolves the target session and wakes it for real). `create-agent.test.ts`/`agent-route.test.ts` keep their existing mocking — these are new, additive files, not rewrites of the authorization tests. |
| Scheduled/due-message sweep → wake | **Spans the seam** (closed 2026-09-24) | `src/host-sweep-kernel-smoke.test.ts` — a real sweep tick against a real on-disk mailbox with a genuinely due message wakes the session over a real kernel socket. `host-sweep.coverage.test.ts`/`host-sweep-grace.test.ts` keep their existing mocking (they test the sweep's decision logic — due-message detection, stuck-claim SLA, grace periods — which this new file doesn't repeat). |

All ten rows above now **span the seam** — five pre-existing (channel/kernel
wake, OneCLI approvals, mount structural validation, egress lockdown, Go
`wake`/`kill`) plus five closed 2026-09-24 (`buildAgentGroupImage`, the CLI
restart path, the mount allowlist, a2a messaging, the scheduled sweep). The
first three of the five 2026-09-24 closures are tracked in
`docs/wiring-registry.json`, checked on every PR by the required
`wiring-registry-check` CI job (`go-host/docs/ADR-028-wiring-boundary-registry.md`).
The a2a and sweep closures deliberately are NOT separate registry entries:
they're new call sites of `wakeContainer`, which the registry already tracks
via its one canonical entry (`src/cli-channel-kernel-smoke.test.ts`) — the
registry's schema is per-function, not per-call-site, and adding a second
entry for the same function would need a schema change this narrow-scope
mechanism (LAW-05) doesn't yet warrant. Their evidence lives here instead.

## Boundary verification (runtime isolation, not just wiring)

A different axis from the seam table above: once a privileged path *is*
wired and called, does the actual runtime isolation guarantee hold, or is it
only decided in code and never checked against anything real? A 2026-09-24
audit checked seven such claims. Four were already **live-verified**
(Docker-socket exposure, NDJSON protocol-version rejection, guard-grant
cross-scope binding, and — not applicable, since neither makes an
enforcement claim to test — the hardened-runtime-class check and the
rootless-install mode). Three were **decided-but-unverified**; all three are
now closed and tracked in `docs/wiring-registry.json`'s `boundaries[]`
section:

| Claim | Verdict | Evidence |
|---|---|---|
| Credential-shaped contributed-env values never reach a real container's environment | **Live-verified** (closed 2026-09-24, highest-priority boundary finding) | `go-host/internal/kernel/credential_boundary_live_docker_test.go` — EC-07/EC-08 deliberately stub the gateway's credential contribution to avoid exercising this exact check; verified live: a `sk-ant-...`-shaped value never reaches `docker create`, an ordinary value does land in the real container's real env (positive control) |
| A normally-spawned container's real mounts match intent, and an unmounted path is unreachable from inside it | **Live-verified** (closed 2026-09-24) | `go-host/internal/kernel/mount_confinement_live_docker_test.go` — the prior live coverage (`adversarial_live_docker_test.go`) was scoped narrowly to the Docker-socket/`.ssh` adversarial pair; this is the general case, including a real `docker exec` read attempt against an unmounted path |
| The approval CAS (`transitionPendingApprovalStatus`) allows a held action to execute exactly once under concurrent resolution | **Live-verified against a real DB** (closed 2026-09-24, lowest-priority boundary finding) | `src/db/pending-approval-race.test.ts` — two concurrent, and separately ten concurrent, `pending→approved` transitions on the same row resolve to exactly one success |

## Known gaps (stated honestly, not solved by this document)

- **OBJ-XX objectives are not in the repo.** They're cited throughout ADRs
  and in `design-laws.md` itself, but sourced only from
  `NanoClaw_Go_Host_Project_Master_Plan_UPDATED.xlsx`, an external,
  non-version-controlled file. ADR citations to an `OBJ-XX` can't be
  independently audited from the repo alone.
- **No living phase/plan tracker in-repo.** Phase/task IDs (`P1-04`,
  `P9-EC02`, etc.) appear throughout ADR filenames and prose but there is no
  in-repo index of what each phase covered or its current status.
- **LAW-01, LAW-02, and LAW-05 have no automated enforcement at all** — see
  the table above. They're the three laws whose failure signal is about
  *what kind* of logic or dependency was added, which is a judgment call,
  not (today) a pattern a script can reliably check. Flagged rather than
  quietly left blank.
- ~~**This table itself is not yet enforced.**~~ **Closed 2026-09-24.** The
  seam-coverage and boundary tables' entries are now mirrored in
  `docs/wiring-registry.json` and re-checked on every PR by the required
  `wiring-registry-check` CI job — see `go-host/docs/ADR-028-wiring-boundary-registry.md`.
  Scope stays narrow: the registry only covers `container-runner.ts`'s
  privileged functions, the Go kernel's capability table, and the specific
  boundary claims two dated audits found — not every row in the general
  regression safety net further up this document, and not a promise that
  this whole document can never drift (the "General regression safety net"
  table and the "Law-to-enforcement matrix" above still have no equivalent
  automated staleness check).

## ADR index and law-breach log

Every ADR the project has, one line each, in date order. **Breach status**
distinguishes three things design-laws.md's own text otherwise blurs
together: an ADR can *cite* a law as reasoning for a compliant decision, can
*disclose* a temporary, deliberate, tracked gap against a law (sequencing,
not a violation), or can record an actual **regression** — a law that was
satisfied and silently stopped being true. Only one ADR in this project's
history is the third kind.

| ADR | One-liner | Date | Breach status |
|---|---|---|---|
| [001](ADR-001-milestone-b-protocol-proof.md) | First Go-side protocol proof for the host↔kernel wire format; decision to continue the project. | 2026-09-01 | N/A |
| [002](ADR-002-differential-parity-scope.md) | Scopes exactly which TS behaviors are in/out of differential-parity testing; some fixtures excluded permanently as customization-hook-dense (KEEP-TYPESCRIPT-FOREVER). | 2026-09-02 | Compliant citation (LAW-01/02) |
| [003](ADR-003-phase5-enforcement-architecture.md) | Accepts Phase 5's Go security packages as validation-only, not yet exclusive enforcement — explicitly defers LAW-07's actual bar to P6-02 rather than rushing it. | 2026-09-02 | **Disclosed gap** (LAW-07, sequencing) — closed by [008](ADR-008-p6-02-ts-go-enforcement-boundary.md) |
| [004](ADR-004-p5-02-mount-hardening.md) | Ports mount-security hardening to Go; new allowlist check defaults off, reproducing upstream's exact behavior first; flags an unresolved OneCLI mount-origin interaction. | 2026-09-02 | Compliant citation (LAW-06) |
| [005](ADR-005-p5-04-session-ownership.md) | Finds a latent, unexploited path-traversal *assumption* (not a live exploit) in session/mailbox ID handling, present identically in both TS and Go hosts. | 2026-09-02 | Disclosed finding (security gap shared with upstream, not Go-specific) |
| [006](ADR-006-p5-05-credential-isolation.md) | Ports credential isolation to Go by tracing/preserving the existing TS flow rather than redesigning it. | 2026-09-02 | N/A |
| [007](ADR-007-p5-06-security-scope-review.md) | Closes out Phase 5 (Security Kernel) with a review of what got built and what security value it actually delivered. | 2026-09-02 | Compliant citation (LAW-01/02) |
| [008](ADR-008-p6-02-ts-go-enforcement-boundary.md) | Builds the real TS↔Go enforcement boundary (five capability primitives over a local Unix socket) — closes ADR-003's validation-only gap; `wakeContainer`/`buildAgentGroupImage`/`killContainer` now require the kernel. | 2026-09-02 | **Resolution** of ADR-003's LAW-07 gap |
| [009](ADR-009-p6-05-customization-preservation-gate.md) | Runs a 20-scenario customization-regression catalogue proving Go-kernel enforcement can coexist with LAW-02; flags `container-runner.ts` as not yet rewired to call the kernel. | 2026-09-02 | **Disclosed gap** (LAW-07 not yet live in `container-runner.ts`) — since closed per ADR-016 and this session's own zero-docker-call verification |
| [010](ADR-010-p7-ux-operations.md) | Batches five small Phase 7 UX/ops additions (status, doctor, trace, security-check, error taxonomy) under one lightweight ADR. | 2026-09-02 | N/A |
| [011](ADR-011-p8-03-risk-based-approvals.md) | Defines a small risk-based approval model: automatic / context-approval / explicit-approval / prohibited. | 2026-09-02 | N/A |
| [012](ADR-012-p8-04-scoped-credential-flow.md) | Prototypes a scoped/temporary credential flow, limitations stated up front. | 2026-09-02 | N/A |
| [013](ADR-013-p8-05-egress-network-controls.md) | Evaluates egress/network controls: defers general domain allowlisting and a TLS-inspecting proxy; implements blocking cloud-metadata/link-local addresses (SSRF protection). | 2026-09-02 | Compliant citation (LAW-02/03/05 — deliberate non-build) |
| [014](ADR-014-p9-ec01-phase8-disposition.md) | Decides the Phase 8 capability/credential-broker prototypes stay prototypes for v1, not wired into the live kernel boundary. | 2026-09-02 | Compliant citation (LAW-05 — deliberate non-wiring) |
| [015](ADR-015-p9-ec04-kernel-side-guard-verification.md) | Establishes the restart/self-mod guard slice is enforced by independent kernel-side verification, not a TS-side decision mirrored into Go. | 2026-09-02 | Compliant citation (LAW-07) |
| [016](../go-host/docs/ADR-016-p9-ec02-narrow-enforcement-boundary.md) | Scopes EC-02's enforcement boundary to create/destroy/build only — supervision/discovery (attach, inspect) stay TypeScript-native since they make no admission decision. | 2026-09-02 | Compliant citation (LAW-07) |
| [017](../go-host/docs/ADR-017-p9-07-upstream-overlap-review.md) | Reviews upstream NanoClaw for drift against the pinned v2.3.0 baseline; clears no new differentiated feature work yet. | 2026-09-03 | Compliant citation (LAW-09) |
| [019](../go-host/docs/ADR-019-p9-ec06-live-smoke-findings.md) | EC-06: first live smoke test proving the full post-EC-02 protocol path (Go inbound → real agent-runner → Go outbound) against a real container. | 2026-09-05 | N/A |
| [020](../go-host/docs/ADR-020-p10-01-minimum-trust-install.md) | Adds a minimum-trust, rootless install option. | 2026-09-05 | N/A |
| [021](../go-host/docs/ADR-021-hardened-runtime-class-check.md) | `doctor` reports which container-runtime isolation class is active (plain OCI vs. hardened), so operators know the actual guarantee they have. | — | N/A |
| [022](../go-host/docs/ADR-022-cli-channel-kernel-seam-test.md) | Finds and closes a real wiring gap: every test on the channel→kernel wake path mocked the same seam; writes one test that spans it for real. | — | **Disclosed & fixed** — wiring/test-coverage gap (the methodology the 2026-09-24 audit above reuses) |
| [023](../go-host/docs/ADR-023-live-host-docker-leg.md) | EC-07: first live-Docker proof with the real TypeScript host in front of the kernel, not just the kernel's own test binary. | 2026-09-19 | N/A |
| [024](../go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md) | EC-02's refactor silently disconnected egress-lockdown's network wiring — the isolated network existed, but no container was ever attached to it. | 2026-09-24 | **Regression** (LAW-07, in substance — not cited by number in the ADR itself) — closed by [025](../go-host/docs/ADR-025-kernel-side-egress-lockdown-enforcement.md)/[026](../go-host/docs/ADR-026-egress-lockdown-live-ci-gate.md) |
| [025](../go-host/docs/ADR-025-kernel-side-egress-lockdown-enforcement.md) | Closes the follow-on gap ADR-024 left open: the kernel now refuses to start under egress lockdown unless it was actually given a network, instead of trusting the caller. | 2026-09-24 | **Resolution** (defense in depth for ADR-024) |
| [026](../go-host/docs/ADR-026-egress-lockdown-live-ci-gate.md) | EC-08: adds a required (not report-only) live-Docker CI gate asserting real container network isolation — closes the coverage hole that let ADR-024 ship undetected. | 2026-09-24 | **Resolution** (closes the test-coverage gap behind ADR-024) |
| [027](../go-host/docs/ADR-027-feature-growth-phase-transition.md) | Records LAW-03 as satisfied for the current contract surface — feature growth and TS hardening proceed alongside, not after, continued Go-kernel migration. | 2026-09-24 | Compliant citation (LAW-03, phase framing) |
| [028](../go-host/docs/ADR-028-wiring-boundary-registry.md) | Adds `docs/wiring-registry.json` + a required CI check — the standing, automated form of the wiring/seam and boundary audits, after the same failure shape (ADR-024's) was found or nearly found four times in one day. | 2026-09-24 | **Resolution** (closes the "table itself is not yet enforced" gap; prevents recurrence of the ADR-024 shape) |

**Note**: `ADR-018` does not exist — the numbering has a gap (never assigned or
since removed); not a data-loss concern, just recorded here so a reader
doesn't go looking for a missing file.

**The single confirmed regression** (ADR-024) is the only entry above where a
law was met, then silently stopped being met, without anyone deciding that on
purpose. Everything else marked "disclosed gap" was a known, stated,
tracked sequencing choice from the start — the project's actual failure mode
so far is *wiring drift after a refactor*, not *decisions made in bad faith*.
That is exactly what the "End-to-end wiring / seam coverage" section above
exists to keep hunting for.

## Maintenance

Update this document in the same PR as any of:
- A new or renamed CI job that changes what's required vs. report-only.
- A new ADR that records an exception to one of the nine laws.
- A test file named in the "Enforced by" column being renamed, moved, or
  deleted.
- A new Go kernel slice or TypeScript module that closes one of the "Known
  gaps" rows above (update the row, don't just delete it — note when and how
  it closed).
- A new privileged function added to `container-runner.ts`, or a new
  capability added to the Go kernel's dispatch table: add a
  `docs/wiring-registry.json` entry and a passing seam/live test in the same
  PR — `wiring-registry-check` (required CI, ADR-028) fails the moment one
  exists without the other.

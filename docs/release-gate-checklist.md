# v1 Release Gate Checklist

Status: living document, established 2026-09-03 (Phase 9/10, P9-06), last
re-run 2026-09-30 against the `isthmus-v1.2.0` release candidate (pinned to
NanoClaw `v2.4.0` — see `docs/promotion-v2.4.0.md` and
`go-host/docs/ADR-035-v2.4.0-pin-promotion-closure.md`). Turns
`claude/nanoclaw-go-host-master-plan.md`'s 12-layer "Test Strategy" table
into a concrete, dated release gate: which checks are automated vs. require
a human, what "pass" means for each, and — the part a table of test types
alone can't answer — what this project's ACTUAL status against each gate is
right now, as of this hardening phase. "Done when: Release checklist
clearly marks automated/manual gates and critical blockers" is this
document's own acceptance test; the status column exists so this doc can't
quietly go stale into a list of aspirations.

**How to use this before declaring any v1 release**: every row marked
**BLOCKER** below must be green, with the evidence cited actually re-run
against the release candidate (not assumed from a past run) before tagging
a release. Rows marked **advisory** are expected to run and be reviewed,
but a known, understood gap there does not by itself block a release — see
each row's own note for why.

## Automated gates (CI-enforced or CI-observable today)

| # | Gate | Automation | Current status | Blocker? |
|---|---|---|---|---|
| 1 | Go unit tests | `.github/workflows/ci.yml`'s `go-host` job (required, in the `ci` gate) | **Re-run 2026-09-30 against `231c9606` (current `main`).** All 26 packages pass, including the sqlite-dependent ones (`mailbox`, `session`, `kernel`) — this pass's sandbox could build `vendor/` locally and run them directly, closing the "not run in this project's own sandbox" gap noted previously. `go build ./...` and `gofmt -l` (excl. `vendor/`) both clean. Also confirmed independently green on GitHub Actions for this exact commit (25/25 check-runs). | **BLOCKER — green** |
| 9 | Race/static checks (`go vet`, `go test -race`) | Same `go-host` CI job; `golangci-lint` as a separate report-only job (`go-lint`) | **Re-run 2026-09-30.** `go vet ./...` clean. `go test -race ./...`: one apparent failure on first run (`TestDispatch_RouteRequestPerfBudget`, 408ms vs. a 400ms budget) — re-ran in isolation and it passed comfortably (279ms); root cause was this pass's own sandbox running several verification jobs concurrently, not a real race (no `DATA RACE` diagnostic anywhere in the output) or a real regression. `golangci-lint` not independently re-run this pass (not installed in this sandbox) — relying on CI's own green `go-lint` run for this commit instead of re-asserting a local "0 issues" claim. | **BLOCKER — green** (govet/race); lint relies on CI, not locally re-verified |
| 8 | Fuzz / negative tests | 6 targets total now (P9-02's original 5 plus `FuzzDispatch`), exercised two ways: seed corpora run as ordinary subtests inside row 1's `go test ./...`; real mutation-guided fuzzing runs in the `go-fuzz-smoke` CI job (20s/target/PR, report-only) | **Re-run 2026-09-30, 15s/target smoke pass, all 6 targets: 0 crashes across ~1.6M total executions.** Closes this doc's own previously-noted gap — `FuzzDispatch` (`internal/kernel`) had never been run in this project's own sandbox before; it has now, clean. | advisory (a crash here should block a release once found — the corpus-commit practice below makes it a row-1 unit-test failure retroactively, which IS a blocker) |
| 4 | Differential parity (Go vs. TS) | `internal/parity`, run inside the `go-host` CI job's `go test` | Still 20/65 captured TS fixtures ported (fixture count confirmed unchanged via a direct count of test functions in `internal/parity/*_test.go` this pass; the remaining 45 are permanently TS-only per ADR-002/ADR-015's scope decisions, not a gap). Passed clean as part of row 1's re-run. No unexplained difference. | **BLOCKER** for the 20 that exist; not applicable to the 45 that are deliberately TS-only |
| 12 | Upstream watch compatibility | `upstream-watch` CI job (P9-05, weekly + on-demand); manual review process in `go-host/docs/version-compatibility.md` | **Pin promoted to `v2.4.0`** (from `v2.3.0`) on 2026-09-27 — `go-host/docs/ADR-035-v2.4.0-pin-promotion-closure.md` is now the current closing review, superseding `ADR-017`'s v2.3.0-era one. ADR-035 found zero unresolved drift against this project's consumed contracts, with both of its own named follow-ups (gateway-lease continuity, `poll-loop.ts` turn-routing) closed in a 2026-09-28 addendum. No newer tagged upstream release exists yet as of this pass. | advisory (a detected mismatch is a prompt for review, not itself a release blocker — see `version-compatibility.md` §3) |

## Gates that exist but are not (yet) CI-automated — human-run, evidence-based

| # | Gate | Automation | Current status | Blocker? |
|---|---|---|---|---|
| 2 | Upstream test baseline | Manual, one-time-per-pin recording | `docs/baseline.md`'s P0-09 baseline (15 known, documented, non-regressed failures in two files at the v2.3.0 checkout) has not been separately re-recorded at the new v2.4.0 pin this pass — carried over as the reference point, not re-established. See row 3 for this pass's own fresh full-suite evidence at the current pin instead. | **BLOCKER** if a release candidate shows MORE than the 15 documented v2.3.0-era failures; a fresh v2.4.0 baseline recording is a good follow-up, not done this pass |
| 3 | Contract tests (TS-side differential fixtures) | `pnpm exec vitest run` inside CI's `test` job — technically automated, listed here rather than above because it's TS-side, not this checklist's Go-CI focus | **Re-run 2026-09-30 against `231c9606`.** Full suite (4389 tests, 364 files): all pass. First attempt showed flakes (8, then 4, tests failing across 2 runs) — traced to this pass's own verification method, not real code: 3 of them (`upgrade-state.test.ts`) test git-identity detection and were run from a tarball export with no `.git` present (the test suite's own code explicitly anticipates and names this "exported/mounted without .git" scenario — it just wasn't the environment those particular assertions expected); the rest reproduced clean in isolation (contention flakes from running several verification jobs at once). `tsc --noEmit` also clean. Also independently confirmed green on GitHub Actions for this commit. | **BLOCKER — green** |
| 5 | Protocol integration (unchanged agent-runner compatibility) | `scripts/ec06-live-smoke.sh` (manual — not yet a CI job) dispatches `container.wake`/`container.kill` through a real, long-lived `nanogo serve` process's actual Unix socket | **Closed — see `go-host/docs/ADR-019-p9-ec06-live-smoke-findings.md`.** Verified live on the real Mac, 2026-09-05: 2/2 repeats passed against one long-lived `nanogo serve` process, byte-identical `kind`/`content`, kernel-derived container names confirmed from the wake response itself (never asserted by the script), a real Docker daemon, and the real unmodified agent-runner image. Supersedes P6-03's proof and P0-08's manual round trip as the current evidence — both predate EC-02 and never exercised the kernel-mediated path. | **Closed. Automatable since 2026-09-19 (EC-07), verified live that day: 2/2 repeats — real CLI socket → real router → real kernel → real container → real reply back out the same socket, with the kernel-derived name holding still across two wakes of one session while the host's predicted name changed.** `scripts/ec07-live-host-smoke.sh` runs that path with the TypeScript host in front of it, and the report-only `live-host-docker` job runs that harness weekly and on `workflow_dispatch` — dispatch it against the release candidate. See `go-host/docs/ADR-023-live-host-docker-leg.md`. `scripts/ec06-live-smoke.sh` remains the manual harness to re-run when the kernel itself is what changed, since it drives the kernel with no host in the way. |
| 6 | Customization regression | Manual — the 20-scenario catalogue (P6-01) and preservation gate (P6-05) are a checklist/report, not a CI job | **Not re-run this pass — flagged, not carried forward silently.** The last confirmation (2026-09-20, `a34ec854`) reasoned that the cited Go packages were untouched since Phase 6 except one isolated change; that reasoning no longer holds as-is, since the v2.4.0 promotion (PR #51/#52) materially changed TS customization-adjacent surface (`gateway-provider-seam`, OneCLI restructuring, mount-composition rewrite). | **Open for this release candidate.** Needs either a fresh audit of what the promotion touched against the 20 scenarios' own routing, or a full live re-execution, before tagging v1.2.0 — not yet done. |
| 7 | Security regression | Split: automated invariants (path traversal, forged IDs, non-root defaults — rows 1/8/9 above) are green; adversarial/red-team coverage — see Current status | EC-05's original pass (`go-host/docs/ADR-018`) predates the promotion, but the promotion's own Workstream C closure covers the *new* surface directly: **`go-host/docs/ADR-035`** records three real trust-boundary findings from that review (canonical-label precedence, `approverUserId` persistence, OneCLI mount-path allowlisting) each closed with a negative-control-verified regression test — zero accepted exceptions. Effectively an adversarial-equivalent pass for exactly the surface EC-05 didn't cover. | **Closed** — EC-05 for the pre-promotion surface, Workstream C for the promotion's own new surface. |
| 5, 11 | Protocol integration / live smoke tests | `scripts/ec06-live-smoke.sh` / `ec07-live-host-smoke.sh` (manual); `live-host-docker` CI job (report-only, weekly + `workflow_dispatch`) | Prior evidence (2026-09-05/06, pre-promotion) still stands for the kernel-mediated-path mechanics themselves — see ADR-019/ADR-023 and `docs/rollback-runbook.md`. **Not yet re-run against the actual v1.2.0 candidate.** A real install-and-round-trip test against a live Telegram bot, run directly from current `main`, is planned before tagging — see below. | **Open, in progress.** P10-05's multi-operator/multi-channel outside-tester pass also remains not started — same as prior releases, disclosed rather than implied away. |

## What this phase (P9-01–P9-09 / Phase 9-10) changed about this table

- Turned row 8 (fuzz) from "targets exist, run by hand" into "targets exist,
  AND run for real (mutation mode) on every PR" via `go-fuzz-smoke`.
- Turned row 12 (upstream watch) from "recorded once by hand in
  `docs/baseline.md`" into "checked automatically on a schedule, with a
  documented human-review process for what to do on a mismatch."
- Rows 1/9 (unit tests, race/static) gained real, freshly-run evidence this
  phase (the pre-existing `guardpolicy/policy_test.go` lint finding, found
  and fixed) rather than resting on the P9-01 close-out's own claim.
- Added a new crash/restart dimension to row 1's coverage (P9-03) and a new
  malformed/corrupt-state dimension (P9-04). Both feed row 1 and row 7
  (security regression's automated half) rather than becoming a new
  numbered row of their own — the master plan's 12 layers already
  anticipated both under existing numbers 1/7/10, and this table follows
  that numbering.
- **Did not, and could not, touch rows 5, 6, 7's adversarial half, or 11** —
  those need either a live running system, a real TS-side customization
  re-run, or the user's own adversarial-pass session (EC-05), none of which
  this autonomous hardening pass has access to. Naming that plainly here is
  this checklist doing its job.

## v1.2.0 prep (2026-09-30) — what this pass re-verified, and what it didn't

- Rows 1, 3, 4, 9 (unit tests, contract tests, differential parity,
  race/static) all gained fresh, dated evidence against the actual v2.4.0-
  pinned candidate (`231c9606`) — see each row's own cell. Row 1 also
  closed a standing gap: the sqlite-dependent Go packages and `FuzzDispatch`
  had never run in this project's own sandbox before; both have now, clean.
- Row 12 (upstream watch) updated to reflect the v2.3.0→v2.4.0 promotion
  and `ADR-035` as the current closing review.
- Row 7 (security regression) reasoned through explicitly rather than left
  stale: EC-05 predates the promotion, but `ADR-035`'s own Workstream C
  closure is a real adversarial-equivalent pass for exactly the surface
  the promotion added, so this row stays closed on that basis, not by
  default.
- Row 2 was **not** re-established at the new pin — this pass reused
  row 3's fresh full-suite run instead of re-recording a formal baseline.
  Worth doing properly as a follow-up.
- Row 6 (customization regression) is flagged **open**, not silently
  carried forward — the promotion touched customization-adjacent TS
  surface the last confirmation's own reasoning depended on being
  untouched.
- Rows 5/11 (live protocol integration / live smoke) are **open, in
  progress** — a real install-and-round-trip test against a live Telegram
  bot, run from current `main`, is planned before tagging `isthmus-v1.2.0`.
  The multi-operator outside-tester pass (P10-05) remains not started,
  same as it was for v1.0.0 and v1.1.0.

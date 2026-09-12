# v1 Release Gate Checklist

Status: living document, established 2026-09-03 (Phase 9/10, P9-06). Turns
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
| 1 | Go unit tests | `.github/workflows/ci.yml`'s `go-host` job (required, in the `ci` gate) | Offline-buildable subset (`capability`, `config`, `containerdefaults`, `credential`, `credentialbroker`, `guardpolicy` prod code, `hosterrors`, `hostinfo`, `mount`, `ownership` prod code, `trace`) independently re-verified this phase; the sqlite-dependent packages (`mailbox`, `session`, `kernel`, and the two sqlite-backed test files `guardpolicy/policy_test.go`, `ownership/ownership_test.go`) have not been run in this project's own development sandbox (no network access to stage `vendor/`) — CI/Mac is where they actually execute. No known failing test as of this phase's own work. | **BLOCKER** |
| 9 | Race/static checks (`go vet`, `go test -race`) | Same `go-host` CI job; `golangci-lint` as a separate report-only job (`go-lint`) | `golangci-lint run` returns "0 issues" across the entire offline-buildable subset (re-confirmed this phase, including a real pre-existing `errcheck` finding in `guardpolicy/policy_test.go` found via a throwaway sqlite-stub harness and fixed this phase). `go test -race` itself needs the same sqlite/vendor chain as row 1 to run on the sqlite-dependent packages. | **BLOCKER** |
| 8 | Fuzz / negative tests | P9-02's 5 targets, exercised two ways: their seed corpora run as ordinary subtests inside row 1's `go test ./...`; real mutation-guided fuzzing runs in the new `go-fuzz-smoke` CI job (20s/target/PR, report-only) | All 5 targets: 0 failures across this phase's own local runs (~2M+ total executions on the 4 offline-testable targets; `FuzzDispatch` written but not yet locally run, needs Mac/CI). One real bug was found and fixed this way this phase (`ownership.SafeMailboxPath`'s unvalidated `side` parameter). | advisory (a crash here should block a release once found — the corpus-commit practice below makes it a row-1 unit-test failure retroactively, which IS a blocker) |
| 4 | Differential parity (Go vs. TS) | `internal/parity`, run inside the `go-host` CI job's `go test` | 20/65 captured TS fixtures ported and parity-tested in Go so far (by design — the rest are permanently TS-only per ADR-002/ADR-015's scope decisions, not a gap). No unexplained difference among the 20. | **BLOCKER** for the 20 that exist; not applicable to the 45 that are deliberately TS-only |
| 12 | Upstream watch compatibility | `upstream-watch` CI job (P9-05, weekly + on-demand); manual review process in `go-host/docs/version-compatibility.md` | Pin is `v2.3.0` (`docs/upstream-pin.json`); `ADR-017` reviewed it 2026-09-03 and found no drift against this project's consumed contracts. No newer tagged release exists yet as of that review. | advisory (a detected mismatch is a prompt for review, not itself a release blocker — see `version-compatibility.md` §3) |

## Gates that exist but are not (yet) CI-automated — human-run, evidence-based

| # | Gate | Automation | Current status | Blocker? |
|---|---|---|---|---|
| 2 | Upstream test baseline | Manual, one-time-per-pin recording | `docs/baseline.md`'s P0-09: 1991/2006 vitest tests passing (15 known, documented, non-regressed failures in two files, root cause not chased — "record baseline, don't fix yet") at the pinned v2.3.0 checkout, confirmed not folder-name-related. | **BLOCKER** if a release candidate shows MORE than these 15 documented failures; not a blocker for the 15 themselves |
| 3 | Contract tests (TS-side differential fixtures) | `pnpm exec vitest run` inside CI's `test` job — technically automated, listed here rather than above because it's TS-side, not this checklist's Go-CI focus | Part of row 2's same baseline run; passing. | **BLOCKER** |
| 5 | Protocol integration (unchanged agent-runner compatibility) | `scripts/ec06-live-smoke.sh` (manual — not yet a CI job) dispatches `container.wake`/`container.kill` through a real, long-lived `nanogo serve` process's actual Unix socket | **Closed — see `go-host/docs/ADR-019-p9-ec06-live-smoke-findings.md`.** Verified live on the real Mac, 2026-09-05: 2/2 repeats passed against one long-lived `nanogo serve` process, byte-identical `kind`/`content`, kernel-derived container names confirmed from the wake response itself (never asserted by the script), a real Docker daemon, and the real unmodified agent-runner image. Supersedes P6-03's proof and P0-08's manual round trip as the current evidence — both predate EC-02 and never exercised the kernel-mediated path. | **Closed. Must still be re-run manually before each release** (unchanged from before — `scripts/ec06-live-smoke.sh` is the harness that does it, not a new CI gate) until a real CI harness exists for it. |
| 6 | Customization regression | Manual — the 20-scenario catalogue (P6-01) and preservation gate (P6-05) are a checklist/report, not a CI job | Passed at ≥90% (P6-05's own gate) as of Phase 6's close-out; not re-run this phase (Phase 9/10 touched no TypeScript customization surface). | **BLOCKER — must be re-run against the actual release candidate**, not assumed current from Phase 6 |
| 7 | Security regression | Split: automated invariants (path traversal, forged IDs, non-root defaults — rows 1/8/9 above) are green; the adversarial/red-team pass across the live running system is now closed too — see Current status | **EC-05 (the project's own named "post-wiring adversarial pass") is done — `go-host/docs/ADR-018-p9-ec05-adversarial-pass-findings.md`: 16 tests against the real kernel enforcement path (`k.Dispatch`), 2 live-verified against a real Docker daemon. Headline finding: `mount.Policy.AllowlistedExtraCheck` defaults to `nil` unless `-allowlist` is configured — a real, confirmed, live-verified gap in the default configuration, not in the underlying validation mechanism, which works correctly once configured. ADR-018's own named follow-up (loudly flagging "no -allowlist configured" instead of silently passing, in `nanogo serve`/`doctor`/`security-check` alike) is also done.** | **Closed.** The default-config gap ADR-018 found is now a documented, loudly-flagged v1 posture rather than an open blocker — see ADR-018 and its own follow-up commit. |
| 11 | Live smoke tests | `scripts/ec06-live-smoke.sh` (manual — no CI job stands up a real container + real provider + a real test channel; see row 5) | **Closed — see `go-host/docs/ADR-019-p9-ec06-live-smoke-findings.md`.** A real Docker daemon, the real unmodified agent-runner image, and a real message round trip, with container lifecycle fully kernel-mediated (EC-02's own in-request-path guarantee), run live 2026-09-05. Does not cover a real Slack/Discord/CLI channel adapter round trip (TS-host routing, out of scope here, same boundary P3-06 already drew) or a real, non-deterministic Claude Agent SDK reply (P3-04 already covers that, pre-EC-02). **Update 2026-09-06:** the real-channel gap this row names is now separately covered — a solo pre-flight of P10-05/P10-07 ran a real Telegram bot round trip on stock NanoClaw, upgraded to Isthmus in place (same data directory), round-tripped again, then rolled back to stock and round-tripped a third time, with the same session/container adopted unchanged throughout. See `docs/rollback-runbook.md`'s "Verified: a real downgrade, end to end" section for the full account. Only Telegram was exercised (not Slack/Discord), and by one operator, not the 5-10 outside testers P10-05 itself calls for. | **Closed for the kernel-mediated-path scope this row names, and now additionally evidenced for one real external channel + the downgrade path. Must still be run against each actual release candidate** (unchanged expectation — row 5's harness is what does it), and P10-05's outside-tester pass is still open. |

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

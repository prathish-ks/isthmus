# NanoClaw Test Inventory (P2-01)

Recorded: 2026-08-31, against the pinned baseline (`go-host-experiment` branch, NanoClaw v2.3.0, commit `54d9d9a50c0e572fa3969d63ab87a4dd3d75cc6f`) in the `nanoclaw-go-lab` workspace.

## Purpose

This is Phase 2's first task: a complete, structured inventory of every existing test file in the codebase, tagged by which Go-kernel-decomposition category it exercises (per `docs/host-decomposition.md` and `docs/design-laws.md`). The goal is not to re-derive the decomposition — that work is done — but to answer the operational question Phase 2's differential-testing harness needs answered before it can be built: *which existing tests describe the exact behavior a Go port has to reproduce, which describe behavior that's staying in TypeScript untouched, and which don't cleanly belong to either?*

## Methodology

Every `*.test.ts` file under `src/`, `container/`, `scripts/`, and `setup/` was enumerated directly from the workspace (`device_list_dir`, recursive, excluding `node_modules`/`dist`/`.git`/build output), then staged into a scratch environment and scanned for `it(`/`test(`/`describe(` occurrences to approximate test-case density per file. Every file was hand-classified into one of four buckets based on which module/function it exercises, cross-referenced against `docs/host-decomposition.md`'s GO KERNEL / BOUNDARY / KEEP TYPESCRIPT calls and `docs/design-laws.md`'s LAW-07/OBJ-04 annotation (the three named `container-runner.ts` functions plus the guard logic that gates them):

- **GO-KERNEL** — tests the exact code that's slated to move behind the Go boundary (guard's decision seam, mount-security, host-sweep's `decideStuckAction`).
- **GO-KERNEL SLICE** — tests the narrower guard logic that specifically gates the three Docker-facing functions (self-mod's install/add-mcp-server guard, the CLI-derived `restart` guard) — the slice of the guard catalog that moves, per the "does guard() itself need to move" analysis already recorded in the project assessment.
- **GO-KERNEL-ADJACENT** — tests `container-runner.ts`'s `wakeContainer`/`buildAgentGroupImage`/`killContainer` themselves, i.e. the functions that need to become physically uncallable except through the kernel boundary.
- **BOUNDARY** — tests shared host/container contracts (mailbox model, central DB schema, the driver layer's `validateSpec`/`mountAllowed` chokepoint) that a Go component will need to either transcribe or differential-test against, but that aren't themselves moving.
- **KEEP TS / CONTAINER (Bun)** — tests customization surfaces, channel adapters, the CLI, setup wizard, and container-side agent-runner internals — everything Phase 1 already confirmed stays in TypeScript/Bun untouched.

**A methodological caveat, stated plainly**: the per-file test-case counts below come from a static regex count of `it(`/`test(` call sites, not from actually running the suite. Table-driven tests (`it.each`, or a `for` loop generating one `it()` per fixture case) are counted once per static call site but can expand to more than one test at runtime. This is why the static total below (2013) undercounts `pnpm test`'s actual reported collection (2006 for the vitest-tracked subset alone, per `docs/baseline.md` — see the reconciliation below). The static counts are useful for gauging relative test *density* per file, not as an authoritative test count; the authoritative count is whatever `pnpm test` / `bun test` report when actually run.

## Two test runners, not one

NanoClaw's own `vitest.config.ts` deliberately excludes `container/agent-runner/**` from the vitest run, with an explicit comment: those tests depend on `bun:sqlite` and run under `bun test` instead (see `container/agent-runner/package.json`'s own `"test": "bun test"` script). This split matters for Phase 2 because it means the compatibility harness will eventually need to speak to two different test runners, not one, if agent-runner-side behavior is ever in scope — though today it isn't: Phase 1 classified all of `container/agent-runner/` as KEEP TYPESCRIPT (Bun), unaffected by the Go-kernel work.

| Runner | Include pattern | Files | Approx. static test cases |
|---|---|---|---|
| **vitest** (`pnpm test`) | `src/**/*.test.ts`, `setup/**/*.test.ts`, `scripts/**/*.test.ts`, `container/*.test.ts` (top-level only) | 160 | ~1684 |
| **bun test** (`container/agent-runner`) | `container/agent-runner/src/**/*.test.ts` | 39 | ~329 |
| **Total** | | **199** | **~2013** |

**Reconciliation against the recorded baseline**: `docs/baseline.md` records the vitest run at **161 files / 2006 tests** (99.25% pass, 15 known failures in 2 files) as of 2026-08-29. This inventory finds 160 vitest-tracked files as of 2026-08-31 — a one-file difference, most likely a test file added or removed between the two snapshots (several files carry mtimes from 2026-08-30, after the baseline was recorded, consistent with the mount-security hardening work and other small edits landing on the branch since). This is noted, not chased further — it's a rounding-level discrepancy, not a regression signal. The gap between this inventory's static ~1684 and the baseline's runtime-collected 2006 is the `it.each`/table-driven-test undercount described above, not a missing-file problem.

## Inventory by category

| Category | Files | Approx. test cases |
|---|---:|---:|
| CONTAINER (Bun): agent-runner internals | 39 | ~329 |
| KEEP TS: setup/install wizard | 35 | ~293 |
| KEEP TS: scripts/tooling | 14 | ~273 |
| KEEP TS: host misc | 20 | ~196 |
| KEEP TS: CLI (non-guard) | 12 | ~175 |
| KEEP TS: channel adapters | 13 | ~112 |
| BOUNDARY: central DB schema/types | 8 | ~80 |
| KEEP TS: templates/skills | 5 | ~80 |
| KEEP TS: permissions module | 6 | ~51 |
| KEEP TS: a2a (own grant-binding, not Docker-facing) | 4 | ~46 |
| BOUNDARY: docker driver (container spawn) | 1 | ~44 |
| GO-KERNEL-ADJACENT: container-runner (wake/build/kill) | 1 | ~35 |
| KEEP TS: router/session/delivery (message path) | 6 | ~35 |
| KEEP TS: cross-session-context | 4 | ~35 |
| BOUNDARY: drivers (other) | 3 | ~34 |
| KEEP TS: approvals module | 6 | ~29 |
| BOUNDARY: mailbox (other) | 4 | ~27 |
| KEEP TS: self-mod (non-guard) | 2 | ~27 |
| GO-KERNEL: host-sweep (decideStuckAction) | 2 | ~24 |
| GO-KERNEL SLICE: cli restart guard (commandGuardSpec) | 4 | ~19 |
| GO-KERNEL: guard (decision seam) | 2 | ~16 |
| GO-KERNEL-ADJACENT: container-runner (restart path) | 1 | ~9 |
| KEEP TS: scheduling | 1 | ~9 |
| BOUNDARY: driver conformance (mountAllowed/validateSpec) | 1 | ~7 |
| BOUNDARY: mailbox/model (shared host/container contract) | 1 | ~7 |
| CONTAINER: top-level | 1 | ~7 |
| GO-KERNEL: mount-security | 1 | ~5 |
| GO-KERNEL SLICE: self-mod guard (gates the 3 functions) | 1 | ~5 |
| KEEP TS: typing | 1 | ~4 |
| **Total** | **199** | **~2013** |

## The tests that matter most for Phase 2/3 (Go-kernel-relevant subset)

Collapsing the categories above into the set Phase 1 identified as needing to move behind, or sit directly against, the Go boundary:

| File | Category | Cases |
|---|---|---:|
| `src/guard/guard.test.ts` | GO-KERNEL: guard | ~13 |
| `src/guard/conformance.test.ts` | GO-KERNEL: guard | ~3 |
| `src/modules/mount-security/index.test.ts` | GO-KERNEL: mount-security | ~5 |
| `src/host-sweep.test.ts` | GO-KERNEL: host-sweep | ~17 |
| `src/host-sweep-grace.test.ts` | GO-KERNEL: host-sweep | ~7 |
| `src/modules/self-mod/guard.test.ts` | GO-KERNEL SLICE | ~5 |
| `src/cli/resources/groups.test.ts` | GO-KERNEL SLICE (restart guard) | ~5 |
| `src/cli/resources/groups-plugin-guard.test.ts` | GO-KERNEL SLICE | ~7 |
| `src/cli/resources/groups-create-folder-reuse.test.ts` | GO-KERNEL SLICE | ~4 |
| `src/cli/resources/groups-restart-rebuild.test.ts` | GO-KERNEL SLICE | ~3 |
| `src/container-runner.test.ts` | GO-KERNEL-ADJACENT | ~35 |
| `src/container-restart.test.ts` | GO-KERNEL-ADJACENT | ~9 |
| `src/drivers/conformance.test.ts` | BOUNDARY (`validateSpec`/`mountAllowed`) | ~8 |
| `src/drivers/docker-driver.test.ts` | BOUNDARY (container spawn) | ~44 |
| `src/mailbox/model.test.ts` | BOUNDARY (shared contract) | ~7 |

This is a **compact, tractable set — 15 files, well under 200 static test cases** — which is itself a useful, reassuring finding for Phase 2's scoping: the differential-testing harness doesn't need to wrap the whole 199-file suite to start proving out Go/TypeScript behavioral parity. It needs these 15 files' worth of behavior (plus, per the design-laws annotation, the actual `mountAllowed`/`validateSpec` logic these tests exercise) to hold once the corresponding logic moves. Everything else in the 199-file inventory is a regression backstop for code that Phase 1 already confirmed is staying exactly where it is.

`src/drivers/conformance.test.ts` is worth a specific callout: at 31.7KB it's one of the larger test files in the repo by byte size, but only ~8 static test-case call sites — most of its bulk is the `FIXTURE_POLICY`/`fixtureSpecWithAux` fixture-building helpers this file (and the mount-security hardening patch's new tests) share. Byte size is not a proxy for test-case count anywhere in this inventory; treat the "cases" column, not file size, as the sizing signal for harness-design effort.

## Coverage gap worth flagging

**`src/egress-lockdown.ts` has no dedicated test file anywhere in the repo.** It was named in `docs/host-decomposition.md` as one of the strong, self-contained Go-kernel candidates (small, security/liveness-critical, alongside `host-sweep.ts`'s `decideStuckAction`), and the "Engineering principle" discussion in the project assessment doc suggested kernel-invariant tests as in-scope work regardless of the Go/TypeScript question. Unlike `guard.ts`, `mount-security`, and `host-sweep.ts` — which all have direct or conformance-level test coverage today — `egress-lockdown.ts` has none. This isn't a Phase 2 blocker (there's no existing behavior to differentially test against, so a Go port would need net-new tests either way), but it should be flagged before Phase 3 design work on this file starts, since "port existing tests" isn't an available strategy here the way it is for the other three.

## Known baseline failures don't touch the Go-kernel-relevant subset

`docs/baseline.md` records 15 known, pre-existing, unrelated-to-this-project test failures, in exactly two files: `scripts/add-dial-tool-scope.test.ts` (11 failures) and `scripts/update/transaction.e2e.test.ts` (4 failures). Both classify in this inventory as **KEEP TS: scripts/tooling** — neither is in the Go-kernel-relevant subset above. This is a useful cross-check: the known baseline noise sits entirely outside the files Phase 2/3 will actually be building differential tests against, so it can keep being safely ignored throughout the rest of this project without needing to be reconciled against Go-kernel work.

## Largest test files (by byte size, for context)

For anyone scoping how much reading a full pass over this suite would take: `scripts/skill-apply.test.ts` (70.9KB), `src/host-core.test.ts` (52.5KB), `setup/channels/run-channel-skill.test.ts` (33.5KB), `setup/channels/slack-auto.test.ts` (32.8KB), and `src/drivers/conformance.test.ts` (31.7KB) are the five largest. Three of these five are KEEP TS categories unrelated to the Go-kernel work; only `drivers/conformance.test.ts` is in the Go-kernel-relevant subset.

## What this means for Phase 2's next tasks

The compatibility-harness work that follows P2-01 should scope its first differential-testing target to the 15-file Go-kernel-relevant subset above, not the full 199-file suite — that subset is where a Go port's behavior actually needs to match TypeScript's byte-for-byte or decision-for-decision. The other ~184 files remain valuable as a regression backstop (any new failure among them during Go-host work is a real regression, per the standing baseline-comparison rule already established in Phase 0/1), but they don't need bespoke differential-testing infrastructure — plain "still green" checks against the existing baseline suffice for code that isn't moving.

## Next step

Proceed to the remaining Phase 2 tasks: designing the differential-testing harness itself (normalized parity output format, fixture strategy for the 15-file Go-kernel-relevant subset identified above) and, separately, deciding how to close the `egress-lockdown.ts` test-coverage gap before or during that file's own Phase 3 design work.

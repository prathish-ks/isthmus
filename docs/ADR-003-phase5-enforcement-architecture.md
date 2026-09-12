# ADR-003: Phase 5 Enforcement Architecture and Guard-Fixture Scope

**Status**: Accepted, 2026-09-02
**Task**: Pre-Phase-5 readiness prep, prompted by an Opus second-opinion review requested by the user after upgrading their subscription. Written before P5-01 begins.
**Depends on**: LAW-07's "exclusive enforcement" annotation (`design-laws.md`), `threat-model.md` (P1-04), ADR-002 (P4-06)

## Context

An Opus-model review of the project's governing documents, requested specifically to sanity-check Phase 5 (Security Kernel) readiness, found a structural gap: Phase 5's six tasks (P5-01 through P5-06) are all satisfiable by a Go package that *validates* a `SessionSpec` which TypeScript still composes and executes — advisory, not enforcement — while `design-laws.md`'s own LAW-07 annotation is explicit that a security kernel earns that name only when the real privileged effect is *physically impossible* to trigger except through the Go kernel. The task that would build that boundary — P6-02, "design minimal TypeScript ↔ Go host API... do not expose security bypass knobs" — sits in Phase 6, sequenced *after* Phase 5's P5-06 ("security scope review... ADR records concrete security gains") is supposed to close the phase out.

Left unaddressed, P5-06's ADR would describe a kernel that, by the project's own definition, delivered zero exclusive enforcement — an honesty gap this project's prior ADRs (ADR-001, ADR-002) have both been careful to avoid.

Separately, ADR-002's Consequences section states that "the 43 guard-catalog fixtures and `guard.ts` itself remain Phase 5's opening task (P5-01)... and its own subsequent port work." This is wrong on inspection: P5-01's actual text is "convert threat model into executable security tests," names Docker socket / privileged execution / forbidden mounts / path traversal / cross-session access / secret exposure as its scope, and never mentions `guard` at all. No P5-0x task ports guard decision logic. This ADR corrects that record and resolves the underlying question ADR-002 gestured at but didn't actually answer: which guard-catalog fixtures, if any, are Go parity targets.

## Decision 1: Phase 5 delivers validation-in-Go; enforcement lands at P6-02, named explicitly

**Chosen: option (b) from the review — accept Phase 5 as validation-only, state it plainly, and name P6-02 as where LAW-07's bar is actually met.**

Rejected: pulling P6-02's boundary design forward into or ahead of Phase 5 (the review's option (a)). Reasons:

1. **The master plan's own sequencing has a reason.** P6-02's prerequisite is P6-01 (a 20-scenario customization regression catalogue), because a minimal TS↔Go API can't be scoped correctly without first knowing exactly what the flexible layer needs to keep doing through it. Designing the boundary before that catalogue exists risks either overfitting to Phase 5's Docker-facing concerns alone (narrower than the API actually needs to be) or under-scoping the "do not expose security bypass knobs" requirement (broader surface than a rushed design would catch). Reordering the plan to satisfy Phase 5's enforcement urge would repeat exactly the mistake LAW-05 exists to prevent — architecture growing ahead of justified need.
2. **A partial, un-catalogued boundary is its own risk.** Building *some* enforcement mechanism inside Phase 5 without P6-01's customization catalogue behind it risks producing an API that Phase 6 then has to redesign anyway once the catalogue exists — churn, not progress.
3. **Validation-first is still real, valuable work**, not a placeholder: `guard.ts`'s decision layer (per `threat-model.md`) is already "close to complete and well-designed"; Phase 5's job is proving the analogous invariants for the Docker-facing surface — mount safety, container defaults, session ownership, credential isolation — as centrally-implemented, testable Go logic. That is a necessary precondition for P6-02's boundary to have something correct to enforce.

**What changes as a result of this decision:**

- P5-06's ADR (the one that task's own done-when requires) must describe Phase 5's output accurately: *"the invariants are now testable and centrally implemented in Go; they are not yet non-bypassable — TypeScript can still call `driver.prepare()`/the equivalent Docker-facing functions directly and skip Go's validation, exactly as it can today. Exclusive enforcement is P6-02's job."* This ADR pre-commits to that framing so it isn't discovered as a surprise, or worse, glossed over, when P5-06 is actually written.
- P6-02, when it comes, should explicitly reference this ADR and Phase 5's validation package(s) as the concrete invariants its API must make non-bypassable — not design the boundary from scratch against `threat-model.md` alone.
- The master plan's task text itself is **not edited** by this ADR — task numbering, estimates, and prerequisites in `master-plan-reference.md` stay as they are. This ADR is a governance record clarifying what "done" means for P5-06 and what P6-02 must accomplish, not a workbook restructuring. If the user wants the workbook itself amended (e.g., splitting P6-02's boundary design into an earlier task), that is a separate, explicit decision for them to make — this ADR does not make it unilaterally.

## Decision 2: Guard-catalog fixture scope — corrects ADR-002

**LAW-07's own annotation already answers this, precisely, and ADR-002 should have pointed to it rather than inventing "P5-01 ports guard.ts":**

> "only the guard logic that actually gates those three functions needs to move into the kernel alongside the execution authority — concretely, self-mod's `install_packages`/`add_mcp_server` checks and the CLI-derived guard for the `restart` command... The rest of the guarded-action catalog (`a2a.send`, `agents.create`, `senders.admit`, `channels.register`, and every other `ncl` command that never touches Docker) gates nothing the kernel controls, and moving it would violate LAW-01/LAW-02 for no security benefit."

Applied to the 43 excluded guard-catalog fixtures (`src/differential/fixtures-guard-catalog.test.ts`, per ADR-002 Decision 1): **only the fixtures covering `self_mod.install_packages`, `self_mod.add_mcp_server`, and the CLI-derived `restart` guard are eventual Go-parity targets — a small, specific subset, not all 43.** The remaining fixtures (`a2a.send`, `agents.create`, `senders.admit`, `channels.register`, and every other `ncl`-command-derived case that never reaches a Docker-facing function) are **permanently TS-only**, for the same reason LAW-07's annotation gives: they gate actions the Go kernel will never control, so porting them would be scope creep with no enforcement benefit, not a deferred task.

**No currently-numbered task actually ports this narrow guard subset.** Neither P5-01 through P5-06 nor P6-01 through P6-05 names it. This is a genuine gap in the master plan — the fix belongs in the master plan itself (a new or reassigned task), which is the user's call, not something this ADR should decide unilaterally by inventing a task number. **Recorded here as an explicit open item** (see Consequences) so it doesn't quietly fall through Phase 5/6's boundary the way it just did once already.

**ADR-002 correction**: its Consequences section's claim that "the 43 guard-catalog fixtures and `guard.ts` itself remain Phase 5's opening task" is superseded by this ADR. ADR-002's own core scope decision (excluding all 43 from P4-06) remains correct and unchanged; only its forward-looking claim about *where* they get picked up was wrong.

## Options considered

**Leave ADR-002's incorrect reference uncorrected and let P5-01 "discover" it isn't actually about guard.ts.** Rejected — an incorrect cross-reference sitting in a committed ADR is exactly the kind of drift this project's documents exist to prevent; better to fix it now, cheaply, than have a future task read ADR-002 at face value.

**Treat Phase 5 and Phase 6 as already fine, and skip this ADR entirely.** Rejected — the honesty gap in what P5-06's ADR would otherwise claim is real, not manufactured; writing this ADR now costs a couple of hours and prevents a materially misleading close-out later.

## Decision

Phase 5 proceeds as currently scoped and sequenced in the master plan (no task numbers or estimates change). Its output is understood, and will be described at P5-06, as centrally-implemented, testable security invariants in Go — not yet exclusive enforcement. P6-02 is the task that closes the loop to LAW-07's actual bar, and should reference this ADR when it does. The guard-catalog fixture scope is corrected: only the self-mod install/add-mcp-server and CLI-restart-guard subset are eventual Go-parity targets; the rest are permanently TS-only. The absence of a task that actually ports that narrow subset is flagged as an open planning question for the user, not resolved here.

## Consequences

- `docs/parity-report-p4-06.md` and `ADR-002`'s own text are not edited retroactively (both remain accurate records of what P4-06 actually decided); this ADR is the durable correction going forward, cross-referenced from both.
- P5-06, when written, must use the "validation, not yet enforcement" framing above rather than overclaiming.
- **Open item for the user to decide, not resolved by this ADR**: where does the narrow guard-subset port (self-mod install/add-mcp-server + CLI restart guard) actually land in the master plan? Candidates: a new task inserted before or alongside P6-02 (since it's part of the same enforcement boundary), or folded into P6-02's own scope explicitly. Recommend deciding this before P6-01 starts, not before P5-01 — it does not block Phase 5.
- Phase 5's four other blocking prep items from the same review (threat-model addendum, `src/drivers/` classification, mount-validation fixture capture) are handled as separate deliverables alongside this ADR, not folded into it.

## References

- `design-laws.md` — LAW-07/OBJ-04 annotation (the "exclusive enforcement" reading and its exact scoping paragraph), LAW-01, LAW-02, LAW-05.
- `threat-model.md` — "Direct answer: what would have to move behind Go to prevent bypass?" section, which independently arrives at the same narrow scope.
- `master-plan-reference.md` — P5-01 through P5-06, P6-01, P6-02 exact task text.
- `ADR-002-differential-parity-scope.md` — the claim corrected by Decision 2 above; its own Decision 1/2/3 scope reasoning remains valid and unchanged.
- The Opus readiness review (project doc: `nanoclaw-go-host-phase5-readiness-review.md`) — the source of both findings this ADR resolves.

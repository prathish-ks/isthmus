# Upstream Promotion Playbook

Status: living document, established 2026-09-25, first applied to the
v2.3.0 → v2.4.0 promotion (`docs/promotion-v2.4.0.md`). Version-agnostic —
this document describes *how* to promote the pinned `nanocoai/nanoclaw`
baseline to a new release; the per-release specifics (findings, file lists,
status tables) belong in a dated `docs/promotion-vX.Y.Z.md` instance, not
here. Companion to `version-compatibility.md` (the standing
consumed-contracts table this playbook exercises every time) and
`compatibility-matrix.md` (re-issued as part of Step 9).

Exists because LAW-09 ("upstream moves independently... pin stable releases
for development and use a separate upstream watch track") states the
*policy* but not the *procedure* — this document is the procedure, so the
next promotion doesn't have to re-derive it from a long investigation the
way the v2.4.0 one did. See `docs/design-laws.md`'s LAW-09 annotation for
why this lives as an annotation + playbook rather than a new numbered law.

This is an **eleven-step process, Steps 0–10** (not "ten steps" — Step 0's
scoping pass is a distinct step from Steps 1–9's actual workstream-mapped
work and Step 10's retrospective, and all eleven are numbered below;
counting only 1–10 and forgetting Step 0, or treating "ten-step" as the
step count, is exactly the kind of off-by-one that let a promotion be
declared complete with its final retrospective skipped once already — a
Copilot PR review caught this document itself making that mistake in its
own first draft).

## Terminology, used precisely throughout

- **RUNNING** — a CI job executed and produced output. On its own,
  insufficient evidence that anything it was meant to verify actually
  held.
- **PASSED** — the job executed and its own success condition was met.
- **REQUIRED** — the job is in the `ci` gate's `needs:` list in
  `.github/workflows/ci.yml`, so a failure blocks merge. A report-only job
  (`continue-on-error: true`, outside that `needs:` list) can run and pass
  every time without ever blocking anything — that is a deliberate,
  legitimate posture for some existing jobs (shared-runner Docker
  flakiness, for instance), but it must never be mistaken for "this gate
  is enforced." Wherever a step below says a check "passes" or is
  "required," it means PASSED + REQUIRED, or an explicit, named,
  dated, expiring exception recorded in the promotion instance document —
  never RUNNING alone.
- **"Green" (full test suite)** — zero failures, not zero *new* failures
  relative to the outgoing pin. A pre-existing failure discovered during a
  promotion gets fixed or explicitly tracked with an owner and a reason,
  not silently absorbed under "that predates this promotion."
- **Acceptance record** — the durable write-up required before any
  privileged decision is allowed to stay TypeScript-only rather than
  kernel-enforced (see Step 3). Not a one-line note.

## When to run this

Triggered by `.github/workflows/ci.yml`'s `upstream-watch` job reporting a
new `nanocoai/nanoclaw` release tag ahead of `docs/upstream-pin.json`, or a
manual signal (Discord announcement, direct request). Do not wait
indefinitely once triggered — `upstream-watch` runs daily specifically so
the gap between "release exists" and "this playbook starts" stays small,
but running the playbook itself can and should take as long as the findings
demand. There is no deadline pressure baked into this process; rushing
Step 1–3 below is exactly what produces the kind of surprise this playbook
exists to prevent.

## Step 0 — Scope the release before reading a single diff

Answer these with real data (`git log`/`git rev-list`/the GitHub API), not
impressions, before doing anything else:

1. How many commits and unique PRs sit between the current pin and the new
   tag? (`git rev-list --count <pin>..<tag>`, plus a PR-number extraction
   from commit subjects for a rough count — squash-merges don't leave a
   `Merge pull request #` commit, so grep for `#[0-9]+` in subjects too.)
2. Is the change transparent/incremental, or did a cluster of PRs land in a
   short window right before the tag? Check commits-per-day across the
   whole range, then specifically look at what merged on the tag's own day.
   **Lesson from the v2.4.0 promotion**: a coordinated 4-PR architectural
   change (opened together, held ~8 days, merged together in a 45-minute
   window hours before the tag) was easy to miss by only skimming commit
   messages — it only became visible by checking PR `created_at`/`merged_at`
   timestamps via the GitHub API, not just commit dates. Do this check every
   time; do not assume the previous release's pattern (clean, no batch)
   generalizes to this one.
3. Compare the previous release's own tag-day commit volume as a baseline,
   so "is this release's batch unusual" is a real comparison, not a guess.
4. **Record the exact tag commit SHA now.** Step 8's re-validation compares
   against this recorded value, not against memory — an upstream tag can
   move (a point release, a force-push, a correction) between when this
   playbook starts and when the pin actually moves.

This step's output is not a design decision — it's just making sure Steps
1–3 below are scoped against reality (how big is this, really) before
spending effort on them.

## Step 1 — Consumed-contracts check

Walk `version-compatibility.md` §1's table row by row against the new
tag's diff. For each row: did the specific file/function that row names
change at all in the range? If yes, read the actual diff (not just the
commit message) and classify:

- **Clean** — file untouched, or changed in a way that doesn't touch the
  field/behavior this kernel's Go code actually reads (per §2's own rule:
  "a field upstream adds that this kernel's rules never consult is not a
  compatibility break").
- **Break** — the meaning, shape, or required-ness of something the Go
  kernel's rules DO consult changed.

Record every row's outcome, including the clean ones — a clean review is a
normal, expected, worth-recording outcome (this is §3 of
`version-compatibility.md`'s own existing policy; this playbook doesn't
change that, just operationalizes it with the workstream structure below).

## Step 2 — Full-diff inventory and classification into three buckets

**Produce a durable, machine-readable inventory before classifying** — not
a prose diffstat claim ("200 files changed under `src/`"). One row per
changed path (CSV, JSON, or a table in a dedicated
`docs/promotion-vX.Y.Z-file-inventory.md`), covering at minimum: `path`,
`status` (added/modified/deleted/renamed, with source/destination for
renames), `bucket` (A/B/C, below), `consumed_contract_row` (if applicable,
linking to Step 1's table), `security_review_status` (for Bucket B),
`test_evidence`, `reconciliation_decision` (for Bucket C),
`reviewer`/`ADR reference`. The promotion gate requires this inventory to
exist with zero unclassified rows before the pin moves — a prose sweep is
not sufficient evidence on its own that the sweep was actually complete.

Do not scope the sweep to `src/` alone. **Lesson from the v2.4.0
promotion**: the credential-provider restructuring (OneCLI moving from a
trunk file to a skill payload under `.claude/skills/`) was invisible to a
`src/`-only diff scan and only surfaced by checking `git ls-tree` against
the actual tag — and that same miss is exactly why a machine-readable
inventory, not a prose claim, is now required: a sentence saying "the
sweep was complete" would not have caught it either. Sweep the whole repo
diff (`container/agent-runner/src/`, `setup/`, `.claude/skills/`, not just
`src/`) before classifying.

For every changed path, assign one of:

- **Bucket A — Seam call-sites.** Files that construct what gets sent to
  the Go kernel, or call kernel-facing functions: `container-runner.ts`,
  `drivers/*`, `kernel/*`, `cli/dispatch.ts`/`guard.ts`/`registry.ts`,
  `modules/self-mod/*`, `modules/agent-to-agent/*`,
  `modules/kernel-supervisor/*`, anything calling `wakeContainer`/
  `killContainer`/`buildAgentGroupImage`. Assess two things separately for
  each: did the *data shape* change (feeds Step 1's table), and did the
  *call sequencing/error handling* change (a file can pass Step 1 clean and
  still need a seam-level fix if, say, retry behavior or call ordering
  shifted).
- **Bucket B — Bypass-risk / new privileged surfaces.** Any new code
  touching credentials, spawning processes, or making a privileged
  decision that ISN'T one of Bucket A's already-tracked kernel call sites.
  **Lesson from the v2.4.0 promotion**: this bucket turned out much larger
  than expected — a 21-file gateway-provider subsystem with real admission
  decisions (`ensureGatewaySession`, a host-allowlist check) living
  entirely in TypeScript, discovered only by grepping for
  `gateway|onecli|iron|secret|credential|vault` across the full changed-file
  list, not by reading Bucket A's files closely. Run that kind of broad
  keyword sweep every time, not just a scan of files you already expect to
  matter.
- **Bucket C — Pure TypeScript.** Everything else. Default assumption is
  "safe to reconcile normally" (Step 5) — but re-derive this bucket
  *after* A and B are finalized, since files can get reclassified once a
  closer read shows they belong elsewhere.

## Step 3 — Trace Bucket B to a real answer, not a diff scan

For each Bucket B finding, answer explicitly: is the privileged effect this
code enables *physically* reachable only through the Go kernel (LAW-07's
"exclusive enforcement" reading — see its annotation in `design-laws.md`),
or does this new code create — or extend — a path where a TypeScript-side
decision is the only gate? Neither answer is automatically wrong: Isthmus
already has some accepted TS-only decisions (`admissionEnforced: false`,
documented in `docker-driver.ts`'s own `capabilities()`).

Every accepted bypass or TS-only decision requires a full **acceptance
record**, in `compatibility-security-report.md` or equivalent — never a
bare "accepted and documented" note. An acceptance record contains, at
minimum:

- The exact privileged operation covered.
- Every reachable call path to that operation, not just the first one
  traced.
- Why Go-kernel enforcement is not currently feasible for this case.
- The threat model and a concrete abuse case.
- Any compensating control already in place.
- A severity rating and residual-risk statement.
- A **named approver**, not "the team."
- A **date of approval** and an **expiry/review date** — an acceptance
  record with no expiry is a permanent exception by default, and this
  playbook does not allow that; every record gets re-reviewed at or before
  its expiry.
- Whether the decision blocks `compatibility-matrix.md`'s "Stable" rating
  for the affected row.
- A regression test proving the accepted boundary stays exactly where it
  was accepted, rather than silently widening later.

Use the `code-review` skill with a trust-boundary-specific angle for this
step, not general bug-hunting.

## Step 4 — Kernel port work, if Bucket A/B implicates new Go behavior

Standard engineering discipline applies here (LAW-06: contracts before
rewrites). Three things worth stating explicitly because the v2.4.0
promotion needed them and a future promotion might assume otherwise:

- **There may be no upstream Go code to port from**, because upstream has
  no Go kernel — Isthmus's kernel is this project's own addition. A new
  capability in upstream's TypeScript driver (e.g. a new Docker invocation
  pattern) may require *original* Go design work, not translation.
- **If the wire payload shape changes, produce a mixed-version
  compatibility matrix before deciding whether `ProtocolVersion`
  (`internal/kernel/protocol.go`) needs to bump** — not just a yes/no
  call. At minimum: old-TS-host×old-kernel, new×new, old×new, and
  new×old, each marked supported or explicitly rejected. Also answer:
  can the two sides roll back independently, does the kernel tolerate
  unknown/extra fields, is the new field optional during a rollout
  window, does this specific change (often a payload extension) actually
  require a version bump versus only a semantic change would
  (`version-compatibility.md` §2), and how does a mismatch surface to an
  operator. A version-axis decision this consequential does not get made
  by default in either direction.
- Test with real live-Docker coverage proving the new behavior actually
  works — real container membership and isolation, not just that the
  generated request/argv looks right (this project's own repeated lesson
  about mocked vs. real coverage — see the wiring-boundary-registry work,
  ADR-022 — applies here too). This coverage must be PASSED + REQUIRED per
  the terminology above, not a report-only run; a report-only live-Docker
  job having executed does not mean the promotion would have been blocked
  if the new network-isolation or multi-container behavior actually
  failed.

## Step 5 — Pure-TS reconciliation (Bucket C)

Before hand-porting file by file, check whether `migrate-nanoclaw`'s
methodology (extract intent, reapply on a clean worktree checkout, never a
literal `git merge`) is directly usable, adaptable, or whether Isthmus's
depth of fork (an entire additional trust-kernel layer, well beyond that
skill's stated "config values, a few edited files" use case) needs a
bespoke process. Decide this fresh each promotion — Isthmus's divergence
from upstream may itself grow or shrink over time as architecture evolves.
Record every reconciliation decision (port verbatim / port with
modification / decline and why) in Step 2's inventory, not separately.

## Step 6 — Testing, docs, CI uplift (required, not optional)

- Full suite green (per "Green," above) on **real CI**, not local-only
  (this project's established "real CI evidence over local" principle —
  local sandboxes have repeatedly diverged from the actual GitHub Actions
  runner in ways that mattered, e.g. container UID/permission behavior).
  Apply the same zero-failures, named-exception-only standard to lint and
  audit findings as to tests.
- Update `version-compatibility.md` §1, `compatibility-matrix.md`'s
  ratings (any row covered by an open acceptance record from Step 3 stays
  below Stable unless that record explicitly says otherwise),
  `docs/traceability.md`, and any CLAUDE.md sections whose documented
  architecture changed.
- **Every new privileged surface Steps 1–4 found must get equivalent CI
  coverage, PASSED + REQUIRED, before the pin moves** — not "assess
  whether a gate is warranted," but "identify the gap and close it,"
  mirroring how `wiring-registry-check` became a required gate when the
  wiring/recurrence-prevention surface grew, not a report-only job someone
  could ignore. This is about the surface the **pin itself** brings into
  Isthmus's own core — it is separate from, and does not depend on,
  whether any optional adjacent skill (e.g. a specific gateway-provider
  skill a given release happens to introduce) also gets adopted. Adopting
  an optional skill is a separate decision each promotion can make
  independently; closing the CI gap for whatever the pin itself adds to
  the trust boundary is not optional.

## Step 7 — Migration continuity

Confirm the nanoclaw → Isthmus onboarding path (find it fresh each time —
don't assume it's the same skill/mechanism as last time, since Isthmus's
own skill set evolves too). Then run it as a **concrete, executable
acceptance test**, once per source version (both the outgoing pin and the
newly-pinned version — a user is allowed to land on Isthmus's current
baseline from either), not an open-ended "verify it handles X" statement.
Each run must check all of: existing user data and configuration
preserved; credentials never land in a location the kernel wouldn't admit
as a valid mount; groups, sessions, mounts, and central DB state remain
valid afterward; the resulting install runs the newly-pinned baseline; a
deliberately-induced mid-migration failure leaves a recoverable (not
corrupt) state; rollback behavior is documented; the whole procedure runs
from a fresh checkout with no reliance on undocumented local state. Both
source-version runs must land on the same resulting state — neither source
version is allowed to produce a different outcome than the other.

## Step 8 — Re-validate immediately before promoting

Re-run Step 2's inventory and classification against the actual release
tag one more time right before flipping the pin — not the version from
when the playbook run started. Upstream can move (a point release, a
force-push to a branch, a correction) in the time this whole process
takes. Explicitly confirm the tag still resolves to the exact commit SHA
recorded in Step 0 and has not moved; record the final verified SHA in the
promotion instance document at promotion time. If the tag *has* moved,
treat that as new input to Step 0, not something to reconcile in passing.

## Step 9 — Promote

Update `docs/upstream-pin.json` and `docs/baseline.md`'s "Stable Baseline"
section **together**, in the same commit as the closing ADR(s) — LAW-09's
existing discipline, unchanged by this playbook. Never let the pin move
without a paired ADR.

**This is a separate, final PR, not folded into the implementation work.**
It contains only the pin/baseline files, the closing ADR(s), and links to
the evidence satisfying every promotion-gate line — no application code.
This keeps "is the pin move itself correct and fully gated" independently
reviewable, rather than buried inside a large mixed diff. The
implementation work across Steps 1–7 can span however many PRs it
naturally needs; only this final step is constrained to its own PR.

## Step 10 — Retrospective: does this change the constitution?

Check the executed promotion against `docs/design-laws.md`'s own stated
bar for a new law: *"must not be restating something LAW-01 through LAW-09
already cover."* Default expectation, given LAW-09 already exists
specifically for this: a dated annotation under LAW-09 (matching the
existing LAW-07 annotation's style) recording what this specific promotion
confirmed or sharpened — not a new law number. Only propose a new law if
this promotion surfaced a genuinely distinct principle, held to the same
evidence bar the declined 2026-08-30 LAW-10 proposal was held to.

## Per-promotion instance template

Each promotion gets its own `docs/promotion-vX.Y.Z.md`, structured as:
goal/non-goals, a PR-boundaries note (Step 9), a "why this promotion is not
routine" findings section (Step 0's output plus Step 1/2's headline
findings — clearly marked as a summary, with the actual gating evidence
living in Step 2's file-inventory artifact, not duplicated as prose), the
"Green"/RUNNING-PASSED-REQUIRED terminology section (or a reference to this
playbook's copy of it), one status-tracked table per workstream mirroring
Steps 1–7 above (including Step 3's acceptance-record fields and Step 4's
compatibility matrix where relevant), a promotion gate checklist mirroring
Steps 8–9 (including the tag-immutability re-check), and a changelog.
`docs/promotion-v2.4.0.md` is the first such instance — read it as a
worked example, not as this playbook's canonical content (the playbook
stays version-agnostic; that document carries v2.4.0's actual findings and
will be superseded by the next promotion's own instance).

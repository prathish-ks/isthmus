---
name: promote-upstream
description: Guides the human+Claude process of promoting a new nanocoai/nanoclaw release tag into Isthmus, following go-host/docs/upstream-promotion-playbook.md's 11 steps end to end. Also runs a lightweight daily-watch mode that tracks upstream PRs as they land, so Step 0 never starts cold. Human-in-the-loop at every judgment call — this skill gets a promotion ready for its final pin-move PR, it never merges, pushes, or tags anything itself.
---

# Context

This skill is the orchestration layer over `go-host/docs/upstream-promotion-playbook.md` — that document is the authoritative source for *what each step requires and why*; this skill is *how a session actually walks through it*, with checkpoints, state, and delegation. Read the playbook itself (not a summary of it) at the start of any real promotion — it is a living document and may have changed since this skill was last updated.

Two modes:

- **Watch** (`/promote-upstream watch`, or just "check upstream") — cheap, read-only, safe to run daily. Tracks upstream `main` incrementally so a real promotion's Step 0 has a running picture instead of a cold start.
- **Promote** (`/promote-upstream <tag>`, or "promote v2.5.0") — the real thing. Walks Steps 0–10 of the playbook for a specific, already-released tag.

This skill is Isthmus-specific and stays on `main` — it is not something upstream NanoClaw ships or would ever need, since the whole premise is Isthmus's own fork relationship to it.

# Principles

- **Never decide a judgment call silently.** Steps 1, 3, 4, 5, 7, and 10 of the playbook are explicitly judgment, not mechanics — Bucket A/B/C classification, accept/decline calls, acceptance records, reconciliation decisions. Present the finding, the playbook's own criteria, and a recommendation; use `AskUserQuestion` at the actual decision fork; never auto-classify and move on.
- **Delegate the mechanical parts.** Step 0's data-gathering (commit/PR counts, batch-window detection) and Step 2's diff walk are exactly the kind of exploration `migrate-nanoclaw` delegates to sub-agents — do the same here, to keep the main session free for the judgment conversation. A sub-agent reports findings; it does not make bucket or accept/decline calls.
- **Persist state — a real promotion spans days to weeks.** The playbook itself says so explicitly ("no deadline pressure baked into this process"). State lives in the dated `docs/promotion-vX.Y.Z.md` instance document the playbook already specifies, not in this skill's own memory. A later invocation reads that file to find out where things left off.
- **Scale effort to what Step 0 actually finds.** A quiet, incremental release with no batch clusters and nothing in Bucket B doesn't need the same depth of Step 3 scrutiny as one that does. Decide this from Step 0's real data, not by default.
- **Absolute paths in worktrees**, same reason as `migrate-nanoclaw`: the Bash tool resets cwd between calls. Store the worktree's absolute path once, use it throughout.
- **Never push, merge, or tag.** This skill's job ends when Step 9's pin-move PR is open and ready for review. Creating that PR follows this project's standing PR-hygiene discipline (show the diff, wait for explicit approval) — and even then, only the human pushes/merges, matching every promotion this session actually ran.
- **A promotion closing is not a release being ready to cut.** Once Step 9's PR merges, this skill's job is done. Cutting `isthmus-vX.Y.Z` is a separate process against `docs/release-gate-checklist.md` — don't imply one is ready for the other.

---

# Mode: Watch

Purpose: keep a running, incremental picture of what's landing on upstream's `main`, so a real promotion's Step 0 (which the playbook's own "Lesson from the v2.4.0 promotion" callout says is easy to get wrong by skimming) starts from accumulated data instead of cold.

State file: `docs/upstream-watch-log.md` — append-only, newest entry at the top. Each entry: date, upstream SHA range covered, commit/PR count, anything flagged.

## Steps

1. Ensure the `upstream` remote exists (`https://github.com/nanocoai/nanoclaw.git`); `git fetch upstream --prune`.
2. Read `docs/upstream-watch-log.md`'s most recent entry for the last-covered SHA. A bootstrap entry already seeds this at `docs/upstream-pin.json`'s `last_reviewed_upstream_main_commit` — the last point on upstream's `main` this project actually looked at while closing the current pin, one commit past the pinned tag itself. Use that field specifically, not the tag commit alone — upstream's `main` moves past its own tag immediately.
3. **Check for a new tag first.** Compare upstream's latest release tag against `docs/upstream-pin.json`. If a new stable tag exists, say so plainly and offer to switch straight to **Mode: Promote** — don't keep watching past a tag that's already there to promote.
4. If no new tag yet, assess what's accumulated since the last watch entry (delegate to a sub-agent if the range is more than a handful of commits):
   - `git rev-list --count <last_sha>..upstream/main`, plus a PR-number extraction from commit subjects.
   - PR-level batch detection, same method the playbook's Step 0 had to learn the hard way: pull `created_at`/`merged_at` for PRs in range via `gh pr list --repo nanocoai/nanoclaw --state merged --json number,title,createdAt,mergedAt` (or the equivalent GitHub REST calls if `gh` isn't available) — commit dates alone miss a coordinated batch held open and merged together.
   - A cheap keyword sweep across changed paths for `gateway|onecli|iron|secret|credential|vault|kernel|driver` — the same sweep that caught the 21-file gateway-provider subsystem in Bucket B last time. This is a *flag*, not a classification — real Bucket A/B/C sorting is Step 2's job, during an actual promotion.
5. Append one dated entry to `docs/upstream-watch-log.md`: range covered, commit/PR count, whether this range looks like a normal trickle or a batch worth flagging, and what the keyword sweep hit (if anything). Keep it short — this is a breadcrumb trail for Step 0, not the promotion instance document itself.
6. Report a one-paragraph summary to the user. Don't create a PR, don't change anything outside that one log file.

If the user wants this to run on a real schedule rather than being invoked ad hoc, pair it with the `schedule` skill — this skill doesn't need to know about cron itself.

---

# Mode: Promote

Triggered by: Watch mode noticing a new tag, the `upstream-watch` CI job's weekly signal, or the user asking directly.

## Step 0 — Scope (playbook Step 0)

Pull `docs/upstream-watch-log.md`'s accumulated entries covering the range between the current pin and the new tag first — this is most of Step 0's data-gathering already done incrementally, not starting cold. Fill any gap between the watch log's last entry and the tag itself the same way.

Confirm with the user: does the accumulated picture (batch clusters flagged, keyword-sweep hits) match what Step 0 finds on a fresh, authoritative check against the actual tag? The watch log is a head start, not a substitute for Step 0's own real output — run it for real, reconciled against the log, not copied from it.

**Record the tag's exact commit SHA now**, per the playbook. Create `docs/promotion-vX.Y.Z.md` from the playbook's "Per-promotion instance template" section if one doesn't already exist for this version; if one does, that's a resume — read its current state before doing anything else.

## Steps 1–7 — walk the playbook directly

Follow `go-host/docs/upstream-promotion-playbook.md` Steps 1 through 7 in order, writing findings into the instance document as you go (not just this conversation — the document is what survives a context reset or a session days later). For each step:

- **Step 1** (consumed-contracts) and **Step 2** (full-diff inventory): delegate the mechanical walk — producing the CSV at `docs/promotion-vX.Y.Z-file-inventory.csv` with the exact header the playbook specifies — to a sub-agent or several in parallel by directory. Bring the *classification* (Bucket A/B/C, clean/break) back for human review; don't let a sub-agent finalize a bucket call unreviewed, especially Bucket B.
- **Step 3** (trace Bucket B): this is the playbook's own explicit "use the `code-review` skill with a trust-boundary-specific angle" step. Every accepted bypass needs the full acceptance record the playbook lists (operation, every reachable path, why kernel enforcement isn't feasible, threat model, compensating controls, severity, a *named* approver, a dated expiry, a regression test) — `AskUserQuestion` the named approver and the expiry date explicitly; don't infer them.
- **Step 4** (kernel port work): if Bucket A/B implicates new Go behavior. Flag explicitly if this looks like original design work rather than translation (the playbook names this as a real possibility, not just translation from upstream Go — Isthmus's kernel is this project's own addition).
- **Step 5** (Bucket C reconciliation): for each file, land on one of the four `reconciliation_decision` values — including `declined-independently-fixed:<reason>` when upstream's own mechanism is wrong for Isthmus but the underlying bug is real (the poll-loop.ts precedent). This is a judgment call per file; don't batch-apply one decision to a whole directory without checking each file actually fits it.
- **Step 6** (testing/docs/CI): full suite green on real CI, not local-only — this project's own standing "real CI evidence over local" rule. Any new privileged surface needs CI coverage *and* registration in the wiring-and-boundary registry (ADR-028) — both, not just the test.
- **Step 7** (migration continuity): a concrete, executable acceptance test per source version, with a recorded rollback artifact (real command log or a walked-through checklist) — not a rollback claim with nothing behind it.

The implementation work across Steps 1–7 can span however many PRs it naturally needs — follow this project's own precedent (the v2.4.0 promotion split kernel-capability work and TS-seam-reconciliation work into two separate PRs). Show each PR's diff and wait for approval before creating it, same as every PR this session created.

## Step 8 — Re-validate (playbook Step 8)

Immediately before the final pin-move PR: re-run Step 2's classification against the tag's actual current state, and re-confirm the tag's commit SHA still matches what Step 0 recorded. If it's moved, that's new Step 0 input, not something to quietly reconcile.

## Step 9 — Promote (playbook Step 9)

Prepare the final, isolated PR: `docs/upstream-pin.json` + `docs/baseline.md`'s Stable Baseline section + the closing ADR(s), plus the one-page evidence index (the instance document's own gate checklist, each line now linking to its real evidence). Nothing else goes in this PR.

**This is where this skill's job ends.** Show the diff, wait for explicit approval, then create the PR exactly as the user directs — never push or merge it automatically. If named, non-blocking follow-ups remain open (the playbook now explicitly allows this, per the gateway-lease-continuity/poll-loop.ts precedent), make sure each has an owner and is named plainly in the closing ADR, not implied away.

## Step 10 — Retrospective (playbook Step 10)

Check the promotion against `docs/design-laws.md`'s bar for a new law. Default expectation is a dated annotation under LAW-09, not a new law number. If this promotion surfaced something this skill itself should learn from — a playbook gap, a wrong assumption, a step that needed reordering — say so explicitly and offer to update `go-host/docs/upstream-promotion-playbook.md` and this skill file in a follow-up, the same way this skill itself was written from the v2.4.0 promotion's own lessons. Don't let that kind of learning evaporate at the end of a session.

---

# Resuming a promotion already in progress

Check for an existing `docs/promotion-vX.Y.Z.md` matching the target version before starting Step 0 fresh. If one exists, read it in full — its per-workstream status tables say which steps are done, which are in progress, and which haven't started. Resume from there; don't re-ask questions the document already answers, and don't silently re-decide something it already recorded.

# What this skill never does

- Never merges, pushes to a protected branch, or creates a tag.
- Never finalizes a Bucket A/B/C classification, an accept/decline call, or an acceptance record without an explicit human checkpoint.
- Never treats a promotion's Step 6 testing as sufficient evidence that an Isthmus release is ready to cut — that's `docs/release-gate-checklist.md`'s separate job.
- Never lets a named, deferred follow-up go untracked — every one gets an owner and a path back to a closing ADR addendum.

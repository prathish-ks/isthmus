# Upstream Watch Log

Incremental, read-only tracking of what's landing on `nanocoai/nanoclaw`'s
`main` between promotions — maintained by the `promote-upstream` skill's
Watch mode (`.claude/skills/promote-upstream/SKILL.md`). Newest entry at
the top. This is a breadcrumb trail for a future promotion's Step 0, not
the formal per-promotion instance document (`docs/promotion-vX.Y.Z.md`)
and not a substitute for Step 0's own real, authoritative check when a
promotion actually starts.

Nothing in this file implies anything has been reviewed, accepted, or is
safe to port — it only records that it was *seen*, and whether anything
looked batch-like or security-relevant enough to flag for a closer look
once the next tag lands.

---

## 2026-10-11 — v2026.10.0 promotion closed; new starting point recorded

**Range covered**: the bootstrap entry's starting point
(`b200712e53e514515fd68a153e58ab287971aeab`, one commit past the `v2.4.0`
tag) forward to `upstream/main`'s HEAD at the time of this check,
`a0c79dd8f79cc67a54b0c751097c40c4caa96cde` — gathered as part of Step 8's
re-validation for the `v2026.10.0` pin-move (`docs/promotion-v2026.10.0.md`,
`go-host/docs/ADR-036-v2026.10.0-pin-promotion-closure.md`), not a
standalone Watch-mode run.

**The `v2026.10.0` tag itself** (`7203e00dc271cc2ea9ea84bb130731b8ca00319e`)
sits inside this range and is now the pinned baseline — see
`docs/upstream-pin.json`. Everything up to and including that tag commit
was the v2.4.0→v2026.10.0 promotion's own full scope (91 commits, 83 PRs,
detailed in `docs/promotion-v2026.10.0.md`), not this log's concern.

**Past the tag, not yet reviewed** (the real starting point for the
*next* promotion's Step 0 — one PR more than the bootstrap entry's own
single-trivial-commit note anticipated, so that note is now superseded,
not retroactively edited):
- `#4066` — `build(deps): bump source-map-js from 1.2.1 to 1.2.2` — a
  dependency bump, already known at this promotion's Step 0/Step 8.
- `#4069` — `chore(container): bump Claude Code to 2.1.296, the Agent SDK
  to 0.3.296 and Codex to 0.162.1` (merge commit `a0c79dd8`, 2 real
  commits) — newly landed since the bootstrap entry was written
  (2026-10-06); not reviewed here, per this log's own stated scope (seen,
  not classified).

**Keyword sweep** (`gateway|onecli|iron|secret|credential|vault|kernel|
driver`) on the diff for `#4069`: no hits — a version-pin bump only, no
touched paths matching the sweep.

**No new tag exists yet** beyond `v2026.10.0` as of this check (GitHub
releases API, `nanocoai/nanoclaw`, checked live). `last_reviewed_upstream_
main_commit` in `docs/upstream-pin.json` is updated to `a0c79dd8` in this
same pin-move commit, so the next Watch-mode run (or the next promotion's
Step 0) starts from here, not from the bootstrap entry's now-superseded
`b200712e`.

---

## Bootstrap entry — 2026-10-06

**Range covered**: from `b200712e53e514515fd68a153e58ab287971aeab`
(`docs/upstream-pin.json`'s own `last_reviewed_upstream_main_commit`,
recorded 2026-09-27 as part of closing the v2.4.0 promotion —
`go-host/docs/ADR-035-v2.4.0-pin-promotion-closure.md`) forward. This is
the correct starting point for the watch log, not an arbitrary date: it's
the last commit on upstream's `main` this project has actually looked at,
one commit past the `v2.4.0` tag itself
(`143db6c907c652773a536c7c9e96269fdad0a4a4`).

**Status**: no watch run has executed yet. The first real Watch-mode
invocation should fetch `upstream/main`, diff from the commit above, and
replace this bootstrap entry's "no run yet" note with real findings —
commit/PR count, any batch-window flags, any keyword-sweep hits. Until
then, this entry exists only to make the starting point explicit and
avoid the skill ever guessing where to begin.

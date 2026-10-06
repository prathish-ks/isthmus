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

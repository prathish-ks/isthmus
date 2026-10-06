# Promotion Prep Notes — targeting v2026.10.0 (provisional)

**Status: provisional, pre-tag.** Nothing in this document is accepted,
and nothing here has merged into Isthmus's own `main`. Prepared against
upstream `main` while only `v2026.10.0-rc.1`/`-rc.2` exist — no stable
tag yet. See `.claude/skills/promote-upstream/SKILL.md`'s Mode: Prep for
how this document is meant to be used, and `go-host/docs/
upstream-promotion-playbook.md` for what Steps 1–5 (referenced below)
actually require. When a stable `v2026.10.0` tag lands, this feeds Step
0 of a real promotion — reconciled against the tag's actual state via
Step 8, not copied in verbatim.

Source data: `docs/upstream-watch-log.md`'s 2026-10-06 entry — 70 PRs,
range `b200712e5...`→`d00931ef3` (2026-09-27 through 2026-10-05).

---

## Separate, more urgent finding — not part of the v2026.10.0 batch work

While investigating Batch 1 (below), found that Isthmus's own automated
`channels` sibling-branch mirror (`scripts/sync-sibling-branch.sh`,
`sync-sibling-branches-push` CI job) has been failing silently for **at
least 5 consecutive days** (2026-10-01 through 2026-10-05, all scheduled
runs show `conclusion: failure` at the workflow level, though the
specific sync-push job itself shows `skipped` rather than a hard
failure — couldn't pull the actual job step logs to see why without
admin API access).

**Concrete consequence**: upstream's `channels` branch already carries
PR #4024's fix (`@whiskeysockets/baileys` 7.0.0-rc.9 → rc14, closing
[GHSA-qvv5-jq5g-4cgg](https://github.com/advisories/GHSA-qvv5-jq5g-4cgg),
a real message-spoofing advisory), merged 2026-10-04. Isthmus's own
mirror is still on rc.9 — confirmed via `git show origin/channels:
.claude/skills/add-whatsapp/SKILL.md`. Any Isthmus install that's run
`/add-whatsapp` since this gap opened pins the vulnerable version.

**Verified safe to fix immediately, independent of diagnosing the CI
job**: `git merge-base --is-ancestor origin/channels upstream/channels`
returns true — Isthmus's `channels` branch is a clean ancestor of
upstream's, so a plain fast-forward closes the gap with zero divergence
risk, exactly what the automation is already trusted to do unattended.
This doesn't belong in this prep document's batch work below — it's an
operational gap in existing infrastructure, not a judgment call about
what to port from the 70-PR range. Flagged to the user directly; not
something this document tracks further once resolved.

---

## Batch 1 — the `v2026.10.0-rc.1` cluster (PRs #4024, #4025, #4028)

Chosen first because `docs/upstream-watch-log.md` already flagged this
as a tag-adjacent batch cluster — exactly the shape of thing worth
looking at before the trickle of the other ~63 PRs.

| PR | Title | Bucket | Decision |
|---|---|---|---|
| [#4024](https://github.com/nanocoai/nanoclaw/pull/4024) | fix(add-whatsapp): pin Baileys 7.0.0-rc14 for the message-spoofing fix | C | **See "separate, more urgent finding" above** — this is the fix in question. Once the `channels` mirror is caught up (by fixing the sync job or a manual fast-forward), Isthmus carries this automatically; no `/add-whatsapp`-specific Isthmus action needed beyond that. |
| [#4025](https://github.com/nanocoai/nanoclaw/pull/4025) | chore(release): v2026.10.0-rc.1 | C | `declined:not-applicable` — pure upstream release bookkeeping (`CHANGELOG.md`, `RELEASING.md`, `package.json` version bump to a pre-release identifier). `CHANGELOG.md`/`RELEASING.md` are confirmed upstream's own files, not Isthmus's (see README's own disclaimer); Isthmus's `package.json` version mirrors the *pinned, stable* baseline only, bumped at actual promotion time, never mid-stream to a prerelease identifier. Nothing to port. |
| [#4028](https://github.com/nanocoai/nanoclaw/pull/4028) | docs(add-onecli): check the gateway at ONECLI_URL in the upgrade guide | **unclear — flagged, not forced** | `add-onecli` (upstream's own opt-in OneCLI *install* skill) does not exist in Isthmus's trunk `main` today — only `init-onecli` (Isthmus's own operational skill) and the always-mounted `container/skills/onecli-gateway` do. Isthmus appears to have baked OneCLI support into core differently than upstream's optional-skill model, rather than carrying `add-onecli` itself. Needs a real answer before classifying: does Isthmus have an equivalent skill under a different name/path this doc fix would also apply to, or is this genuinely N/A? Not resolved here — exactly the "don't force an unclear call" case the skill's own Mode: Prep section describes. |

**Batch 1 status**: 1 of 3 resolved cleanly (`#4025`, declined/N/A). `#4024`'s actual fix is upstream's own; Isthmus's side of it is the separate sync-gap finding above, not a port decision. `#4028` open, needs investigation into Isthmus's actual OneCLI-skill structure before it can be classified.

---

## Batches not yet started

- `v2026.10.0-rc.2` cluster (#4035, #4036, #4037, #4038) — next, same reasoning (tag-adjacent cluster, likely to repeat the "mostly release chore, maybe one real fix" shape).
- Keyword-sweep hits outside the two clusters above (`add-iron-proxy`, `add-onecli` payload changes beyond #4028, `src/gateway-*`, `src/drivers/*`) — the Bucket-B-likely territory; deliberately saved for after the clusters, per the skill's own "where the call isn't clear, don't force it" guidance — these need real Step 3 trust-boundary scrutiny, not a quick classification.
- The remaining ~63-PR trickle — not yet grouped by theme.

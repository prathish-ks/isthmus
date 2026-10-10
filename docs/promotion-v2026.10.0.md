# nanocoai/nanoclaw v2026.10.0 Promotion — Living Plan

Status: **in progress — Step 0 (scope) and the mechanical porting work
behind Steps 1–7 are substantially done; the playbook's formal artifacts
for Steps 1–3 (the consumed-contracts re-check, the Step 2 file-inventory
CSV, and structured Bucket-B acceptance records) have not yet been
produced as standalone documents, and Steps 8–9 have not started.** This
document is the source of truth for where the promotion actually stands;
update it in place as each remaining piece lands — don't let the chat
history that produced it become the only record.

Companion to `go-host/docs/upstream-promotion-playbook.md` (the
version-agnostic procedure this document is an instance of),
`docs/promotion-prep-notes.md` (the pre-tag classification record for 75
of this promotion's 83 PRs — read as the detailed evidence behind the
summary below, not duplicated here), `docs/upstream-watch-log.md` (the
incremental watch trail that fed Step 0), `go-host/docs/
version-compatibility.md` §1 (the consumed-contracts table Step 1 checks
against), and `docs/promotion-v2.4.0.md` (the first instance of this
playbook — read as a worked example of the full template; this promotion
is narrower in kind, so this document is deliberately shorter, not
because the playbook's bar is lower).

## Artifact index — where each kind of evidence actually lives

| Evidence type | Lives at |
|---|---|
| Pre-tag classification of 75/83 PRs (17 batches) | `docs/promotion-prep-notes.md` — the authoritative record; this document summarizes it, does not repeat it |
| Post-tag tail review and port (7 PRs: `#4052`, `#4059`–`#4064`) | This document's "The 7-PR tail" section below, plus the commit messages themselves (each one records what was ported, adapted, or declined, and why) |
| Full-diff file-inventory CSV (playbook Step 2's required artifact) | **Not yet produced** as the exact `docs/promotion-v2026.10.0-file-inventory.csv` the playbook specifies — see "Open before Step 8" below |
| Consumed-contracts re-check (Step 1) | **Done ad hoc for the one row `#4061` implicated** (CLI-restart guard decision logic — see the tail section); the other 6 rows of `version-compatibility.md` §1 have not been walked against this tag's diff as a dedicated pass |
| Security acceptance records (Bucket B) | **Not yet produced** in the playbook's structured form (operation, reachable paths, threat model, named approver, dated expiry, regression test) — this promotion's Bucket-B-adjacent findings (`#4061`, `#4060`, `#4059`) are documented informally in their own commit messages instead |
| Named, deferred follow-ups | "Named deferred follow-ups" section below, carrying forward `docs/promotion-prep-notes.md`'s own deferred list plus one new item from this tail |
| CI evidence | Not yet gathered for this promotion — the 384-file / 4790-test full host suite referenced below ran locally in the prep worktree, not on real CI (see "Open before Step 8") |
| Final pin update | `docs/upstream-pin.json` + `docs/baseline.md`'s "Stable Baseline" section — not yet touched; happens only at Step 9 |

## Goal

Move the pinned upstream baseline from `nanocoai/nanoclaw` **v2.4.0**
(`143db6c907c652773a536c7c9e96269fdad0a4a4`) to **v2026.10.0**
(`7203e00dc271cc2ea9ea84bb130731b8ca00319e`, tagged 2026-10-09), covering
every one of the 83 PRs upstream merged in between — not a partial or
convenience-scoped subset — while:

1. Porting every new privileged capability that belongs in the Go kernel
   into the Go kernel. (`#4061` is this promotion's one instance: a
   falsy-value scope-bypass fix needed in both `src/cli/guard.ts` and the
   Go kernel's `DecideRestartLike`.)
2. Resolving every seam change without silently dropping a feature from
   either project, and documenting every narrowing explicitly rather than
   absorbing it quietly.
3. Finding and closing concretely exploitable bypasses discovered along
   the way, not just the ones upstream's own PR titles named (`#4061`'s
   Telegram `@botname`-suffix admin-gate bypass was found during this
   promotion's own review, not upstream's).
4. Reconciling pure-TypeScript upstream changes against Isthmus's own
   prior divergence, calling out every place Isthmus's architecture
   differs from upstream's assumption rather than applying a diff blindly.
5. Only moving the pin once Steps 1–8 are genuinely satisfied — this
   document exists specifically so that bar doesn't get declared met
   before it is.

## Non-goals

- Re-litigating any of the 17 prior batches' `declined`/`port-verbatim`/
  `port-with-modification` calls recorded in `docs/promotion-prep-notes.md`.
  Those are closed; revisit only if new evidence contradicts one.
- Resolving the deferred items carried forward from that document (listed
  below) as part of this pass — they remain named, owned, and open, not
  silently bundled into this promotion's scope.
- Producing a new ADR unless Step 10's retrospective actually surfaces
  something the playbook or `design-laws.md` should learn — not assumed
  up front.

## PR boundaries

Following `docs/promotion-v2.4.0.md`'s precedent: implementation work
lands as a sequence of small, independently-reviewed PRs out of this
worktree, each showing its diff and waiting for explicit approval before
being opened — never pushed or merged by this skill. The final pin-move
PR (Step 9) is deliberately isolated: `docs/upstream-pin.json` +
`docs/baseline.md`'s Stable Baseline section + any closing ADR + the
evidence index, nothing else. The 7-PR tail below was implemented
directly in this worktree's commit history as the equivalent of several
small PRs' worth of work; whether it ships as one PR or several is a
decision for when Step 8 re-validation is done, not before.

## Step 0 — Scope (done)

- **Tag**: `v2026.10.0`, annotated, resolves to `7203e00dc271cc2ea9ea84bb130731b8ca00319e`
  ("chore(release): v2026.10.0 (#4065)"), released 2026-10-09 13:12:56+02:00.
  `upstream/main` is one trivial commit ahead (`#4066`, a dependency bump)
  — confirmed not part of this tag, excluded from scope.
- **Full range**: `v2.4.0` (`143db6c9`) → the tag commit: **91 commits, 83
  unique PR numbers.**
- **75 of 83 already classified and implemented** pre-tag, across 17
  batches, recorded in full in `docs/promotion-prep-notes.md`. That
  document is itself the authoritative Step 0/2/3/5 record for that
  portion of the range — not re-derived or summarized into a table here
  beyond what's in this section.
- **The remaining 8 commits** (7 real PRs + the release-chore commit
  itself) were new since that document's last pass and needed fresh
  review: `#4052`, `#4059`, `#4060`, `#4061`, `#4062`, `#4063`, `#4064`.
  Reviewed and ported in this session — see "The 7-PR tail" below.
- No batch-cluster or keyword-sweep flag from `docs/upstream-watch-log.md`
  was left unreconciled against this real check; the watch log's
  bootstrap entry pre-dated all 83 PRs, so Step 0 here is a fresh,
  authoritative check, not a copy of the log.

## The 7-PR tail — reviewed and ported this session

Each entry: what upstream's PR did, what Isthmus-specific adaptation was
needed, and the commit that landed it in this worktree.

| PR | Title | Commit(s) | Notes |
|---|---|---|---|
| [#4061](https://github.com/nanocoai/nanoclaw/pull/4061) | Close a CLI-restart guard group-scope bypass | `630f48c5` (TS + Go kernel), `56ae7fad` (follow-up test fix) | A falsy-value bypass in `src/cli/guard.ts`'s `commandDecide`: an unset/empty scope field skipped the group-scope check entirely. Traced the same bug into the Go kernel's `DecideRestartLike` and fixed both in one commit, per the user's explicit "do it now as part of this promotion" decision — the kernel side was confirmed currently inert in production (its one real call site hardcodes trusted values) but still a genuine consumed-contract break (`version-compatibility.md` §1's "CLI-restart guard decision logic" row). Also closed a second, independently-found bypass: Telegram's `@botname` command suffix defeated the host's admin-command gate (exact-match) while the container runner accepted it (prefix-match), plus missing SDK command aliases. Required adding `agent_group_id`/`group`/`id` to 12 synthetic test payloads across two fixture files (`fixtures-guard-catalog.test.ts`, `guard.coverage.test.ts`) that had bypassed dispatch's auto-fill and so failed for the wrong reason under the new unconditional check. |
| [#4062](https://github.com/nanocoai/nanoclaw/pull/4062) | One slash-command parser for the host gate and the container runner | `2c92ecaf` | Consolidated duplicated slash-command parsing logic between `src/slash-command.ts` (host gate) and `container/agent-runner/src/slash-command.generated.ts` (runner), closing the admin/filtered-command divergence `#4061` also touched from a different angle. Preserved Isthmus's deliberate `/remote-control` → filtered (not admin) categorization and `formatter.ts`'s hand-maintained `ADMIN_COMMANDS`/`FILTERED_COMMANDS` mirror, which upstream's own `commandSets(providerName)` refactor has not yet been absorbed into on this fork. |
| [#4063](https://github.com/nanocoai/nanoclaw/pull/4063) | Close a symlink/TOCTOU race across agent-writable mounts | `30694633` | The largest single piece: 2690 lines of real upstream diff (not the ~1-file estimate this promotion started with), ported across 9 production files and 10+ test files. New `src/anchored-dir.ts`: pins a directory by file descriptor (`O_NOFOLLOW` at every path segment, opened once) so later I/O is immune to a symlink swap, rather than re-checking a path after the fact the way Isthmus's own earlier `#3889`/`#3997`-era mitigations did. `inbox-safety.ts` was trimmed, not deleted like upstream — its `isPathInside` helper has independent consumers in `group-folder.ts`/`templates/local-dir.ts` beyond the inbox/outbox mechanism this PR closes. Several pre-existing coverage tests mocked `fs.lstatSync`/`fs.realpathSync` to force branches no longer reachable with descriptor-based I/O; adapted to mock `fs.openSync` / spy on `AnchoredDir.prototype`, and two tests whose premise ("realpath redirects outside the directory") is now structurally impossible were replaced with a comment pointing at the real regression coverage in `session-manager.outbox.test.ts`. |
| [#4064](https://github.com/nanocoai/nanoclaw/pull/4064) | Keep `fs.constants` real in driver tests' `fs` stub | `b0fe74af` | Small, mechanical: two test files' `vi.mock('fs', ...)` replaced a default export outright, losing `fs.constants` (needed by `#4063`'s `O_NOFOLLOW` usage). Fixed by spreading the real module's `constants` through the mock. |
| [#4060](https://github.com/nanocoai/nanoclaw/pull/4060) | Validate the Mattermost owner ID before it hits a later shell command | `f25871c0` | Real, confirmed shell-command-injection risk: the owner-ID capture in `add-mattermost/SKILL.md` had no `validate:` regex, so a crafted Mattermost API response could inject shell syntax into a downstream `nc:run` step. Added `validate:^[a-z0-9]{26}$`; also hardened `skill-apply.ts`'s `bindCapture` to stop echoing the raw captured value into its own error message (which could itself carry injected/quoted text) and to catch invalid-JSON from a capture's `effect:fetch` output cleanly instead of letting a raw parse error propagate. |
| [#4059](https://github.com/nanocoai/nanoclaw/pull/4059) | Fetch the OneCLI installer over HTTPS only, with protocol pinning | `91eea7c0` | Real MITM-downgrade risk: `setup/onecli.ts`'s installer command was a bare `curl -fsSL onecli.sh/install \| sh` — no explicit scheme, vulnerable to an HTTP downgrade. Pinned `--proto '=https' --proto-redir '=https'` and the explicit `https://` scheme. **Named, not fixed here**: the command still pipes to `sh`, not `/bin/sh` — a `$PATH`-shadowed `sh` on the host could substitute a different interpreter. This is a real but separate judgment call (changing the interpreter binary is a larger decision about how `setup/onecli.ts` invokes shells generally, not specific to this PR's actual upstream change) — see "Named deferred follow-ups" below. |
| [#4052](https://github.com/nanocoai/nanoclaw/pull/4052) | Scope Dial through the OneCLI policy API (gateway 1.42) | `0cd61354` | `/add-dial-tool` was **concretely broken**, not just stale: OneCLI gateway 1.42 (Isthmus's own pin, confirmed via `versions.json`) rejects the legacy per-agent block-rule writes the skill used to scope Dial access, and the skill's own pre-flight version guard (ported earlier this promotion as part of the 17-batch prep work, `#4036`) already told the operator so — but nothing had migrated the scoping mechanism itself. Ported the new `.claude/skills/add-dial-tool/scripts/dial-policy.ts` (OneCLI policy-API client) verbatim plus its 17-test suite (real-subprocess, real-HTTP-server end-to-end, no live gateway needed), rewrote `SKILL.md`'s scoping section and `REMOVE.md`'s uninstall step to call it, and updated `apply-fixtures.json`. Also backfilled a pre-existing gap in `scripts/add-dial-tool-scope.test.ts`: the "OneCLI gateway version guard" + engine-gating test coverage that `#4036`'s own Isthmus port (batch 3, pre-tag) never added to this file, surfaced only because `#4052`'s diff touches content inside it — closed by taking the file to its real upstream state at the tag commit rather than hand-applying a diff against a baseline Isthmus never actually had. |

**Verification for the full tail**: each commit above was independently
typechecked and test-verified before committing (see each commit message
for its own targeted-suite numbers); after the final commit (`#4052`),
`pnpm exec tsc --noEmit` is clean and the full host suite passes **384
test files / 4790 tests, zero regressions**, run locally in this prep
worktree on 2026-10-10.

## Named deferred follow-ups

Carried forward or newly named — every one has an owner path back to this
document, none silently dropped:

- **New this tail**: `setup/onecli.ts`'s installer still pipes to `sh`,
  not an explicit `/bin/sh` — a `$PATH`-shadowed `sh` could substitute a
  different interpreter for the install script. Named during `#4059`;
  not fixed, since it's a broader decision about shell invocation in that
  file, not part of that PR's actual upstream change.
- **Carried forward from `docs/promotion-prep-notes.md`** (unresolved as
  of this document; re-verify each is still accurate before acting on it,
  per this project's own "verify before recommending from memory"
  discipline):
  - `#3964`/`#3965`'s OpenCode-provider halves — target files live only
    on the `providers` sibling branch, not reviewed against `main`.
  - `#4039` (upgrade guide refuses an empty gateway pin) — sequencing
    dependency (`#3989`) is now resolved; ready to schedule whenever this
    branch returns to the deferred-items backlog.
  - `#3908`'s multi-queued-a2a-turn half (no `queuedTurns` structure in
    Isthmus's `poll-loop.ts`) — flagged during the v2.4.0-era review as
    needing a human call on its own merits; that question was never
    actually put to the user, and no part of it (including its simpler
    single-turn half) has been implemented.
  - `#3948`'s drain/restart half — Isthmus's `drainContainers` never
    force-stops at all, flagged "possibly deliberate" during
    classification and never resolved either way. (Its `reapResidue`
    gateway-role-exclusion half already shipped, pre-tag.)
  - `#3883` (remove Iron Control's database on uninstall) — 799 lines
    across 7 files of new generic Compose-project-scanning machinery;
    needs its own dedicated pass against Isthmus's full uninstall
    scan/plan/remove pipeline.
  - `#4015` (skip the approval card for reads carrying no credential) —
    needs predecessor abstractions Isthmus's `gateway-approval-
    coordinator.ts` doesn't have yet (`modelAuthorities`,
    `credentialScope`, `gateway-read-policy.ts`); its own dedicated
    Step-3 trust-boundary pass, not a quick port.

## Open before Step 8

The mechanical porting work (Steps 2/4/5 in substance) is done for all 83
PRs. Before this promotion can honestly claim Steps 1–3 satisfied in the
playbook's own required form, still outstanding:

1. **Step 1, full re-check.** Only the one `version-compatibility.md` §1
   row `#4061` implicated (CLI-restart guard decision logic) was walked
   against this tag's diff. The other 6 rows have not been re-checked for
   this specific tag.
2. **Step 2's file-inventory CSV.** No `docs/promotion-v2026.10.0-file-
   inventory.csv` exists. The classification substance is real and
   recorded (`docs/promotion-prep-notes.md` for 75 PRs; this document's
   tail table for 7), but not in the playbook's specified machine-readable
   schema.
3. **Step 3's structured acceptance records.** This tail's Bucket-B-
   adjacent findings (`#4061`, `#4060`, `#4059`) are documented in their
   commit messages, not as the playbook's named-approver/dated-expiry
   acceptance records.
4. **Real CI evidence.** The 4790-test green run above is local-only, in
   this prep worktree. This project's own standing rule is to trust real
   CI log evidence over local sandbox runs for anything timing- or
   environment-sensitive — this promotion has not yet run on CI at all.
5. **Step 8 re-validation itself** — re-run Step 2's classification
   against the tag's actual current state and re-confirm the tag SHA
   hasn't moved, immediately before any pin-move PR.

## Changelog

- 2026-10-10 — Document created. Captures Step 0's scope finding, the
  7-PR tail's full port (commits `630f48c5`, `56ae7fad`, `2c92ecaf`,
  `30694633`, `b0fe74af`, `f25871c0`, `91eea7c0`, `0cd61354`), and the
  honest state of what remains before Step 8/9.

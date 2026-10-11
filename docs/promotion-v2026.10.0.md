# nanocoai/nanoclaw v2026.10.0 Promotion — Living Plan

Status: **Steps 0–7 now genuinely done** (Step 6's wiring-registry/ADR-028
check still needs a real run; Step 7's live acceptance test is recorded in
`docs/promotion-v2026.10.0-rollback-iron-proxy.md`). PR `#73` merged with CI
green. The three "must close or accept-and-document" items (`#3908`,
`#4039`, `#3966`) are fixed, not just documented. **Step 8 re-validated**:
the tag SHA is unchanged and `upstream/main` is still exactly one trivial
commit ahead (`#4066`), same as Step 0 recorded — nothing new to
reclassify. **Step 9 (the pin-move PR) has not started.** This document is
the source of truth for where the promotion actually stands; update it in
place as each remaining piece lands — don't let the chat history that
produced it become the only record, and don't let a status line get ahead
of what was actually checked.

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
| Full-diff file-inventory CSV (playbook Step 2's required artifact) | `docs/promotion-v2026.10.0-file-inventory.csv` — **done**, all 253 changed paths across the full `v2.4.0`→`v2026.10.0` range, every row bucketed (A/B/C) and carrying a `reconciliation_decision`, zero blanks |
| Consumed-contracts re-check (Step 1) | `go-host/docs/version-compatibility.md` §1 — **done**, all 8 rows walked against the real tag diff and annotated inline (7 clean, 1 break — `#4061`, closed) |
| Security acceptance records (Bucket B) | This document's "Step 3 — Bucket B trace" section below — **done, zero acceptance records needed**: every Bucket B finding in this range was either closed outright or remains a named, not-yet-implemented deferral (never a decided, accepted bypass), matching `docs/promotion-v2.4.0.md`'s own Workstream C5 precedent |
| Named, deferred follow-ups | "Named deferred follow-ups" section below |
| CI evidence | **Not yet gathered.** The 384-file / 4790-test full host suite referenced below ran locally in the prep worktree, not on real CI — needs a pushed branch/PR before this can close (see "Open before Step 8") |
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

## Step 1 — Consumed-contracts re-check (done)

All 8 rows of `go-host/docs/version-compatibility.md` §1 walked against
the real `143db6c907c652773a536c7c9e96269fdad0a4a4..7203e00dc271cc2ea9ea84bb130731b8ca00319e`
diff (not the ambiguous `v2.4.0` tag name — this fork's own release tag
of the same name collides with upstream's; always resolve by explicit
SHA when diffing against an upstream tag in this repo). Findings
recorded inline in that document, dated to this promotion:

- **7 rows clean.** Mount/session admission shape, safe container
  defaults, and the physical Docker chokepoint rows all cite
  `src/drivers/types.ts`/`docker-driver.ts` — both files changed in this
  range, but the only change (`#3948`'s `reapResidue` gateway-role
  exclusion, already ported pre-tag) touches neither `validateSpec`/
  `mountAllowed` nor `prepare`/`.stop()` nor RunAs/resource-cap hardening.
  Session/mailbox identity, self-mod guard logic, `cli_scope`/
  `pending_approvals` shapes, and the central DB file itself were all
  untouched in this range outright.
- **1 row broke, already closed.** CLI-restart guard decision logic —
  `#4061`'s falsy-value scope bypass, fixed in both `src/cli/guard.ts`
  and the Go kernel's `DecideRestartLike` (commits `630f48c5`,
  `56ae7fad`), detailed in the tail table below.

## Step 2 — Full-diff file-inventory CSV (done)

`docs/promotion-v2026.10.0-file-inventory.csv` — all 253 paths changed
across the whole repo in this range (not scoped to `src/`; swept
`.claude/skills/`, `setup/`, `container/`, `scripts/`, `.github/`, `docs/`
too, per the playbook's own v2.4.0 lesson), built by mapping every commit
in the range to its PR number via the merge-commit graph (not commit-
subject guessing alone — 8 squash-adjacent commits needed their PR
inferred from which merge commit's second parent actually contains them),
then cross-referencing each file's owning PR(s) against
`docs/promotion-prep-notes.md`'s existing decisions and this document's
own tail table. Every row's bucket and `reconciliation_decision` is
filled — zero unclassified rows.

**Keyword sweep** (`gateway|onecli|iron|secret|credential|vault`, the
playbook's own named list, run verbatim with no additions) surfaced real
Bucket B membership beyond what each PR's top-level classification alone
would have shown — matching the exact lesson the playbook names from the
v2.4.0 promotion. **112 of 253 rows landed in Bucket B**, 61 in A
(file-pattern matches: `drivers/`, `cli/{dispatch,guard,registry}.ts`,
`modules/{self-mod,agent-to-agent,kernel-supervisor}/`, `go-host/`), 80
in C.

**Per-file fidelity, checked, not assumed.** A PR's own top-level
decision (`docs/promotion-prep-notes.md`'s table, or this document's tail
table) does not always apply uniformly to every file that PR's upstream
diff touched — several PRs are "narrowed" (part ported, part declined)
or bundle multiple provider-specific halves. Rather than trust the
PR-level label file-by-file, every row was cross-checked against
`git ls-tree -r HEAD` (does this exact path actually exist in Isthmus's
tracked tree right now?) and corrected where it didn't match. This caught
real mismatches, each now reflected as its own CSV row and decision
rather than inherited from the PR's general characterization:

- `setup/gateways/selection.ts`/`.test.ts` — the generic gateway-selection
  abstraction these belong to was never adopted (`#3910`'s PR-level
  decision, `port-with-modification`, applied to a *different* file this
  same PR touched — `add-wechat/scripts/wire-dm.ts` — not this one).
- `scripts/update/controller-archive.test.ts` — part of `#3913`'s
  declined gateway-module-loading half, not its ported SKILL.md half.
- `setup/installer-shell.test.ts` — part of `#4059`'s shell-interpreter-
  pinning half, which Isthmus's actual port did not carry (the named
  `sh` vs `/bin/sh` gap below).
- `.github/labeler.yml` — no path-based area-labeler workflow exists on
  this fork at all (confirmed absent); touched by four PRs in this range
  including this promotion's own `#4063`, all equally not-applicable.
- `src/reconcile.ts`, `reconcile-queue.test.ts`, `host-sweep.queue.test.ts`
  — `#3947`'s full queue-based rearchitecture, declined; the underlying
  bug was real and independently closed with a narrower
  `stopOrphanedSessions()` fix instead (`declined-independently-fixed`).
- `.claude/skills/add-mattermost/scripts/verify-runtime.ts` and its two
  test files — Isthmus's `add-mattermost` skill has no standalone
  runtime-verification CLI at all (checked directly: confirmed absent,
  and confirmed no other file in the skill echoes a raw caught error the
  way `#4060` fixed, so the fix's actual intent is fully closed for every
  path that exists here).
- Every `.claude/skills/add-onecli/**` path — forced to
  `declined:not-applicable:architecture-onecli-stays-core` regardless of
  which PR touches it; the skill doesn't exist on this fork at all
  (matching `docs/promotion-v2.4.0-file-inventory.csv`'s own established
  decision string for the same situation).
- Every `.claude/skills/add-opencode/payload/**` and
  `add-codex/payload/**` path — forced to
  `declined:out-of-scope-tracked-by-sync-sibling-branch-mechanism`
  (same established v2.4.0 precedent); these live on the `providers`
  sibling branch, not this fork's `main`.

**Two new gaps surfaced by this per-file check, not previously named**
(added to "Named deferred follow-ups" below):

- `#3920`'s port only covered the Claude-specific failure-assist
  restriction (`setup/lib/claude-assist.ts`) — upstream's real diff
  applies the identical read-only-tools restriction to OpenCode's and
  Codex's own unattended failure-assist spawns too
  (`add-opencode/payload/scripts/opencode-host.ts`,
  `add-codex/payload/setup/providers/codex.ts`), both on sibling
  branches never reviewed here.
- `#3966` (Iron Proxy keyless local model over plain HTTP): the user
  already approved adopting this (`docs/promotion-prep-notes.md`'s
  "Decisions from the user" §2), but it was never actually implemented —
  approved, not done. This was recorded in the prep notes but had not
  yet been carried into this document's own deferred-follow-ups list
  until now.

## Step 3 — Bucket B trace (done, zero acceptance records needed)

Every Bucket B finding in this range, traced per the playbook's own
question — is the privileged effect reachable only through the Go
kernel, or does this create/extend a TS-only gate — and resolved to one
of two outcomes, never a silent "accepted":

**Closed outright** (fixed, not accepted as a permanent exception):
`#4061` (CLI-restart guard falsy-bypass, closed in TS and the kernel),
the independently-found Telegram `@botname` admin-gate bypass closed in
the same commit, `#4060` (Mattermost owner-ID shell-injection, closed),
`#4059` (OneCLI installer MITM-downgrade, closed for the TLS half). None
of these represent a privileged operation this kernel could enforce
instead — CLI command dispatch, skill-install shell commands, and a
chat-adapter capture regex are host-process-level TS concerns outside
LAW-07's kernel-exclusive-enforcement scope entirely (the same category
`skill-apply.ts`'s shell execution has always been), so there is no
"should this be kernel-enforced instead" question live here: they were
bugs, now fixed, not boundary decisions.

**Named, deferred, genuinely undecided** (not an accepted bypass —
nothing was decided to leave as a permanent TS-only gate; the work is
simply not done yet): `#3883`, `#3908`, `#3948`'s drain/restart half,
`#4015`, `#4039`, `#3964`, `#3920`'s opencode/codex halves. Each is named
with an owner path in "Named deferred follow-ups" below, none silently
dropped. `#3966` is the one item actually *approved* by the user but not
yet implemented — once it lands, **that** is the point a real acceptance
record would be needed (it relaxes Iron Proxy's front-proxy TLS-only
policy, a genuine new capability, not a bug fix) — not before.

**Zero acceptance records produced**, matching
`docs/promotion-v2.4.0.md`'s own Workstream C5 precedent exactly (that
promotion also closed with zero — "every finding closed outright, not
accepted"). The playbook's acceptance-record mechanism exists for a
*decided*, *permanent* TS-only exception to kernel enforcement; this
range produced bugs that got fixed and deferrals that remain genuinely
open, neither of which that mechanism is for. Also checked: did this
range touch the one *existing* accepted TS-only decision already on the
books (`docker-driver.ts`'s `capabilities()` `admissionEnforced: false`)
— no, confirmed via Step 1's own diff read (`docker-driver.ts`'s only
change in this range is `reapResidue`'s gateway-role exclusion, a
different method entirely) — nothing to re-review there.

## External review findings (PR #73)

An external review of this promotion's implementation PR (`#73`, head
`3425f7f`) surfaced two real, previously-unnamed findings and correctly
challenged this document's own completion language. Recorded here rather
than left to scroll off in review comments.

**Two concrete findings, both verified directly and fixed (not just
named) in this PR:**
- `src/provider-contracts/realize.ts`'s `prepareSpawnFile` (the
  `append-open-close` operation) opened its target through a raw path
  string with `O_NOFOLLOW` on the final component only — the same TOCTOU
  class `#4063`'s `AnchoredDir` work closed everywhere else in this file,
  missed here. Confirmed dormant (no registered provider contract
  declares an `append-open-close` file today — zero matches in
  `container/agent-runner/src/provider-contracts/claude.ts`), so not a
  live regression, but a real gap for the next provider that declares
  one. Fixed by routing through `AnchoredDir.open` + `appendFile` like
  every other agent-writable-mount site in the file; added a
  nested-relativePath test and a negative control (symlinked
  intermediate directory refused, not followed).
- `src/session-manager.ts`'s `extractAttachmentFiles` doc comment still
  described the pre-`#4063` lstat/realpath defense list, even though the
  function body already uses `AnchoredDir` correctly (confirmed: its own
  inline comment, added by `#4063`, already said so). Corrected the doc
  comment — no behavior change, just stopped describing a mechanism that
  no longer enforces the boundary.

**The completion-language correction**: this document previously said
"Steps 0–7 done." That was wrong. Steps 1–6 are done in substance and
artifact form (Step 6's ADR-028 wiring-registry check still needs a real
run). **Step 7 (migration continuity) was never actually worked on in
this promotion** — no concrete, executable acceptance test with a
recorded rollback artifact exists for this tag, per the playbook's own
Step 7 requirement. This matters specifically for the `#3948` item below.

**On `#3948` (gateway survival through update cutover/rollback)**:
checked directly, not assumed — `scripts/update/service.ts`'s
`drainContainers` and `scripts/update/transaction.ts` contain zero
`docker stop`/`docker kill` calls; drain only polls for containers to
exit on their own. Upstream's bug (drain force-stopping the central Iron
Proxy container, residue-reap then deleting it) requires a force-stop
step that structurally doesn't exist in this codebase — a real
architectural reason the bug can't manifest the way it did upstream, not
just an assumption. But this has been read from the code, not proven by
a live gateway+cutover+rollback test — exactly what Step 7 would produce
if it were actually done. Reclassified below from "possibly deliberate,
unresolved" to "architecturally sound, needs Step 7's live evidence."

**Scope boundary, which the review itself draws and this document
agrees with**: none of the above should block PR `#73` (the
implementation-prep PR) from merging on its own CI and review — the
playbook has always treated the implementation PR and the Step 9 pin-move
PR as carrying different assurance bars, and named, non-blocking
follow-ups are an accepted, tracked pattern here (the gateway-lease-
continuity/poll-loop.ts precedent the skill already cites). What changes
is Step 9's own gate: it cannot be satisfied by "all 83 PRs reviewed and
classified" alone. See "Open before Step 8/9" below for the sharpened
list.

## Named deferred follow-ups

Carried forward or newly named — every one has an owner path back to this
document, none silently dropped. Each now carries an explicit
disposition for the Step 9 gate (fix before pin / accept-and-document /
needs a live test), not just a bucket of "deferred":

- **Closed, not deferred** (were "must close or accept-and-document
  before Step 9"; all fixed for real rather than documented as an
  accepted gap):
  - `#3908` — A2A failure-notice loops. Fixed: a `failureNotice` marker
    on the outbound content, checked before `deliverErrorResult`'s own
    write and the outer-catch error writer, container-side only —
    matches upstream's real shipped shape (`FAILURE_NOTICE_FIELD`,
    `failureNoticeWake`, `sendsFailureNotice`), not upstream's bundled
    `queuedTurns` rewrite.
  - `#4039` — OneCLI upgrade guide now refuses to run with
    `ONECLI_VERSION` unset, via a `: "${ONECLI_VERSION:?...}"` guard
    baked into each of the three copy-paste command blocks.
  - `#3966` — Iron Proxy keyless local HTTP model. Implemented: a new
    `modelAuthorities` provider-contract field, `iron-proxy-local-model.ts`'s
    origin filtering (local host, non-default port, no collision with
    Iron's own management ports), and `main.go` changes admitting the
    local-model path only through a narrow rule (plain HTTP, no CONNECT
    tunnel, explicit non-default port, OpenAI-shaped route) — never
    through the normal allowed-hosts check. Security review recorded in
    the commit message (redirect-based SSRF, authority spoofing, DNS
    rebinding all checked and found not applicable; the one accepted
    tradeoff — cleartext on this one hop — matches an existing
    credentialed precedent, not a new risk).
  - `#3948` — gateway survival through update cutover/rollback. Fixed
    (`drainContainers`'s missing gateway-role exclusion) and proven with
    a live Iron Proxy cutover/rollback test, not just the architectural
    read the external review flagged as insufficient — see
    `docs/promotion-v2026.10.0-rollback-iron-proxy.md`. That same live
    test caught a second real bug in the first fix attempt (a
    `docker ps -q`/`--format` incompatibility), also fixed.
- **Large, separate efforts — reasonable to defer past this promotion,
  tracked with an owner**:
  - `#3883` — Iron Control database cleanup on uninstall. 799 lines
    across 7 files of new generic Compose-project-scanning machinery;
    needs its own dedicated pass against this fork's uninstall
    scan/plan/remove pipeline, not squeezed into this promotion.
  - `#3964`/`#3965`'s OpenCode-provider halves, `#3920`'s OpenCode/Codex
    failure-assist halves — target files live only on the `providers`
    sibling branch, never reviewed against `main`. Reasonable to leave
    there until that branch gets its own review pass; the sibling branch
    itself still needs that pass before being offered to users.
  - `#4015` — needs predecessor abstractions (`modelAuthorities`,
    `credentialScope`, `gateway-read-policy.ts`) this fork doesn't have
    yet. Its own dedicated Step-3 trust-boundary pass. Already more
    restrictive than upstream's opt-in default, so not a regression —
    just not yet implemented.
  - `setup/onecli.ts`'s installer piping to `sh` instead of an explicit
    `/bin/sh` (named during `#4059`) — a real but narrow hardening gap,
    small fix, not security-critical (runs on the operator's own
    machine during setup).

## Open before Step 8/9 — all closed

1. **Real CI evidence** — done. `#73`'s required `ci` gate shows
   `completed`/`success` on `dfee5d21` (the commit carrying the semgrep
   fix and the stale Iron-Proxy-comment correction from the external
   re-review); `ci`'s own script requires `performance-gate` among its
   dependencies to succeed, so that gate passed too.
2. **Step 7, actually done** — done. Live acceptance test recorded in
   `docs/promotion-v2026.10.0-rollback-iron-proxy.md`: a real running
   Iron Proxy gateway container survived a real cutover and rollback
   untouched (same container identity throughout), `#3948`'s
   `drainContainers` fix was reproduced failing pre-fix and passing
   post-fix live (and caught a second, real bug in that same fix —
   `docker ps -q`/`--format` incompatibility — that the mocked unit
   tests couldn't have caught), and a genuine mid-cutover infrastructure
   interruption was recovered via `rollbackUpdate` without data loss.
3. **The three "must close or accept-and-document" items** — done, all
   three fixed (not deferred to a risk-acceptance note):
   `#3908` (A2A failure-notice reply-loop suppression, container-side,
   matching upstream's real shape), `#4039` (OneCLI upgrade guide's
   unset-`ONECLI_VERSION` guard), `#3966` (Iron Proxy keyless local HTTP
   model support, with its own security review recorded in that
   commit's message).
4. **Step 8 re-validation** — done. Tag SHA unchanged
   (`7203e00dc271cc2ea9ea84bb130731b8ca00319e`); `upstream/main` is still
   exactly one trivial commit ahead (`#4066`, a dependency bump), the
   same single commit Step 0 already recorded and excluded — nothing new
   to reclassify.
5. **Step 9's pin-move PR** — not prepared yet; follows now that 1–4
   above are closed.

## Changelog

- 2026-10-10 — Document created. Captures Step 0's scope finding, the
  7-PR tail's full port (commits `630f48c5`, `56ae7fad`, `2c92ecaf`,
  `30694633`, `b0fe74af`, `f25871c0`, `91eea7c0`, `0cd61354`), and the
  honest state of what remains before Step 8/9.
- 2026-10-10 (same day, continued) — Steps 1–3 completed in full: the
  consumed-contracts re-check (`version-compatibility.md` §1, all 8 rows),
  the Step 2 file-inventory CSV (253 rows, zero unclassified), and the
  Step 3 Bucket B trace (zero acceptance records needed). Surfaced and
  named two previously-untracked gaps along the way (`#3920`'s opencode/
  codex halves, `#3966`'s approved-but-unimplemented status). Only real
  CI evidence and Step 8's final re-validation remain before Step 9.
- 2026-10-11 — PR `#73` merged; CI confirmed green. All items in "Open
  before Step 8/9" closed for real: `#3908`/`#4039`/`#3966` fixed
  (not accept-and-documented), Step 7's live Iron Proxy
  cutover/rollback test done (`docs/promotion-v2026.10.0-rollback-iron-proxy.md`,
  which also caught and fixed a second real bug in `#3948`'s own fix),
  Step 8 re-validated (tag unchanged, upstream/main still one trivial
  commit ahead). Step 9's pin-move PR is the only remaining step.

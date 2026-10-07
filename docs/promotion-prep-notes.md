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

## Batch 2 — the `v2026.10.0-rc.2` cluster (PRs #4035, #4036, #4037, #4038)

| PR | Title | Bucket | Decision |
|---|---|---|---|
| [#4035](https://github.com/nanocoai/nanoclaw/pull/4035) | test(setup): reuse exec-checked stubs in the restart readiness tests | C | `declined:not-applicable` — the target file, `setup/lib/restart-readiness.test.ts`, doesn't exist in Isthmus's trunk at all (`setup/lib/` only has `restart.sh`, a shell script, not this TypeScript test suite). Nothing to port against. |
| [#4036](https://github.com/nanocoai/nanoclaw/pull/4036) | fix(onecli): hold the gateway on 1.42.0 and stop /add-dial-tool on 1.42+ | B-adjacent | **`port-with-modification` — done, committed (Batch 3).** Confirmed the underlying risk is real in Isthmus too: `add-dial-tool/SKILL.md` and `REMOVE.md` both call the legacy OneCLI rules API (`onecli rules create/list/delete/update`) to scope Dial access per agent, which OneCLI gateway 1.42+ rejects — without a gate, a silently-failed rule write would leave Dial usable by every `all`-mode agent. Ported upstream's version-gate shape, not its exact script: added a new `nc:run capture:onecli_gateway validate:^[0-9]+\.[0-9]+\.[0-9]+$ effect:fetch` directive right after the existing `command -v onecli` pre-flight check, which reads the gateway's `/api/health` version via `onecli config get api-host` + `curl`, and fails closed (stops the skill, writes nothing) unless the version is older than 1.42. Prefixed the four downstream command bodies that write OneCLI state (`dial auth login`, `dial auth verify-otp`, the `onecli secrets create` block, and documented the same reasoning in `REMOVE.md`'s rules-delete loop with a graceful-failure fallback rather than a hard gate, since removal must stay safe on a gateway that already rejects rule reads/writes). Isthmus's gateway-version axis is genuinely separate from `@onecli-sh/sdk@2.2.1` (the client SDK pin in `package.json`) — this gate checks the actual running gateway via its HTTP API, not the SDK pin, so it is correct regardless of which SDK version Isthmus ships. **Verified**: `scripts/skill-directives.ts` lint clean on both `SKILL.md` and `REMOVE.md` (no problems, no warnings, all `{{vars}}` resolve); added an `/api/health` fixture stub (version `1.41.0`, i.e. pre-gate) to both scenarios in `apply-fixtures.json`; full `scripts/skill-conformance.test.ts` + `scripts/add-dial-tool-scope.test.ts` suite (207 tests) passes; full host suite (364 files / 4391 tests) passes; `tsc --noEmit` clean. `scripts/add-dial-tool-scope.test.ts` needed no changes — it unit-tests individual command bodies pulled out by content-match, and the one body it exercises that I touched (`onecli secrets create`) only gained a leading no-op `: "..."; ` statement that discards its unsubstituted `{{onecli_gateway}}` literal harmlessly. |
| [#4037](https://github.com/nanocoai/nanoclaw/pull/4037) | fix(update): wait for the launchd host to exit after bootout | A (seam-adjacent: `scripts/update/service.ts`'s `stopService`, part of the update/cutover path, not kernel-facing but privileged-process-lifecycle) | **`port-with-modification` — done, committed.** Isthmus's own `stopService` had the exact same race: the `launchd` branch returned immediately after `bootout` while the `nohup` branch right below it already correctly polled for exit. Real bug, same failure mode upstream describes (`launchctl bootstrap` racing the still-shutting-down job, failing with `5: Input/output error`, rolling the whole update back). Ported the fix, but **not** upstream's exact diff — their version introduces a `probe()` helper and `startCommand()` helper neither of which exist in Isthmus's current `service.ts` (meaning Isthmus has already diverged from upstream's helper layout independent of this PR). Rewrote using Isthmus's own already-existing `env.runner.tryRun()` instead of introducing new unknown helpers, matching the file's existing style. **Known, disclosed gap versus upstream's version**: `tryRun` only exposes `{ok, stdout}`, not an exit-status code, so Isthmus's version can't distinguish "job legitimately not found" (upstream's status 113) from "launchctl couldn't determine the job's state at all" (upstream's status 112, treated as a harder failure) the way upstream's `probe()` can — both cases just read as `ok: false` here. The core race-condition fix (wait for the job to actually leave the domain before returning) is fully ported; this one error-classification nuance is not, and would need extending `CommandRunner`'s own interface to add — a bigger, separate decision, not bundled into this fix. Verified: 14/14 `service.test.ts` tests pass (4 new/rewritten, matching upstream's new test shapes adapted to the `tryRun`-based implementation), 7/7 `transaction.e2e.test.ts` tests pass (needed one further fix: the e2e test's launchd fake `tryRun` always returned `ok: true`, which would have made the new poll spin for the full 60 retries before throwing — fixed to reflect the test's own `running` flag), `tsc --noEmit` clean. |
| [#4038](https://github.com/nanocoai/nanoclaw/pull/4038) | chore(release): v2026.10.0-rc.2 | C | `declined:not-applicable` — same reasoning as `#4025`: pure upstream release bookkeeping. |

**Batch 2 status**: 3 of 4 resolved (`#4035` N/A, `#4037` ported and tested, `#4038` N/A). `#4036` carried forward and resolved in Batch 3 below.

**Files changed this batch**: `scripts/update/service.ts`, `scripts/update/service.test.ts`, `scripts/update/transaction.e2e.test.ts` — committed separately from this notes file, same batch.

---

## Batch 3 — `#4036` follow-up (OneCLI gateway version gate for `/add-dial-tool`)

| PR | Title | Bucket | Decision |
|---|---|---|---|
| [#4036](https://github.com/nanocoai/nanoclaw/pull/4036) | fix(onecli): hold the gateway on 1.42.0 and stop /add-dial-tool on 1.42+ | B-adjacent | **`port-with-modification` — done, committed.** See the updated Batch 2 row above for the full writeup; kept there rather than duplicated since that is where the finding was first flagged. |

**Batch 3 status**: 1 of 1 resolved (`#4036`, ported and fully test-verified — see above).

**Files changed this batch**: `.claude/skills/add-dial-tool/SKILL.md`, `.claude/skills/add-dial-tool/REMOVE.md`, `.claude/skills/add-dial-tool/apply-fixtures.json` — committed separately from this notes file, same batch.

---

## Batches not yet started

- Keyword-sweep hits outside the two clusters above (`add-iron-proxy`, `add-onecli` payload changes beyond #4028, `src/gateway-*`, `src/drivers/*`) — the Bucket-B-likely territory; deliberately saved for after the clusters, per the skill's own "where the call isn't clear, don't force it" guidance — these need real Step 3 trust-boundary scrutiny, not a quick classification.
- The remaining ~63-PR trickle — not yet grouped by theme.

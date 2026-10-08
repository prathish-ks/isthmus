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

## Full-review classification (2026-10-07) — all 70 PRs now classified

Batches 1–3 (above) covered the two tag-adjacent clusters (7 PRs). The
remaining 63 were classified in this pass, delegated across 7 thematic
research agents (read-only: bucket + draft decision only, no edits). This
section is the classification record; the "Implementation plan" section
below tracks what actually gets ported, in what order, and the
"Decisions needed" section lists what's waiting on the user.

`#4028` (flagged in Batch 1) is now resolved: Isthmus's `init-onecli` is
a one-time bootstrap/credential-migration skill with no `versions.json`
pin-tracking or `/update-nanoclaw`-driven upgrade-guide concept at all —
not a renamed equivalent of upstream's `add-onecli`. `declined:
not-applicable`.

Note: a fresh `git log` against `upstream/main` during this pass showed
one new commit beyond the watched range (`66f0823a`, PR #4051,
`fix(setup): carry the upgrade marker across setup's local commits`) —
out of scope for this review (not in the original 70), left for the next
Watch-mode cycle.

### Batch 4 — setup/readiness

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3884 | keep the Claude CLI offer to Claude installs | C | `port-verbatim` — same stale provider-resolution guard in `setup/lib/claude-handoff.ts`/`picked-provider.ts` |
| #3905 | log the first-chat ping result + real OpenCode auth duration | C | `port-with-modification` — trunk half (first-chat ping never logged) real and portable; OpenCode-duration half targets a `providers`-branch-only file, not reviewed |
| #3887 | never clip a readiness probe to the deadline | C | `declined:not-applicable` — the whole socket-probe-with-deadline mechanism doesn't exist; Isthmus's closest analog (`verifyServiceHealth`) doesn't clip the same way |
| #3910 | detect installed gateways without parsing nested pnpm output | C | `port-with-modification` — no generic gateway-detection abstraction to fix, but the identical un-silenced `pnpm exec tsx` JSON-parse bug is real in `add-wechat/scripts/wire-dm.ts` and `scripts/q.test.ts` |
| #3920 | restrict failure-assist agents on a live install | B | `port-with-modification` — real, high-value security fix: `setup/lib/claude-assist.ts` spawns an unattended `claude -p ... --permission-mode bypassPermissions` session with full tool access; restricting it to read-only tools ports cleanly. Doc-wording adaptation needed for `debug/SKILL.md` (no `gateway` step exists, only `onecli`) |
| #3901 | host service reach the internet through an HTTPS proxy | B | `port-with-modification` — real gap, zero proxy handling anywhere in `setup/service.ts`; insertion points (launchd plist, systemd unit, nohup wrapper) all exist and match structurally |
| #4001 | mirror host pnpm patches in the nested-pnpm probe | C | `declined:not-applicable` — test-only, targets the same nonexistent `setup/gateways/selection.ts` as #3910's core fix |

### Batch 5 — container/agent-runner runtime

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3893 | keep the heartbeat alive during a long streamed block | C | `port-verbatim` — `claude.ts`'s `translateEvents` is byte-identical to upstream's pre-fix shape |
| #3908 | never answer an a2a failure notice with another | B | `port-with-modification` — single-turn `deliverErrorResult` half ports with adaptation; the "thrown stream, multiple queued a2a turns" half has no structural home in Isthmus's architecture (no `queuedTurns` loop) — **needs a human call**, see Decisions needed |
| #3841 | opencode memory hook: spawnSync → async spawn | — | `flag` — target file lives on the `providers` branch only, not reviewed here |
| #3959 | test infra: async bun children instead of spawnSync | C | `port-verbatim` — `stdin-json.test.ts`/`memory/hook.test.ts` still use the hang-prone sync spawn |
| #3994 | show the Claude SDK's own failure notice | C | `port-verbatim` — same generic-notice gap in `claude.ts`; sequence with #3893 (same function) |
| #3998 | trust the gateway CA in the agent browser | B | `port-verbatim` — confirmed real: any TLS-inspecting gateway (OneCLI or Iron Proxy) breaks `agent-browser` HTTPS today; `agent-browser` skill has zero CA-trust handling |
| #3999 | pass `CLAUDE_CODE_AUTO_COMPACT_WINDOW` host→container | C | `port-with-modification` — container-side gap confirmed; host-side needs merging into Isthmus's existing (differently-purposed) `src/providers/claude.ts` registration, and making its barrel import unconditional (today only loaded for custom-endpoint installs) |

### Batch 6 — update/cutover lifecycle

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3913 | load the update controller without setup/ or node_modules | C | `port-with-modification` — real: `update-nanoclaw/SKILL.md` still calls back into `$stageRoot` instead of `$controller_dir`. Gateway-module-loading half declined (no `setup/gateways/` subsystem) |
| #3948 | keep gateway-owned containers through cutover and residue reaping | A/C | `port-with-modification` — **confirmed real bug**: Isthmus's `reapResidue` would `docker rm --force` the Iron Proxy gateway container on a routine sweep, no gateway-role exclusion exists. The drain/restart half is murkier — Isthmus's `drainContainers` never force-stops at all (possibly deliberate) |
| #3956 | rollback stops the live nohup host and drains agent containers | C | `port-with-modification` — real: nohup rollback can target a stale/reused pid (same bug class as #4037, unaddressed for nohup), and never drains containers before restoring `data/` |
| #3962 | refuse cutover when the service liveness probe itself fails | C | `flag` — real bug, but the fix needs `CommandRunner` to expose a numeric exit status, which the #4037 port deliberately left out — **needs a human call**, see Decisions needed |
| #3963 | remove the data symlink with unlinkSync, not rmSync | C | `declined:not-applicable` — the specific symlinked-data test scenario doesn't exist in Isthmus's `transaction.e2e.test.ts` |
| #4012 | restore the snapshot by rename so rollback never half-deletes data/ | C | `port-with-modification` — **confirmed real bug**: Isthmus's `restoreSnapshot` still does delete-then-copy; a mid-copy failure or an undeletable mount point leaves `data/` gone or partial. Isthmus's own `createSnapshot` already uses the atomic build-then-rename pattern — natural, in-spirit fix |
| #4016 | load gateway helpers before cutover swaps node_modules | C | `declined:not-applicable` — bug is intrinsic to the `loadGatewayModules` mechanism from #3913's gateway half, which Isthmus never ported |
| #3988 | refresh the installed gateway when only its skill payload changed | C | `declined:not-applicable` — depends on the same absent `setup/gateways/` subsystem |
| #3986 | follow release tags by default via update channels | C | `declined:conflicts-with-isthmus-governance` — this `feat` would auto-follow upstream's newest release tag by default, directly undercutting the human-reviewed, PR-by-PR promotion model (LAW-09) this whole review exists to enforce |

### Batch 7 — OneCLI/gateway security

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3960 | name the credential, not the provider, in adapter errors | B | `declined:not-applicable` — `add-onecli` skill tree doesn't exist |
| #3989 | pin the gateway to 1.42.0 for the host-enforcement bypass fix | B | **DONE (`e7864d41`)** — bumped `versions.json`'s `onecli-gateway` to `1.42.0`; confirmed via GitHub's API that v1.42.0 is commit `3912c74d...`, whose own release notes name the exact bypass fix (#438); updated `gateway-compat/onecli-summary/upstream.json`'s commit+checksums to match (6 of 7 vendored files byte-identical to 1.41.0, only `apps.rs` changed). `cargo build/test` for the Rust crate not run — no toolchain in this sandbox; the managed Iron image runs that check automatically on build. Accepted trade-off: `/add-dial-tool` now refuses to run on this install (by its own `#4036` gate's design) until rewritten against OneCLI's post-1.42 policy API. |
| #4039 | upgrade guide refuses an empty gateway pin | B | `port-with-modification` — real risk class (empty pin silently falls back to `:latest`), but Isthmus's upgrade doc uses an older, different mechanism (`ONECLI_VERSION=<pin> docker compose up -d`) than what this PR's guard assumes — needs re-authoring for that shape. Sequence after #3989 |
| #4041 | migration warning points back to the pin, not the old version | B | `declined:not-applicable` — fixes a typo in a doc paragraph (DB-migration-on-upgrade warning) that Isthmus's doc never carried in the first place |
| #4015 | skip the approval card for reads that carry no credential | B | `flag` — Isthmus's `gateway-approval-coordinator.ts` is missing multiple predecessor abstractions this PR assumes exist (`modelAuthorities`, `credentialScope`, `gateway-read-policy.ts`); needs its own dedicated Step-3 trust-boundary pass, not a quick port. Deferred, not blocking |
| #4013 | authenticate the loopback Gateway webhook | B | `port-verbatim` — **security finding, high confidence**: `chat-sdk-bridge.ts`'s `startLocalWebhookServer` accepts any POST with zero auth and resolves pending approval cards from it; Isthmus already sends the right header on the sending side but the receiver never checks it |
| #4017 | fetch the current WhatsApp Web version before linking | C | `port-with-modification` — real, same pre-fix lineage confirmed in `setup/whatsapp-auth.ts`; verify the `getPlatformId` monkeypatch removal is still safe at Isthmus's pinned Baileys `7.0.0-rc.9` before dropping it |

### Batch 8 — Iron Proxy

Confirmed Iron Proxy has real core + skill footprint in Isthmus (`src/gateway-providers/iron-proxy*.ts`, `.claude/skills/add-iron-proxy/`) — not blanket-declined.

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3915 | skip invalid allowed-hosts entries instead of aborting setup | B | `port-verbatim` — identical pre-fix code in `iron-proxy.ts`/`setup.ts` |
| #3883 | remove Iron Control's database on uninstall | A/B | `port-with-modification` — real: Iron Control's Postgres volume (every stored credential) has no install/role label, so Isthmus's uninstall scan never finds it |
| #3953 | stop early on arm64 engines that cannot run amd64 images | C | `port-verbatim` — no preflight check exists today |
| #3964 | let a provider declare exact host:port model endpoints | B | `port-with-modification`, but **no current consumer in `main`** (OpenCode's consuming half lives on the `providers` branch) — defer until something in `main` needs it |
| #3965 | check the model URL against the selected gateway at the prompt | B | `port-with-modification` — Iron half real and portable (`ironModelEndpoint` byte-identical pre-fix); OpenCode half not applicable here |
| #3966 | allow a keyless model on this machine over plain HTTP | B | `flag` — **new capability, not a bug fix**; relaxes Iron's TLS-only policy at the Go front-proxy's core security boundary — **needs a human call**, see Decisions needed |
| #3969 | send a Basic challenge with the front proxy's 407 | B | `port-verbatim` — identical gap in `front-proxy/main.go` |
| #3981 | bump grpc to 1.83.2 in the Iron front proxy | C | `port-verbatim` — Go module, not pnpm-governed, no release-age gate involved |
| #3982 | pin Iron Proxy to v0.52.0 | C | `port-verbatim` — commit pin matches the exact pre-bump SHA |
| #4005 | bump @grpc/grpc-js to 1.14.5 in the Iron approval bridge | C | `declined-independently-fixed` — root `package.json` already at 1.14.5; only the skill's own `nc:dep` directive text is stale (doc-sync nit) |
| #3985 | keep proxy credentials out of readable service files | B | `declined:not-applicable` — this is the unrelated corporate-HTTP-proxy work (#3901's territory); Isthmus's `service.ts` has zero proxy-credential handling to leak |

### Batch 9 — misc fixes

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3889 | drop `unknown_sender_public` from dropped-messages reasons | C | `port-with-modification` — `public` was never in Isthmus's enum, but it's genuinely missing `unknown_sender_decline_notify`, which `handleUnknownSender` actually writes — same bug class, different manifestation |
| #3892 | wait for the journal to clear instead of sleeping | B | `port-with-modification` — identical sleep-then-read race in `community-portal/runtime.test.ts`, different fixture names |
| #3803 | recover on the fixture-owned port | C | `declined:not-applicable` — the underlying EADDRINUSE-recovery feature (`#2901`) was never ported; no test to de-flake |
| #3945 | seed one session past the cap in the drain test | C | `declined:architecture-differs` — Isthmus's delivery poll is a genuinely different per-session design, no batch-drain function exists |
| #3946 | show a failed step's own error instead of a generic bounce | B/C | `port-verbatim` — confirmed byte-identical pre-fix base in both `add-iron-proxy/scripts/install-command.ts` and `scripts/skill-apply.ts` |
| #3957 | kill the whole process group when a pre-task script times out | B | `port-with-modification` — real: `execFile('bash', ...)` orphans grandchildren on timeout; needs adapting to Isthmus's 2-arg `runScript` signature |
| #3947 | stop containers whose session or agent group was deleted | A | `port-with-modification` — **confirmed real bug**: `groups.ts delete` cascades DB rows but never kills the container, and `host-sweep.ts` only visits active sessions so it never notices. Port the narrow fix (`stopOrphanedSessions()`), not upstream's full queue-based sweep rearchitecture |
| #3958 | log never throws on unserializable data | C | `port-verbatim` — land together with #3983 below (end-state, not sequentially) |
| #3983 | keep nested toJSON redaction with BigInt/cycle | C | `port-verbatim` — actually *replaces* part of #3958's own fix; port the combined end-state |
| #3974 | refresh agent-runner lockfile for transitive advisories | C | `declined-independently-fixed` — Isthmus's current `bun audit` is already clean of every package this PR touches (confirmed via live `bun audit --audit-level=high` run) |
| #4008 | open chat.db under Node with core's prebuilt better-sqlite3 | C | `port-verbatim` — confirmed `add-imessage` exists directly on `main`; identical pre-fix gap |

### Batch 10 — docs/CI/build housekeeping

Isthmus's `.github/CODEOWNERS` marks `ci.yml`/`approve-agent-image.yml`/`verify-agent-image.yml` as its own actively-maintained release/CI surface — these are not inert upstream housekeeping. `release.yml`/`RELEASING.md`/`scripts/release.mjs` are, by contrast, an inherited-but-uncustomized copy (literal upstream reviewer names still present, not CODEOWNERS-claimed) — likely vestigial.

| PR | Title | Bucket | Decision |
|---|---|---|---|
| #3954 | docs(gateways): correct credential-reread comments | B | `port-with-modification` — iron-proxy half byte-identical stale comment, applies; opencode half not applicable (file absent) |
| #3955 | docs(opencode): keep gateway notes in the gateway skills | B | `declined:not-applicable` — the doc-architecture problem (duplicated gateway prose) doesn't exist in Isthmus's simpler `add-opencode` skill |
| #3968 | ci: pin workflow actions and cosign to exact versions | B | `port-with-modification` — real, and **worse in Isthmus than upstream**: ~30 unpinned `uses:` lines in `ci.yml` alone (vs upstream's handful), same unverified cosign download in both agent-image workflows. Needs SHA pins for Isthmus's actual (newer) action versions, not a verbatim copy |
| #3977 | build(deps): bump tsx to 4.23 | C | `port-verbatim` — confirmed current pin is `^4.19.0`, bump clears `minimumReleaseAge` |
| #3979 | test(onecli): umask-independent unsafe-directory test | B | `declined:not-applicable` — target skill doesn't exist; confirmed Isthmus's one structurally-similar test (`install-slug.test.ts`) isn't umask-fragile the same way |
| #3912 | ci(labels): run the area labeler after label-pr | C | `declined:not-applicable` — no path-based area-labeler workflow exists to reorder |
| #3997 | fix(setup): commit applied skill files so a fresh install can update | C | `port-verbatim` — confirmed identical gap: `update-nanoclaw/SKILL.md`'s dirty-checkout guard exists but nothing commits applied skill files, leaving a fresh install unable to update |
| #4011 | docs(contributing): write down the core-or-fork rule | — | `flag` — policy question for a solo-maintained fork with no external PR flow — **needs a human call**, see Decisions needed |
| #4009 | ci: merge agent-image pin bumps by hand, drop the auto-approver | B | `port-with-modification` — directly applicable hardening: delete the never-safely-armable auto-approver workflow, same `AGENT_IMAGE_AUTO_APPROVE` gap confirmed in Isthmus's own CODEOWNERS-claimed workflows |
| #4007 | ci: let Dependabot see skill-pinned npm versions | C | `port-with-modification` — generic scanner reuses existing `scripts/skill-directives.ts` infra; needs regenerating against Isthmus's own ~34-skill tree, not copying upstream's generated output |
| #3987 | feat(release): self-approved pre-releases; widen stable approvers | — | `declined:not-applicable` — Isthmus's own `RELEASING.md` explicitly states it ships a single channel with no RC concept; this release machinery looks vestigial/unmaintained |

---

## Cross-cutting findings from the full review (not tied to one PR's port decision)

- **Security — OneCLI gateway pinned at a disclosed-vulnerable version — RESOLVED.** User approved bumping now (accepting `/add-dial-tool` going dark); done in `e7864d41` (Batch 7). See Batch 7 table.
- **Security — unauthenticated loopback gateway webhook.** `src/channels/chat-sdk-bridge.ts`'s `startLocalWebhookServer` accepts any POST with no auth check and can resolve pending approval cards from it. Confirmed real, high confidence, no judgment call needed — `#4013` ports verbatim and should land promptly.
- **Security (incidental, not from any PR in this range) — unbaselined MCP SDK advisory — RESOLVED.** `container/agent-runner`'s `@modelcontextprotocol/sdk` was pinned `^1.30.0`, carrying `GHSA-6qxp-vccf-f47h` (OAuth client credential leak to an attacker-chosen auth server), found while auditing for `#3974`. Bumped to `^1.32.1` (fix is `1.31.0`+; chose the latest clean patch release, a docs-only bump per its own GitHub release notes). `bun audit` surfaced two new moderate, unrelated transitive advisories pulled in by the newer SDK (fast-uri via ajv, hono via @hono/node-server) — both resolved in range via `bun audit fix` (fast-uri 3.1.7->3.1.8, hono 4.13.5->4.13.7), confirmed `bun audit` clean afterward. `express-rate-limit` override still needed (the SDK's own package.json still depends on `^8.2.1`, unchanged by this bump) — left in place per its own comment's instructions. Verified: `tsc --noEmit` (container tsconfig) clean, full `bun test` — 390 pass / 1 skip / 0 fail (unchanged from before the bump), `check-bun-audit-baseline.ts` reports 0 known high+ advisories.
- **Operational — residue-reaping would force-remove the Iron Proxy gateway container.** Confirmed via direct code read (`#3948`'s findings): nothing in `reapResidue` exempts gateway-role containers from a routine sweep.
- **Operational — Isthmus's own CI surface has drifted further from supply-chain best practice than upstream's current state**, on files Isthmus actively owns per `CODEOWNERS` (`#3968`/`#4009`'s findings) — more unpinned `uses:` lines, same unverified cosign binary.
- **Doc drift — `docs/gateway-seam.md`** is referenced by `CLAUDE.md` but doesn't exist anywhere in the tree. Pre-existing, not caused by any PR here; blocks a doc-only hunk in `#3964`.
- **Architecture gaps noted but explicitly out of scope for this round**: no generic `setup/gateways/` provider-selection subsystem (blocks `#4016`/`#3988`), `CommandRunner` has no numeric exit status (blocks `#3962`), `poll-loop.ts` has no queued-turn structure for multi-hop a2a failure notices (blocks half of `#3908`), and several PRs target files that live only on the `channels`/`providers` sibling branches and were not reviewed here (`#3841`'s opencode half, `#3905`'s opencode half, `#3964`/`#3965`'s opencode halves, `#3954`/`#3955`'s opencode halves).

## Decisions from the user (all answered)

Recorded here for reference; see the Implementation plan section for commit hashes.

1. OneCLI gateway pin 1.41.0 to 1.42.0: bump now. Done, Batch 7.
2. Iron Proxy keyless local model over plain HTTP (#3966): adopt it. Implementation still pending a dedicated security read of main.go; see Batch 8 table.
3. Extend CommandRunner with a numeric exit status for #3962: do it now. Done.
4. CONTRIBUTING.md core vs fork policy (#4011): skip for now.
5. Vulnerability tracking: not asked as a separate question; see the MCP SDK note under Cross-cutting findings.

## Implementation plan (pending, not yet done)

Everything above marked `port-verbatim` or `port-with-modification` still needs to actually be implemented, tested, and committed — this section only records the classification. Grouping for upcoming batches, roughly in priority order:

- **Batch 11 (security-first) — DONE (`92f6c51a`)**: `#4013`, `#3920`, `#3948`'s `reapResidue` gateway-role exclusion half.
- **`CommandRunner` exit-status extension + `#3962` — DONE (`3127590b`)**: user-approved scope increase, unblocks the cutover-liveness-probe fix.
- **Batch 12 (update/cutover safety) — 3 of 4 DONE**: `#4012` atomic restore (`4ef60e45`), `#3956` nohup rollback + drain (`76a72caa`), `#3913` controller self-containment, scoped to the SKILL.md fix only (`705067a1`). `#3883` (Iron Control DB on uninstall) deferred — 799 lines across 7 files, new generic Compose-project-scanning machinery, needs its own dedicated pass reading Isthmus's full uninstall scan/plan/remove pipeline and its interaction with the existing `onecli-agents.ts` removal step.
- **Batch 13 (agent-runner/container) — DONE**: `#3893`+`#3994` (`7dfc02b6`), `#3998` (`87228a36`), `#3999` (`66eb618c`), `#3959` (`7b3ad3a7`).
- **Batch 14 (Iron Proxy mechanical) — DONE**: `#3915`+`#3969`+`#3981`+`#3982` (`dd5ff638`), `#3953` (`7114cb5c`), `#3965` iron half (`d53412ef`) — its OpenCode-side companion targets a file (`opencode-auth.ts`) not present on this `main`-based tree and was out of scope.
- **Batch 15 (setup/misc fixes) — DONE**: `#3884` (`d2662c15`), `#3905` trunk half (`7434eb7d`), `#3910` narrowed (`246cd41a`), `#3901` narrowed to host service (`986ddda5`), `#3889` adapted (`1880bcb1`), `#3892` (`7877df6d`), `#3946` (`0d341bc6`), `#3957` (`be7de6e0`), `#3947` (`2b4f9eee`), `#3958`+`#3983` combined end state (`6b864ef0`), `#4008` (`e38c47a4`), `#4017` (`b6be0bd8`), `#3997` (`b8a2d298`).
- **Batch 16 (housekeeping) — DONE**: `#3977` tsx bump (`317cbf41`), `#3968`+`#4009` CI pinning/hardening (`f9d34e8a`), `#4007` Dependabot skill-pin visibility (`b6b54de5`), `#3954` iron-proxy half doc comment (`7ddd174e`).
- **Deferred, not scheduled**: `#3964`/`#3965` opencode halves, `#4015` (needs dedicated Step-3 pass), `#4039` (sequence after `#3989`'s decision).

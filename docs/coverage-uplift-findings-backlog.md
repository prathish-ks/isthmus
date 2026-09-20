# Coverage-Uplift Findings Backlog

Recorded: 2026-09-20, from the coverage-uplift exercise that took host-side
line coverage (`src/`, `setup/`, `scripts/`) from ~54% to ~80% (branches
~51% to ~77%) via 138 new test files (commit `f146390e`, see that commit's
message and `docs/baseline.md`'s "Update, 2026-09-20" note for the exercise
itself). Writing and running ~1,700 new tests surfaced real behavior —
mostly latent, narrow-window issues — that the tests only exposed, not
caused. This doc tracks all of it, prioritized, for follow-up work.

**Release-readiness read**: nothing below is Critical. Three items are
scored High because they're plausible in normal operation (not exotic
edge cases) and degrade badly when they hit — worth fixing soon, not
blocking. Everything else is a narrow-window edge case, a cosmetic
message, or tech debt. Two items are already fixed as part of this
exercise, listed for the record.

## Already fixed (this exercise)

| # | Finding | File | Fix |
|---|---|---|---|
| F1 | `reconcileDerivedImages()` called without `await` — every successful image pull silently no-op'd the reconciliation step and logged a spurious error instead of actually reconciling | [setup/container.ts:321](../setup/container.ts#L321) | One-line `await` added, commit `f146390e` |
| F2 | Two stale CI test exclusions (`scripts/update/transaction.e2e.test.ts`, `scripts/add-dial-tool-scope.test.ts`) carried "not investigated further" since Aug 2026 baseline. Root-caused: the first was a real symlink-unaware path-comparison bug (already independently fixed on this fork via `realResolve()`); the second no longer reproduces (self-contained fake `onecli` harness, no live dependency) | [vitest.config.ci.ts](../vitest.config.ci.ts) | Exclusions removed, root causes documented in `docs/baseline.md`, commit `f146390e` |

## High — real operational impact under plausible conditions, worth scheduling soon

| # | Finding | File:line | Why High |
|---|---|---|---|
| H1 | `fs.createWriteStream(rawLogPath, ...)` log tee has no `'error'` listener. If the log directory/file becomes unwritable mid-run (disk full, permissions, deleted) that's an **uncaught exception that crashes the whole setup process** instead of a clean error. Disk-full is not exotic — this exact exercise hit it repeatedly. | [setup/lib/runner.ts](../setup/lib/runner.ts), [setup/lib/windowed-runner.ts](../setup/lib/windowed-runner.ts) | Crashes the first-run / repair experience under a realistic trigger |
| H2 | `extractUrlFromOutput()` falls through to matching the CLI installer's own `Downloading https://github.com/...` log line when the gateway installer's real output has no URL — silently "resolving" `https://github.com` as the OneCLI API host instead of correctly failing with `could_not_resolve_api_host` | [setup/onecli.ts:~307-343](../setup/onecli.ts) | Misleading **success** state during OneCLI setup with a broken gateway URL; hard for an operator to diagnose since setup reports OK |
| H3 | `stopOneCLIApprovalHandler()` clears timers and the pending-approval map but never resolves in-flight `handleRequest` promises — a gateway callback still awaiting a decision when the handler stops **hangs forever**, not just until a timeout | [src/modules/approvals/onecli-approvals.ts:110-118](../src/modules/approvals/onecli-approvals.ts) | Approval flow gates credentialed actions (CLAUDE.md's own "Requiring approval for credential use"); an indefinite hang here blocks an agent mid-task until the container is manually restarted |

## Medium — narrow-window or data-adjacent, real but lower likelihood

| # | Finding | File:line | Note |
|---|---|---|---|
| M1 | `spawnContainer` logs "Agent group not found" and returns void on a missing agent group, but `wakeContainer` still resolves `true` — the caller believes the container spawned when nothing happened; the inbound message isn't marked for retry | [src/container-runner.ts:158-162](../src/container-runner.ts) | Silent failure in the core message-delivery path |
| M2 | Backfilling container configs at startup: one group's `createContainerConfig` failure aborts the **entire** backfill (and thus host startup), without logging which group | [src/backfill-container-configs.ts:29](../src/backfill-container-configs.ts) | A single misconfigured group can prevent the whole host from starting; fail-fast may be intentional, but the missing group-id in the log makes it hard to diagnose |
| M3 | The approval card is delivered to the approver **before** `createPendingApproval` writes the row; if the insert throws, the card is live with Approve/Reject buttons that resolve nothing | [src/modules/approvals/onecli-approvals.ts:161-211](../src/modules/approvals/onecli-approvals.ts) | Rare (DB insert failure), but produces a dead-looking UI element with no error surfaced to the approver |
| M4 | `requestApproval()` with no delivery adapter bound yet records the `pending_approvals` row and logs, then returns — nobody is ever carded and nothing retries when the adapter comes up later | [src/modules/approvals/primitive.ts:265-291](../src/modules/approvals/primitive.ts) | Only during the narrow startup window before `setDeliveryAdapter` runs, but the approval is effectively stranded until noticed manually |
| M5 | `v2PlatformId`'s docstring claims it strips a v1 `wa:`/`whatsapp:` prefix, but `isWhatsappJid` classifies by the JID's `@`-host alone — a raw JID that already carries a recognized WhatsApp host keeps the leading `wa:`/`whatsapp:` text unstripped. Confirmed: `v2PlatformId('whatsapp','wa:1234@s.whatsapp.net')` returns unchanged | [setup/migrate-v2/shared.ts:66-71](../setup/migrate-v2/shared.ts) | v1→v2 migration is a one-time, high-stakes step; a mismatched platform id could misfile a migrated WhatsApp user's identity/roles |
| M6 | The "most recent v1 Claude Code session" picker re-stats mtime from the just-**copied** destination files; `copyFileSync` resets mtime to copy time, so with more than one archived session the pick is effectively directory-read order, not real v1 recency | [setup/migrate-v2/sessions.ts:146-157](../setup/migrate-v2/sessions.ts) | Can silently resume the wrong conversation after a v1→v2 migration — confusing, not destructive |
| M7 | `collectSiblingTopLevel`'s three ORed guards drop any message whose **literal text** starts with `"System instruction:"` from cross-session backfill, even from a genuine user, not just host-injected triggers | [src/modules/cross-session-context/backfill.ts](../src/modules/cross-session-context/backfill.ts) | Low-probability text collision, but a real user's message can be silently excluded from an agent's context with no signal that it happened |
| M8 | `egress-lockdown.ts`'s container-membership check is whitespace-token based; a network whose `{{.Name}}` output ever contained spaces would mis-tokenize | [src/egress-lockdown.ts:49](../src/egress-lockdown.ts) | Not observed live and Docker container names don't contain spaces today, but this is security-boundary code (network egress isolation) — worth a defensive fix precisely because the blast radius of a miss here is a lockdown bypass, not because it's currently triggerable |

## Low — cosmetic, dead code, or pure tech debt

| # | Finding | File:line |
|---|---|---|
| L1 | `moduleAgentToAgentDestinations`/etc. aside — `args['host-path']`/`args['container-path']` fallback in the mount CLI is unreachable dead code: `normalizeArgs()` rewrites every hyphenated key to underscores before any handler runs, so the literal hyphenated key can never arrive | [src/cli/resources/groups.ts:~566,595](../src/cli/resources/groups.ts) |
| L2 | `offerFailureHandoff`'s own `NANOCLAW_SKIP_CLAUDE_ASSIST` check is dead code — its only caller already performs the identical check first | [setup/lib/claude-handoff.ts:279](../setup/lib/claude-handoff.ts) |
| L3 | `syncProcessingAcks` is exported but has zero callers anywhere in `src/` — dead code, superseded by `applyProcessingAcks` | [src/mailbox/sqlite/session-db.ts:140](../src/mailbox/sqlite/session-db.ts) |
| L4 | `teardownChannelAdapters()` throwing during shutdown surfaces as an unhandled rejection; harmless since the `finally` block already calls `process.exit(0)`, but nothing logs which adapter's teardown failed | [src/index.ts:179-188](../src/index.ts) |
| L5 | `apply.ts`'s `try` wraps both `buildAgentGroupImage` and the on_wake `writeSessionMessage`; a write failure *after* a successful rebuild reports "rebuild failed" to the operator, which is misleading | [src/modules/self-mod/apply.ts:68-94](../src/modules/self-mod/apply.ts) |
| L6 | The approval-card "N field(s) omitted" line reports the total field count, not the number actually omitted | [src/modules/approvals/onecli-approvals.ts:299-323](../src/modules/approvals/onecli-approvals.ts) |
| L7 | `currentBranch`'s friendly "Update requires a named branch, not detached HEAD" error is unreachable on the real runner — `git()` throws first with a raw `Command failed` error | [scripts/update/transaction.ts:141-145](../scripts/update/transaction.ts) |
| L8 | `uninstall/scan.ts` treats a non-throwing, non-zero `docker image inspect` exit as "no image found" without setting `runtimeOk = false`, unlike guild/channel enumeration which degrades only on a throw — inconsistent daemon-unavailable detection | [setup/uninstall/scan.ts:188-195](../setup/uninstall/scan.ts) |
| L9 | `USE_ANSI`/`TRUECOLOR`/`kleur.enabled` are computed once at module load from `process.stdout.isTTY`; a TTY appearing or disappearing mid-run is never picked up | [setup/lib/theme.ts](../setup/lib/theme.ts) |
| L10 | `fanEcho`'s duplicate-`echoRowId` replay path throws a caught `SqliteError`, logged at `warn` with no counter/metric — intended behavior per the code's own comment, just silent | [src/modules/cross-session-context/fan.ts](../src/modules/cross-session-context/fan.ts) |
| L11 | `sessionHistory` calls `getAgentGroup` unconditionally even when there are zero outbound rows to render | [src/modules/cross-session-context/history.ts](../src/modules/cross-session-context/history.ts) |
| L12 | `parseMemoryMb`'s regex accepts a digit run of unbounded length (parses to `Infinity` for a very long digit string); caught safely by the following `Number.isFinite` guard, so no live impact | [src/container-runner.ts:767-793](../src/container-runner.ts) |

## Not a bug (recorded for context, no action)

- `src/webhook-server.ts`'s `Array.isArray` header-join branch executes but its effect is unobservable — the Fetch API's `Headers` layer scrubs `set-cookie` before any handler sees it via `req.headers.get(...)`.
- `scripts/update/transaction.ts`'s 256MB minimum-free-space guard in `createSnapshot` is a real, working-as-intended safety check, not a bug — it correctly refused a cutover on this exercise's own disk-constrained dev machine.
- `scripts/update/service.ts`'s `process.getuid?.() ?? 0` fallback is Windows-only and untestable on this POSIX host; not evidence of a defect.

## Suggested next step

Pick up H1–H3 first (each is a small, well-understood fix once someone
decides the intended degrade-gracefully behavior for H1 and the intended
strict-failure behavior for H2). M1–M8 are good candidates for a single
follow-up pass given they cluster in two subsystems (container wake/backfill,
OneCLI approvals). L1–L12 are cleanup, fold into any nearby refactor rather
than a dedicated pass.

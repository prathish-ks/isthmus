# Coverage-Uplift Findings Backlog

Recorded: 2026-09-20, from the coverage-uplift exercise that took host-side
line coverage (`src/`, `setup/`, `scripts/`) from ~54% to ~80% (branches
~51% to ~77%) via 138 new test files (commit `f146390e`, see that commit's
message and `docs/baseline.md`'s "Update, 2026-09-20" note for the exercise
itself). Writing and running ~1,700 new tests surfaced real behavior —
mostly latent, narrow-window issues — that the tests only exposed, not
caused. This doc tracks all of it, prioritized, for follow-up work.

**Release-readiness read**: nothing below is Critical, and nothing is open
at High or Medium any more — see the update note below. What remains is
L1–L12: narrow-window edge cases, cosmetic messages, and pure tech debt.

**Update, 2026-09-21**: all three High items and all eight Medium items
were fixed in a follow-up pass the same day, commit `173effa6` ("fix:
harden bugs surfaced by continued coverage-uplift work" — each with its
own regression test). Moved into "Already fixed" below rather than left
under now-inaccurate "High"/"Medium" headers, which was giving readers
(and at least one other session) a false "still open" signal despite the
code fix already being on `main`.

## Already fixed (this exercise)

| # | Finding | File | Fix |
|---|---|---|---|
| F1 | `reconcileDerivedImages()` called without `await` — every successful image pull silently no-op'd the reconciliation step and logged a spurious error instead of actually reconciling | [setup/container.ts:321](../setup/container.ts#L321) | One-line `await` added, commit `f146390e` |
| F2 | Two stale CI test exclusions (`scripts/update/transaction.e2e.test.ts`, `scripts/add-dial-tool-scope.test.ts`) carried "not investigated further" since Aug 2026 baseline. Root-caused: the first was a real symlink-unaware path-comparison bug (already independently fixed on this fork via `realResolve()`); the second no longer reproduces (self-contained fake `onecli` harness, no live dependency) | [vitest.config.ci.ts](../vitest.config.ci.ts) | Exclusions removed, root causes documented in `docs/baseline.md`, commit `f146390e` |
| H1 | `fs.createWriteStream(rawLogPath, ...)` log tee had no `'error'` listener. If the log directory/file became unwritable mid-run (disk full, permissions, deleted) that was an **uncaught exception that crashed the whole setup process** instead of a clean error. Disk-full is not exotic — this exact exercise hit it repeatedly. | [setup/lib/runner.ts](../setup/lib/runner.ts) | Degrades to a logged warning now, commit `173effa6` |
| H2 | `extractUrlFromOutput()` fell through to matching the CLI installer's own `Downloading https://github.com/...` log line when the gateway installer's real output had no URL — silently "resolving" `https://github.com` as the OneCLI API host instead of correctly failing with `could_not_resolve_api_host` | [setup/onecli.ts](../setup/onecli.ts) | Resolves the URL from the gateway installer's own stdout only now, commit `173effa6` |
| H3 | `stopOneCLIApprovalHandler()` cleared timers and the pending-approval map but never resolved in-flight `handleRequest` promises — a gateway callback still awaiting a decision when the handler stopped **hung forever**, not just until a timeout | [src/modules/approvals/onecli-approvals.ts](../src/modules/approvals/onecli-approvals.ts) | Stop now resolves every pending promise with `'deny'`, commit `173effa6` |
| M1 | `spawnContainer` logged "Agent group not found" and returned void on a missing agent group, but `wakeContainer` still resolved `true` — the caller believed the container spawned when nothing happened; the inbound message wasn't marked for retry | [src/container-runner.ts](../src/container-runner.ts) | Throws instead, routing through `wakeContainer`'s own `.catch`, commit `173effa6` |
| M2 | Backfilling container configs at startup: one group's `createContainerConfig` failure aborted the **entire** backfill (and thus host startup), without logging which group | [src/backfill-container-configs.ts](../src/backfill-container-configs.ts) | Logs the group id/folder before rethrowing, commit `173effa6` |
| M3 | The approval card was delivered to the approver **before** `createPendingApproval` wrote the row; if the insert threw, the card was live with Approve/Reject buttons that resolved nothing | [src/modules/approvals/onecli-approvals.ts](../src/modules/approvals/onecli-approvals.ts) | Row created before delivery (deleted if delivery then fails), platform message id patched in after, commit `173effa6` |
| M4 | `requestApproval()` with no delivery adapter bound yet recorded the `pending_approvals` row and logged, then returned — nobody was ever carded and nothing retried when the adapter came up later | [src/modules/approvals/primitive.ts](../src/modules/approvals/primitive.ts) | Defers delivery via the new `onDeliveryAdapterReady` hook instead of dropping it, commit `173effa6` |
| M5 | `v2PlatformId`'s docstring claimed it strips a v1 `wa:`/`whatsapp:` prefix, but `isWhatsappJid` classifies by the JID's `@`-host alone — a raw JID that already carried a recognized WhatsApp host kept the leading `wa:`/`whatsapp:` text unstripped | [setup/migrate-v2/shared.ts](../setup/migrate-v2/shared.ts) | Now actually strips it, commit `173effa6` |
| M6 | The "most recent v1 Claude Code session" picker re-stat'd mtime from the just-**copied** destination files; `copyFileSync` resets mtime to copy time, so with more than one archived session the pick was effectively directory-read order, not real v1 recency | [setup/migrate-v2/sessions.ts](../setup/migrate-v2/sessions.ts) | Reads mtimes from the untouched v1 source directory instead, commit `173effa6` |
| M7 | `collectSiblingTopLevel`'s guards dropped any message whose **literal text** started with `"System instruction:"` from cross-session backfill, even from a genuine user, not just host-injected triggers | [src/modules/cross-session-context/backfill.ts](../src/modules/cross-session-context/backfill.ts) | Replaced with a structural `internal: true` marker set at the injection site and carried through the CLI channel's routed transport, commit `173effa6` |
| M8 | `egress-lockdown.ts`'s container-membership check was whitespace-token based; a network whose `{{.Name}}` output ever contained spaces would mis-tokenize — security-boundary code (network egress isolation), so the blast radius of a miss was a lockdown bypass | [src/egress-lockdown.ts](../src/egress-lockdown.ts) | Newline-delimited format with exact per-line comparison, commit `173effa6` |

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

Everything but L1–L12 is fixed (see the 2026-09-21 update note above).
L1–L12 are cleanup — fold into any nearby refactor rather than a
dedicated pass.

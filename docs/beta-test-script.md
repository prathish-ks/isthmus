# Isthmus Beta Test Script

Thanks for helping test Isthmus. This should take 20-40 minutes on a NanoClaw
setup you're comfortable experimenting with — not a production-critical
install. Nothing here touches your existing NanoClaw data destructively, but
see [Before you start](#before-you-start) for the one precaution worth
taking anyway.

Isthmus does not fork or replace NanoClaw's own TypeScript ecosystem —
channels, skills, customization, and the agent runtime are all unmodified
NanoClaw. What's different is a small Go component (`nanogo`) that the host
now spawns at startup and routes a handful of privileged decisions through
(creating/stopping containers, building the agent image, mount and egress
checks). You shouldn't notice a difference in day-to-day use; that's the
point we're testing.

## Before you start

- **Back up your data directory** (wherever NanoClaw stores its central DB
  and mailboxes) before installing. This is a precaution, not an
  expectation of data loss — but it makes rollback (see the separate
  [rollback runbook](rollback-runbook.md)) trivial if anything looks wrong.
- Confirm you're on a machine where you can run Docker normally and can
  tolerate a few minutes of downtime on this NanoClaw instance.

## Step 1 — Install

1. Clone the repo.
2. Follow `docs/quickstart.md` in the repo: build/install the `nanogo`
   binary via `go-host/scripts/install.sh`, then start the host as you
   normally would (`pnpm start` or your usual process manager).
3. **Record:** did install complete without needing anything not
   documented in `docs/quickstart.md`? Any step where you had to guess or
   dig into source to figure out what to do?

## Step 2 — Run `doctor`

1. Run `nanogo doctor`.
2. **Expected:** 5 checks, all `[PASS]` (container runtime, agent image,
   central DB/mailboxes, credential provider, kernel boundary). There is
   **no** mount-allowlist warning on a normal install — if you see one,
   that's worth reporting, not expected behavior.
3. **Record:** the full output, pass/fail per check, and how long it took.

## Step 3 — Send a message

1. Send yourself (or a test contact) a message through whichever channel
   you normally use with NanoClaw.
2. Confirm the agent container spins up, responds, and the conversation
   flows normally.
3. **Record:** did this look and feel identical to your pre-Isthmus
   NanoClaw experience? Any added latency, unexpected errors, or
   differences in container startup behavior?

## Step 4 — Perform one customization

1. Do one thing you'd normally do to customize NanoClaw — install a skill,
   add an MCP server, adjust a permission, whatever's part of your normal
   workflow.
2. **Record:** did this work exactly as it did before Isthmus? Isthmus is
   specifically designed so ordinary customization never has to touch the
   Go layer (LAW-01/LAW-02 in `CONTRIBUTING.md`) — if anything about your
   customization felt different, gated, or broken, that's a signal
   something is wrong.

## Step 5 — Restart

1. Restart the host process (Ctrl-C and re-run, or however you normally
   restart).
2. Confirm `nanogo serve` comes back up cleanly and a follow-up message
   still works.
3. **Record:** clean shutdown/restart, or anything that hung, crashed, or
   needed manual intervention (e.g. a stale `nanogo` process needing to be
   killed by hand).

## Step 6 — Uninstall / step away

1. Stop the host.
2. Remove the `nanogo` binary (`~/.local/bin/nanogo`) if you want a clean
   teardown, or just leave the process stopped if you're pausing rather
   than fully uninstalling.
3. If at any point in steps 1-5 something felt wrong from a security
   standpoint — a permission that seemed too broad, a mount that looked
   unexpected, credentials appearing somewhere they shouldn't — flag that
   specifically and separately from ordinary bugs; it's the single most
   valuable kind of feedback for this beta.

## If something doesn't work

Before reporting a bug, it's worth trying to self-resolve it with Claude
first — this isn't a cop-out, it's the same model NanoClaw's own
maintainers expect of *their* users ("fork it and have Claude Code modify
it to match your needs"). Isthmus's own tooling is built for exactly this:

1. Run `nanogo doctor` and copy its full output.
2. Open the repo in Claude Code (or paste the output into any Claude
   session) along with `docs/quickstart.md` and whatever error you saw.
3. Ask it to diagnose the failure and propose a fix.

`doctor`'s five checks, `security-check`'s read-only invariant checks, and
`nanogo trace <id>` are all designed to produce structured, specific
output (which check failed, why, and what to do about it) rather than a
raw stack trace, specifically so this works. If Claude can't resolve it,
or the fix it proposes touches the Go kernel (`go-host/`) in a way you're
not comfortable applying yourself, that's exactly when to report it
instead — see below.

## Reporting back

For each step, a short note on: did it work as expected, how long it took,
and anything that felt off — bugs, friction, or security concerns
(reported separately and clearly flagged as such). If you tried
self-resolving with Claude first, mention that too — what it diagnosed and
whether the fix worked is useful signal either way. Rough notes are fine;
this isn't a formal bug-tracker submission.

If anything goes wrong badly enough that you want to back out entirely,
see the [rollback runbook](rollback-runbook.md) — read it *before* you
start, not after something breaks.

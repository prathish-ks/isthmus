# Isthmus Rollback Runbook

**Read this before you install, not after something breaks.**

## The rollback mechanism has changed since this beta was originally planned — read this section first

Earlier project notes described rollback as "flip a single config value to
point your install at the Go-backed session store or fall back to stock
NanoClaw." **That is no longer accurate, and this runbook corrects it.**

As of the enforcement-wiring work (EC-02), `container-runner.ts`'s three
privileged operations — creating a container, stopping/removing a
container, and building the agent image — call the Go kernel
(`internal/kernel`) **exclusively**. There is no remaining native-TypeScript
code path for these three operations to fall back to at runtime; the old
direct-Docker-shell implementation for building the agent image was
removed, not merely bypassed. (One narrow exception: killing a container
falls back to a direct local `docker stop`/`rm` only if the kernel reports
a specific `unknown-session` error — that's an edge-case recovery path,
not a general rollback switch.)

Practically, this means: **if the `nanogo` binary is missing or not
running, Isthmus cannot create or build containers at all** — the host
will not silently and correctly degrade to pure-TypeScript behavior. A
config flag that disables `nanogo` is not a safe rollback; it would leave
you with a host that can't spin up new agent sessions.

The real, verified rollback is a **full revert to stock NanoClaw**, not a
runtime toggle. That's what the rest of this document walks through.

## Why a full revert is safe (and what it doesn't cover)

Isthmus is designed so the entire TypeScript layer — channels, skills,
customization, the agent runtime, the central DB and mailbox format — is
untouched from upstream NanoClaw. The Go kernel only intercepts a small
set of privileged host decisions; it doesn't change how session state,
messages, or configuration are stored. That's the whole premise of the
differential-fixture harness this project is built on: Go behavior is
pinned to match NanoClaw's real TypeScript behavior byte-for-byte, not a
reinterpretation of it.

That means your data directory (central DB, mailboxes, config) should be
readable by a stock NanoClaw install without conversion. This has **not**
been separately exercised as a "downgrade" scenario in this beta yet —
treat the backup step below as required until a tester confirms this in
practice.

## Rollback steps

1. **Stop the host.** Ctrl-C or your normal shutdown, then confirm no
   `nanogo` process is still running (`ps aux | grep nanogo`; kill it if
   one lingers).

2. **Back up your data directory** if you haven't already (see the test
   script's "Before you start" — do this *before* step 1 in practice, not
   after).

3. **Switch your working checkout to stock NanoClaw.** Two options:
   - If you cloned this repo directly: `git remote add
     upstream https://github.com/nanocoai/nanoclaw.git` (if not already
     present), then `git checkout` a stock upstream tag or branch (e.g.
     `git fetch upstream && git checkout upstream/main` into a fresh
     working copy, or clone `nanocoai/nanoclaw` fresh into a new
     directory).
   - Simplest and safest: clone `nanocoai/nanoclaw` fresh into a separate
     directory rather than trying to check out an old state of the beta
     repo in place — this avoids any risk of a half-reverted mixed state.

4. **Point the fresh stock install at your existing data directory** (same
   environment variables / config pointing at your DB and mailbox
   location that your Isthmus install used).

5. **Remove the `nanogo` binary** if you want a clean machine
   (`rm ~/.local/bin/nanogo`), though leaving it in place and unused is
   harmless — nothing calls it unless `kernel-supervisor` spawns it.

6. **Start stock NanoClaw normally** and confirm your existing sessions,
   history, and configuration are intact and a message round-trips
   correctly.

7. **Report back** whether this rollback was clean — this is itself a
   beta finding. If your data directory needed any manual fix-up to work
   with stock NanoClaw, that's an important gap to flag, since the
   original design goal was zero-friction reversibility.

## If something breaks *during* the beta test script

- A failure during **Step 1 (Install)** or **Step 2 (`doctor`)**: nothing
  privileged has run yet against real data — just stop and report; no
  rollback needed.
- A failure during **Step 3 (send a message)** through **Step 5
  (restart)**: stop the host and go through the rollback steps above
  before continuing to use this install for anything you rely on.
- If you're unsure whether something's gone wrong severely enough to
  roll back: err on the side of rolling back and reporting rather than
  continuing to poke at a host you're not confident in.

## Verified: a real downgrade, end to end

**Closed 2026-09-06.** This runbook was previously written from reading the
actual current wiring (`container-runner.ts`, `docker-driver.ts`,
`internal/kernel`), not from a real downgrade run — that gap is now closed.
A real dry run on a real Mac, against a live Telegram channel:

1. Fresh stock NanoClaw install (`main`, via `nanoclaw.sh`), Telegram paired,
   round trip confirmed.
2. Same checkout, same data directory: `git checkout` to the Isthmus branch
   in place, `go-host/scripts/install.sh`, restart. `nanogo doctor` 5/5
   pass. Two messages round-tripped through the same Telegram bot. The
   existing agent container was **adopted, not recreated**
   (`Reconciled sessions at startup adopted=1 stopped=0`).
3. Same checkout, same data directory: `git checkout main` back to stock,
   reinstall/rebuild, restart. Session and container were adopted again
   unchanged. A further message round-tripped correctly.

Zero data loss, zero container recreation, across the full
stock → Isthmus → stock cycle, on the same data directory the whole way.
"Your data survives the downgrade" is now a proven fact, not just design
intent — though still only on one machine's one dry run; the mandatory
backup step above stays mandatory until more testers confirm it.

**One real gap found in the process, orthogonal to the rollback itself:**
the upgrade tripwire (`docs/upgrade-recovery.md`) fires on *both* the
upgrade and the downgrade step above, because each is a code swap against
an already-`/setup`-completed install. `docs/quickstart.md`'s install path
only documents the tripwire for a fresh clone. Clearing it both times was
correct here (no new blocking DB migration either direction — see the
note on `go-host-experiment` drift below), but this should be called out
explicitly in the install docs rather than left for a tester to hit cold.

**Second gap found, unrelated to rollback correctness:** at the time of
this dry run, `go-host-experiment` was one commit behind `main` — missing
`024-host-coordination.ts` (schema-only, no writers yet, so functionally
inert either way). Worth a re-merge before wider release so the gap
doesn't widen, but it did not affect this test's outcome.

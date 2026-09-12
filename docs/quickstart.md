# Quick start

This is the fork of [NanoClaw](https://github.com/nanocoai/nanoclaw) with a
Go security kernel (`go-host/`) mediating every container start/stop —
see `go-host/docs/compatibility-security-report.md` for what that changes
and what it doesn't. You do not need to know Go, or anything about the
kernel, to install and use it: this guide covers install, first run,
`doctor`, sending your agent its first message, and the failures you're
most likely to hit.

You do **not** need to fork this repository or set up a development
environment to use it (that workflow — forking, adding `upstream`,
branching — is only for people who intend to *modify* the Go kernel
itself; see `claude/nanoclaw-go-host-master-plan.md`'s Phase 0 if that's
you). A plain clone of a release tag is all a normal install needs.

## 1. Prerequisites

You need, already installed and working, before you start:

- **Docker** (Docker Desktop on macOS, or Docker Engine on Linux), running.
  Neither this project's own installer nor NanoClaw's ever installs Docker
  for you — it's checked, never silently installed (see
  `go-host/docs/ADR-020-p10-01-minimum-trust-install.md`). If you don't
  have it: [docs.docker.com/get-docker](https://docs.docker.com/get-docker/).
- **git**, to clone the repository.

You do **not** need Node, pnpm, or Go installed yourself — `nanoclaw.sh`
installs Node/pnpm for you, and `go-host/scripts/install.sh` (step 3 below)
either builds `nanogo` with a Go toolchain if you happen to have one, or
downloads a verified prebuilt binary if you don't. Neither ever uses
`sudo` or installs anything system-wide.

## 2. Clone and run the base installer

```sh
git clone <this repository's URL> nanoclaw-go
cd nanoclaw-go
bash nanoclaw.sh
```

This is the same installer upstream NanoClaw ships (see the top-level
`README.md`'s own Quick Start) — it walks you through installing Node/pnpm,
registering your Anthropic credential, building the agent container image,
and pairing your first channel (Slack, Telegram, Discord, WhatsApp,
iMessage, or a local CLI). Nothing about the Go kernel changes this part;
follow its prompts as normal.

## 3. Install the Go kernel binary

```sh
bash go-host/scripts/install.sh
```

This places a working `nanogo` binary at `go-host/bin/nanogo` (built from
source if you have a Go toolchain, otherwise a downloaded, checksum-verified
release binary — see `go-host/docs/release-verification.md`), checks that
Docker is reachable, and links it into `~/.local/bin/nanogo` too. It prints
what it did and any prerequisite it couldn't satisfy for you (Docker not
running, an unreachable release server) — read its output; it never fails
silently.

You only need to run this once per checkout. Re-run it after pulling a new
version of this repository if `go-host/` changed.

## 4. Start NanoClaw

However you normally start it (the same launchd/systemd service
`nanoclaw.sh` registered in step 2, or `pnpm start` for a foreground run
during setup): the Go kernel now starts and stops automatically as part of
the host process — you do not run `nanogo serve` yourself. Look for a line
like this in the host's logs shortly after it starts:

```
INFO nanogo serve is listening socket=.../data/nanogo-kernel.sock pid=...
```

If you instead see `nanogo binary not found`, go back to step 3. If you see
`nanogo serve exited unexpectedly` repeated a few times, see Common
failures below.

## 5. Run doctor

```sh
go-host/bin/nanogo doctor -config <path> -kernel-socket data/nanogo-kernel.sock
```

(`<path>` is the single-session config file the kernel supervisor writes
automatically at `data/nanogo-serve-config.json` — pass that path; you never
need to write one by hand.) `doctor` reports one line per check —
`[PASS]`/`[WARN]`/`[FAIL]` — with a remediation line under anything that
isn't a clean pass. It checks five things: the container runtime, the
agent image (only if you pass `-agent-image`), the central DB/mailboxes,
the OneCLI credential provider, and the kernel socket boundary. Run it
any time something seems wrong; it changes nothing it inspects.

A fresh install normally passes all five cleanly. `doctor` doesn't check
the mount allowlist; that's deliberate. This project's kernel supervisor
(the code that starts `nanogo serve` for you) always passes `-allowlist`
pointing at `~/.config/nanoclaw/mount-allowlist.json` (the same file
NanoClaw's own `mount-security` module already manages). So out of the
box, before you've configured that file, every `allowlisted-extra` mount
(things like a Docker-socket or credential-directory bind mount) is
denied by default rather than trusted — the opposite of what you'd get
running `nanogo serve` by hand with no flags at all. If you want to audit
that allowlist file's own contents once you've created one, use the
separate `nanogo security-check -allowlist <path>` command — see
`go-host/docs/ADR-018-p9-ec05-adversarial-pass-findings.md` and
`go-host/docs/compatibility-security-report.md` for the full story.

## 6. Send your agent its first message

Use whatever channel you paired in step 2 (a Slack DM to your agent's app,
a Telegram message, or the local CLI: `ncl chat <message>` if you paired
the CLI channel). A working round trip looks like: your message appears in
the channel, the agent container starts (you can watch it with
`docker ps` — you'll see a container whose name starts with `ncl-`,
matching the kernel-derived naming `internal/kernel/naming.go` uses), and a
reply comes back in the same channel within a few seconds to a couple of
minutes depending on the request.

If nothing happens: check `go-host/bin/nanogo doctor` (step 5) first, then
the common failures below.

## Common failures

**"NanoClaw stopped: update did not go through the supported path" right
after step 4, on a machine that already had stock NanoClaw `/setup` on it.**
This is NanoClaw's own upgrade tripwire (`docs/upgrade-recovery.md`), and
it is expected here: installing Isthmus by switching an existing,
already-set-up checkout's code (rather than starting from `git clone` in
step 2) is itself a code change the tripwire doesn't know is sanctioned.
Verified live 2026-09-06 in both directions — installing Isthmus this way,
and later rolling back to stock the same way — with a clean build and no
blocking DB migration either time (see `docs/rollback-runbook.md`). Clear
it the same way the tripwire's own message says to:
```sh
pnpm exec tsx scripts/upgrade-state.ts set
```
then restart. Only skip this and investigate instead if the code swap
itself didn't actually finish cleanly (a failed build, a missing
dependency install).

**"nanogo binary not found" in the host's startup logs.**
Run `bash go-host/scripts/install.sh` (step 3) — it wasn't run yet, or ran
in a different checkout than the one you're starting from.

**Docker-related `doctor` failures, or messages never get a reply.**
Confirm Docker is actually running: `docker info`. Neither this project
nor its installer starts Docker for you.

**macOS: "`nanogo` cannot be opened because it is from an unidentified
developer."**
This project doesn't have a paid Apple Developer account to notarize
releases with (see ADR-020's known-limitations section). If you ran
`go-host/scripts/install.sh`, it already checksum-verified the download and
cleared this for you — this message means either you downloaded a binary
by hand outside the installer, or you're running an old copy from before
the installer ran. Re-run step 3, or see
`go-host/docs/release-verification.md`'s Gatekeeper section for how to
clear it yourself safely (checksum-verify first, always).

**`nanogo serve exited unexpectedly` repeating in the logs, a few times in
a row, then stops trying.**
The kernel supervisor retries with backoff up to 5 times before giving up
and logging a final loud error — it will not loop forever. Read the
`nanogo:` -prefixed lines just before each exit for the actual error (a
common one: another process already using the same kernel socket path —
check for a leftover `nanogo serve` process from a manual test run with
`pgrep -fl "nanogo serve"` and kill it).

**A mount-allowlist `WARN` from `doctor` or in the startup logs.**
Expected until you configure one — see step 5. Not a failure to "fix" by
silencing the warning; it's telling you the truth about your current
configuration's actual security posture.

**Something else.** `go-host/bin/nanogo doctor` and `go-host/bin/nanogo
status -config <path>` (the latter with `-json` for a machine-readable
form) are the first things to run — see `go-host/docs/compatibility-
security-report.md` for what this kernel does and doesn't cover, so you
know whether what you're seeing is this project's responsibility or
upstream NanoClaw's.

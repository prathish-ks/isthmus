# Quick start

This is the fork of [NanoClaw](https://github.com/nanocoai/nanoclaw) with a
Go security kernel (`go-host/`) mediating every container start/stop —
see `go-host/docs/compatibility-security-report.md` for what that changes
and what it doesn't. You do not need to know Go, or anything about the
kernel, to install and use it: this guide covers install, first run,
`doctor`, sending your agent its first message, and the failures you're
most likely to hit.

You do **not** need to fork this repository or set up a development
environment to use it — that workflow (forking, adding `upstream`,
branching) is only for people who intend to *modify* the Go kernel itself.
A plain clone of a release tag is all a normal install needs.

**Migrating an existing NanoClaw install?** Everything below works the same
way whether you're starting fresh or converting an already-set-up NanoClaw
checkout in place — `isthmus.sh` (step 2) detects which one you're doing
and handles the difference for you (see that step, and the "upgrade
tripwire" note under Common failures below for what changes for a
migration specifically). The one thing that must be true either way: your
existing install needs to be on the pinned upstream baseline this release
is built against (currently NanoClaw `v2.3.0` — see
`docs/upstream-pin.json`) for the Go kernel's behavioral guarantees to
hold. If you're on a materially different version, check
`go-host/docs/version-compatibility.md` first.

## 1. Prerequisites

You need, already installed and working, before you start:

- **Docker** (Docker Desktop on macOS, or Docker Engine on Linux), running.
  Neither this project's own installer nor NanoClaw's ever installs Docker
  for you — it's checked, never silently installed (see
  `go-host/docs/ADR-020-p10-01-minimum-trust-install.md`). If you don't
  have it: [docs.docker.com/get-docker](https://docs.docker.com/get-docker/).
- **git**, to clone the repository.

You do **not** need Node, pnpm, or Go installed yourself — `isthmus.sh`
installs Node/pnpm for you as part of the normal setup flow, and installs
`nanogo` first, either by building it with a Go toolchain if you happen to
have one, or downloading a verified prebuilt binary if you don't. Nothing
in this flow ever uses `sudo` or installs anything system-wide.

## 2. Clone and run the installer

```sh
git clone <this repository's URL> isthmus
cd isthmus
bash isthmus.sh
```

`isthmus.sh` is the single entry point for both a fresh install and
converting an existing, already-set-up NanoClaw checkout to Isthmus in
place (it checks for `data/upgrade-state.json` to tell which one you're
doing). Either way it: installs the `nanogo` kernel binary first (checks
Docker is reachable, links it into `~/.local/bin/nanogo`, checksum-verifies
a downloaded binary — see `go-host/docs/release-verification.md`), then
runs the same installer upstream NanoClaw ships — Node/pnpm, registering
your Anthropic credential, building the agent container image (a plain
`docker build`, not kernel-mediated — see "Why this is safe" below if
you're wondering), and pairing your first channel (Slack, Telegram,
Discord, WhatsApp, iMessage, or a local CLI). If it detected an in-place
migration, it also stamps the upgrade marker at the end so the startup
tripwire doesn't fire on next start — see Common failures below for what
that means if you're doing this by hand instead.

Kernel install and setup both print what they did and any prerequisite
they couldn't satisfy (Docker not running, an unreachable release server)
— read the output; neither fails silently. Only the kernel-install part
needs re-running after pulling a new version of this repository if
`go-host/` changed (`bash go-host/scripts/install.sh` directly, if you
want to update just that piece without re-running setup).

**Why the kernel installs before setup, safely**: the agent image build
during setup is a plain `docker build` (`setup/container.ts`), not routed
through the kernel at all — no mounts, no waking a live container, no
credentials passed to anything running. The kernel only matters once the
host actually spawns a real per-session container, which happens after
setup finishes, at first use (step 4 below). Installing it first just
closes the window where that could otherwise be a surprise.

## 3. Start NanoClaw

However you normally start it (the launchd/systemd service `isthmus.sh`
registered via `nanoclaw.sh` in step 2, or `pnpm start` for a foreground
run during setup): the Go kernel now starts and stops automatically as
part of the host process — you do not run `nanogo serve` yourself. Look
for a line like this in the host's logs shortly after it starts:

```
INFO nanogo serve is listening socket=.../data/nanogo-kernel.sock pid=...
```

If you instead see `nanogo binary not found`, go back to step 2. If you see
`nanogo serve exited unexpectedly` repeated a few times, see Common
failures below.

## 4. Run doctor

```sh
go-host/bin/nanogo doctor -config <path> -kernel-socket data/nanogo-kernel.sock
```

(`<path>` is the single-session config file the kernel supervisor writes
automatically at `data/nanogo-serve-config.json` — pass that path; you never
need to write one by hand.) `doctor` reports one line per check —
`[PASS]`/`[WARN]`/`[FAIL]` — with a remediation line under anything that
isn't a clean pass. It checks seven things: the container runtime, the
container runtime class (whether this daemon runs containers under a
hardened runtime like gVisor or Kata, or the ordinary shared-kernel
`runc`), the agent image (only if you pass `-agent-image`), the central
DB/mailboxes, the OneCLI credential provider, the kernel socket boundary,
and the cloud-metadata/link-local egress block. Run it any time something
seems wrong; it changes nothing it inspects.

A fresh install normally passes all seven cleanly — including the runtime
class, which passes on a stock Docker install and says plainly in its
detail line that containers share the host kernel, since Isthmus provides
no isolation of that kind itself. `doctor` doesn't check
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
`go-host/docs/compatibility-security-report.md` for the full story.

## 5. Send your agent its first message

Use whatever channel you paired in step 2 (a Slack DM to your agent's app,
a Telegram message, or the local CLI: `ncl chat <message>` if you paired
the CLI channel). A working round trip looks like: your message appears in
the channel, the agent container starts (you can watch it with
`docker ps` — you'll see a container whose name starts with `ncl-`,
matching the kernel-derived naming `internal/kernel/naming.go` uses), and a
reply comes back in the same channel within a few seconds to a couple of
minutes depending on the request.

If nothing happens: check `go-host/bin/nanogo doctor` (step 4) first, then
the common failures below.

## Common failures

**"NanoClaw stopped: update did not go through the supported path" right
after step 3, on a machine that already had stock NanoClaw `/setup` on it.**
This is NanoClaw's own upgrade tripwire (`docs/upgrade-recovery.md`) — a
code-swap against an already-`/setup`-completed install isn't one of the
tripwire's built-in supported paths, so it fires by default. If you ran
`isthmus.sh` (step 2) for this migration, it already detected the
in-place-upgrade case and stamped the marker for you at the end — you
should not see this. If you *do* see it anyway (you migrated some other
way — swapped the checkout code by hand, used your own deploy script,
etc.), it's expected and not a real failure: verified live 2026-09-06 in
both directions — installing Isthmus this way, and later rolling back to
stock the same way — with a clean build and no blocking DB migration
either time (see `docs/rollback-runbook.md`). Clear it the same way the
tripwire's own message says to:
```sh
pnpm exec tsx scripts/upgrade-state.ts set
```
then restart. Only skip this and investigate instead if the code swap
itself didn't actually finish cleanly (a failed build, a missing
dependency install).

**"nanogo binary not found" in the host's startup logs.**
Run `bash go-host/scripts/install.sh` directly — either it wasn't run yet
(shouldn't happen if you used `isthmus.sh`, which always runs it first),
or it ran in a different checkout than the one you're starting from.

**Docker-related `doctor` failures, or messages never get a reply.**
Confirm Docker is actually running: `docker info`. Neither this project
nor its installer starts Docker for you.

**macOS: "`nanogo` cannot be opened because it is from an unidentified
developer."**
This project doesn't have a paid Apple Developer account to notarize
releases with (see ADR-020's known-limitations section). If you ran
`isthmus.sh` or `go-host/scripts/install.sh` directly, it already
checksum-verified the download and cleared this for you — this message
means either you downloaded a binary by hand outside the installer, or
you're running an old copy from before the installer ran. Re-run
`go-host/scripts/install.sh`, or see
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
Expected until you configure one — see step 4. Not a failure to "fix" by
silencing the warning; it's telling you the truth about your current
configuration's actual security posture.

**Something else.** `go-host/bin/nanogo doctor` and `go-host/bin/nanogo
status -config <path>` (the latter with `-json` for a machine-readable
form) are the first things to run — see `go-host/docs/compatibility-
security-report.md` for what this kernel does and doesn't cover, so you
know whether what you're seeing is this project's responsibility or
upstream NanoClaw's.

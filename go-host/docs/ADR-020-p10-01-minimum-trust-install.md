# ADR-020: Phase 11 P10-01 — Minimum-Trust, Rootless Install

Status: accepted, 2026-09-05.

## Context

`docs/release-gate-checklist.md`'s scope is closed (Phase 9, revised — see
`claude/nanoclaw-go-host-roadmap-to-v1.md`), but nothing in that work ever
made `nanogo serve` (the Go security kernel EC-02/EC-03 put in the request
path) *start*. Every real run of it so far — EC-05's live-Docker tests,
EC-06's live smoke test (`scripts/ec06-live-smoke.sh`) — started it by hand,
in a separate terminal, before the TS host ever ran. That is a fine harness
convention for testing. It is not an install a beginner can be expected to
follow (the master plan's own P10-01 instruction: "package Go host...
detect prerequisites rather than silently sudo/install privileged
software... done when a fresh-user install path is documented and
minimizes privilege"). This ADR records the two decisions that close that
gap: how `nanogo serve` actually starts as part of an ordinary install, and
how the `nanogo` binary itself gets onto a user's machine without root.

## Decision 1 — process lifecycle: host-lifecycle-integrated child process, not a second service unit

`nanoclaw.sh` already installs the TS host as a per-user background
service (a launchd agent on macOS, a systemd `--user` unit on Linux — see
`setup/lib/install-slug.sh`'s `launchd_label`/`systemd_unit` helpers,
referenced from `nanoclaw.sh`'s own `--uninstall` path). Two designs were
available for wiring `nanogo serve` into that same install:

- **(a) A second, sibling service unit** (its own launchd plist / systemd
  unit) that the installer registers alongside the host's.
- **(b) The TS host spawns and supervises `nanogo serve` as its own child
  process**, using the existing `onHostStart`/`onHostShutdown` registry in
  `host-lifecycle.ts` — the same mechanism every other host capability
  (approvals, self-mod, permissions) already uses to wire in start/stop
  behavior.

**Chosen: (b).** Reasons:

- **No new trust surface.** A second service unit is a second thing an
  operator has to reason about, audit, and keep in sync with the host's own
  lifecycle (what happens if one is running and the other isn't? what
  restarts first after a reboot?). A child process supervised by the
  already-running host has exactly one lifecycle to reason about, and it
  runs at the *same* trust level as the host itself — same user, no new
  privilege, nothing this ADR adds needs `sudo` anywhere.
- **Deterministic shutdown ordering.** `onHostShutdown` callbacks run LIFO,
  awaited, before the host's own DB/CLI-server teardown. A sibling service
  unit has no such ordering guarantee against the host's own shutdown
  sequence without extra coordination (e.g. a shared PID file, a check in
  each unit's `ExecStop`) — the child-process design gets this for free.
- **Consistent with an existing pattern in this codebase.** `drivers/
  cli.ts`'s `realCli.start()` already spawns and supervises helper
  processes (`docker start --attach`) with `detached: true` specifically so
  a signal delivered to the host's process group does not also blindly hit
  the child. This ADR's new `src/modules/kernel-supervisor/index.ts`
  reuses that exact reasoning and that exact flag, rather than inventing a
  second convention for "a supervised child process" in one codebase.

**What this costs**: if the TS host isn't running, `nanogo serve` isn't
running either — there is no independent "start the kernel without the
host" path in a normal install. This is judged acceptable because nothing
in this project's architecture calls the kernel except the TS host itself
(EC-02's whole point is that `container-runner.ts` is the sole caller). A
kernel with no caller running has nothing to do.

**Failure mode, by design**: if the `nanogo` binary can't be found, or the
process fails to start, `kernel-supervisor` logs a loud, specific warning
and lets the host start anyway. This is deliberately *not* a new security
control — `KernelClient` (`src/kernel/client.ts`) already fails closed on
every EC-02-gated call when no kernel is reachable (a plain connection
error, handled as a runtime-unavailable failure, not an admission
decision). A host running without a supervised kernel behaves exactly as
it always has when nobody happened to start `nanogo serve` by hand:
container wake/kill simply cannot succeed. This module only removes the
"by hand" part for the common case. It adds no new way for a privileged
action to slip through unenforced.

## Decision 2 — binary provisioning: build-from-source preferred, checksummed download as fallback, both rootless

`go-host/scripts/install.sh` places a working `nanogo` at `go-host/bin/
nanogo`, trying, in order:

1. **Build from source** with a local Go toolchain (`go build -mod=vendor`)
   if one is present. Preferred because it needs no network fetch, no
   checksum trust decision, and produces a binary from exactly the source
   tree the user already has checked out.
2. **Download a release binary** matching the local OS/arch from this
   repo's own `nanogo-v*` GitHub releases (P10-02, `.github/workflows/
   nanogo-release.yml`), verify its SHA256 against that release's published
   `SHA256SUMS` before ever executing or installing it, and refuse outright
   if the checksum file is missing or doesn't match — see
   `go-host/docs/release-verification.md` for the full verification story,
   including the keyless-signing layer above the checksum.

Both paths write only to `go-host/bin/` (a build) or `~/.local/bin/` (a
symlink to that build, or a downloaded binary) — ordinary user-owned
locations, never a system-wide directory, never `sudo`. Docker is checked
(`docker info`) but never installed by this script, matching `nanoclaw.sh`'s
own existing posture toward Docker as an explicit, user-provided
prerequisite (P0-08 already treats it this way for the rest of the
project) and the master-plan instruction's own wording ("detect
prerequisites rather than silently sudo/install privileged software").

**A real bug this ADR's own self-testing caught before delivery**: an
earlier draft's `build_from_source` ran `go build` inside a subshell and
relied on `set -e` to abort on failure. Because that function is called
from `if ... && build_from_source; then`, bash suspends `errexit` for the
*entire* command being tested by an `if`/`&&` — including everything a
called function does internally, not just its own top-level statement.
Against a genuinely broken build, the script printed `built $DEST` and
returned success with no binary ever produced. Found by actually running
the script against a real failing build (not just `shellcheck`, which does
not model cross-function `set -e` suspension). Fixed by checking the
subshell's own exit status explicitly with `if (...); then ... fi`,
without depending on implicit `errexit` propagation through a call chain
that might, from some caller, be evaluated as a tested condition. See the
script's own comment at that point for the same account, and
`claude/nanoclaw-go-host-roadmap-to-v1.md`'s EC-06 entry for this project's
prior, similar `set -e` findings. This is now the third time a `set -e`-in-
a-conditional-context subtlety has produced a real bug in this project's
own scripts, which is worth naming as a recurring, specific hazard to keep
checking for, not a one-off.

## A real, load-bearing rough edge this work surfaced (not fixed, named plainly)

`nanogo serve -config` requires `internal/config.Config`'s single-session
proof format (P3-02): `data_dir`, `groups_dir`, `user_id`, `agent_group_id`,
`agent_folder`, and `session_id` are all mandatory per `Config.Validate()`.
`buildServeKernel` (`cmd/nanogo/serve.go`) only ever reads `DataDir`/
`GroupsDir` from it for the real, production kernel construction — the
three session-identity fields are never consulted by anything `serve`
itself does. `kernel-supervisor`'s `ensureServeConfig()` satisfies this by
writing inert placeholder values (`"kernel-supervisor"`) for the three
unused fields. This works, and is safe (nothing reads them), but it is a
real mismatch: a format designed for "one user, one agent, one session"
protocol proofs is now doing the job of a production server's startup
config, carrying three fields whose only purpose is to make a validator
that was never updated for this new caller stop complaining. A cleaner fix
— splitting `serve`'s actual config needs (`DataDir`/`GroupsDir` only) from
P3-02's original single-session proof struct — is straightforward but
out of scope for this ADR. It is recorded here so it isn't rediscovered as a
mystery later, the same way ADR-004/ADR-015 have recorded similar
scope-boundary findings from earlier phases.

## Known limitation carried forward, not solved here: no macOS notarization

A downloaded (not locally built) `nanogo` binary is unsigned by an Apple
Developer ID and unnotarized — this project has no paid Apple Developer
account. `install.sh` clears the resulting quarantine flag itself, but
only *after* verifying the binary's checksum against the release's own
`SHA256SUMS` (see that script's header comment and `release-verification
.md`). This is judged acceptable for a project explicitly framed as
security-conscious open source rather than a signed commercial product.
It matches P10-04's
own instruction to distinguish "100% of defined tests pass" from
"bug-free," applied here to "verified download" vs. "Apple-notarized."

## What this closes, and what it does not

Closes: `docs/release-gate-checklist.md`'s P10-01 (design a minimum-trust,
rootless install path) and gives P10-02's release artifacts (checksums,
signature, SBOM) an actual consumer (`install.sh`'s download path).

Does not close: P10-03 (the beginner quick-start narrating this flow
end-to-end for a first-time user — see `docs/quickstart.md`) or P10-04
(the compatibility/security report citing this ADR's decisions in
user-facing language — see `go-host/docs/compatibility-security-report.md`).
Both are separate Phase 11 deliverables built alongside this one.

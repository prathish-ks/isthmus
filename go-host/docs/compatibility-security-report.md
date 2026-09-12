# Compatibility and Security Report

Phase 11, P10-04. Status: accepted, 2026-09-05. Covers the Go security
kernel (`go-host/`) as of commit `890acc04` on `go-host-experiment`.

**How to read this report**: every claim below cites the test, ADR, or
commit that backs it. Where a result says "100% of defined tests pass,"
that is a statement about the tests that were written and run — it is not
a claim that the system is free of bugs, and the Known Limitations section
below is exactly the list of things this report does *not* claim to have
proven. Anywhere those two could be confused, this report says so
explicitly rather than leaving it to a reader's optimism.

## Upstream revision

Pinned baseline: **NanoClaw v2.3.0, commit `54d9d9a5`** (`docs/baseline.md`,
P0-07). `go-host/docs/version-compatibility.md` documents the consumed-
contract boundary and drift policy; `go-host/docs/ADR-017-p9-07-upstream-
overlap-review.md` (2026-09-03) confirmed this pin already includes the
storage-neutral-registry/session-driver-seam work a Discord founder reply
had flagged as possibly-drifted, so no drift was found at that review. A
weekly `upstream-watch` CI job (P9-05) checks for a newer upstream release
and flags it for human review; it does not auto-merge or auto-adapt
anything.

## Contract pass count

`docs/baseline.md`'s P0-09 baseline, re-confirmed unchanged through every
phase of this project: **1991 of 2006** vitest tests passing at the pinned
checkout, with **15 known, documented, non-regressed failures** confined to
two files, root cause not chased (a deliberate P0-09 scoping decision:
"record baseline, don't fix yet"). A release is blocked only if a release
candidate shows *more* than these 15 documented failures — the 15
themselves are not a blocker. This project's own `go-host` test suite is
reported separately below since it is new code, not a baseline
comparison.

CI status as of 2026-09-04 (first fully green run since this project's Go
work started): the required `go-host` job (`gofmt`/`vet`/`build`/`test`/
`test -race` across every package) passes; `go-lint` (golangci-lint)
reports 0 issues; `go-vulncheck` reports no known vulnerabilities;
`semgrep` reports 0 findings in `go-host/` (148 pre-existing findings in
`src/` are scoped out as a separate, dated, tracked follow-up — not part of
this kernel's own surface); all 6 `go-fuzz-smoke` jobs pass; both
TypeScript `test` matrix jobs (format/lint/tsc/vitest/bun test) are clean.

## Customization score

P6-05's preservation gate: **≥90%** of the 20-scenario customization
catalogue (P6-01) passes unchanged against this project's kernel-mediated
path, as of Phase 6's close-out. Not re-run during Phase 9/10, since that
work touched no TypeScript customization surface — re-running this gate
against an actual release candidate (not assumed current from Phase 6)
remains an explicit, named item in `docs/release-gate-checklist.md` before
each release, the same as it always has been.

## Security invariant results

**EC-05 — adversarial pass** (`go-host/docs/ADR-018-p9-ec05-adversarial-
pass-findings.md`): 16 tests against the real kernel enforcement path
(`k.Dispatch`) — 14 in-process, 2 live-verified against a real Docker
daemon. Three of the four named threat-model misuse cases (root `runAs`,
forged/path-traversal/NUL-byte session and agent-group IDs, a malformed
`build_image` `groupFolder`) are confirmed denied before exec, both
in-process and live. **The fourth is a real, confirmed, live-verified
gap in the *default configuration*, not the underlying mechanism**:
`mount.Policy.AllowlistedExtraCheck` defaults to `nil` unless `nanogo
serve` is started with `-allowlist`, so with no allowlist configured, any
host path a caller labels `allowlisted-extra` — including the Docker
socket — is unconditionally trusted. Confirmed live via a real `docker
create` + `docker inspect` showing the host's Docker socket actually
bind-mounted into a container under this condition. The allowlist hook
itself works correctly once an operator configures it (confirmed by the
paired control test, in-process and live). **Follow-up, done**: `nanogo
serve` and the standalone `security-check` subcommand each emit a loud,
specific warning when invoked without `-allowlist` (commit `56a4c8f1`).
`doctor` has no allowlist-related check at all (its five checks are
container runtime, agent image, central DB/mailboxes, credential
provider, and the kernel socket boundary; confirmed by reading
`internal/doctor/doctor.go` and by a live `doctor` run showing exactly
those five, none of them about mounts). **Superseded for the normal
install path by Phase 11**: `src/modules/kernel-supervisor/index.ts`
(P10-01) always launches `nanogo serve` with `-allowlist` pointing at
`MOUNT_ALLOWLIST_PATH`, so this warning never fires for a host started
the sanctioned way. Instead, `mount.CheckAllowlistedExtra` fails closed
against a missing or unconfigured allowlist file (denies every
`allowlisted-extra` mount, per its own doc comment), which is a
*stricter* out-of-the-box default than this report originally described.
Confirmed live, 2026-09-05: a fresh install with no
`~/.config/nanoclaw/mount-allowlist.json` produced no warning anywhere in
the startup log or in `doctor`'s output. `security-check -allowlist
<path>` remains the tool for auditing that file's own contents once an
operator creates one — see the Known Limitations entry below for what
this does and does not change about the underlying default.

**EC-06 — protocol integration and live smoke test** (`go-host/docs/
ADR-019-p9-ec06-live-smoke-findings.md`): a real, ordinary wake → message
round trip → kill, run entirely through a real `nanogo serve` process's
Unix socket (not a route that bypasses the kernel, unlike the pre-EC-02
harnesses this superseded). Confirmed live on a real Mac, 2026-09-05: 2/2
repeats passed, kernel-derived container names, a real Docker daemon, the
real unmodified agent-runner image, fully kernel-mediated cleanup. This
proves day-to-day *correctness* of the kernel-mediated path; it is
complementary to, not a substitute for, EC-05's adversarial focus.

**Fuzzing** (P9-02): 5 targets — `mount.ValidateSpec`, `ownership
.ValidateID`/`SafeMailboxPath`, `containerdefaults.EnforceSafeDefaults`,
`guardpolicy.DecideRestartLike`, `kernel.Dispatch` — all confirmed passing
on the real Mac (2M+ executions with zero failures for the four run
locally; `FuzzDispatch` written blind in the sandbox and confirmed on its
first real execution). **One real, confirmed, fixed security bug found
this way**: `ownership.SafeMailboxPath` did not validate its `side`
parameter before joining it into a path, allowing traversal. This was
confirmed exploitable in an isolated module, confirmed zero production
callers, and fixed with a validation check plus a regression test
(`internal/ownership/ownership.go`, part of commit `f32f890a`).

**Crash/restart and malformed-state tests** (P9-03/P9-04): a kernel
restart loses its in-memory session registry by design (`internal/
lifecycle.Registry` is purely in-memory) — this is what makes the TS
client's `unknown-session` local-fallback path (EC-02) reachable in
practice, not theoretical. A duplicate `kill` after a session is already
finished fails closed rather than double-executing. A DB lookup failure
during guard evaluation surfaces as an explicit error, never a silent
allow. All confirmed on the real Mac with zero fixes needed once run for
real.

## Known limitations (stated plainly, not silently accepted)

- **Capability scoping and credential brokering are not adopted for v1**
  (EC-01, `ADR-014-p9-ec01-phase8-disposition.md`). `internal/capability`
  and `internal/credentialbroker` are designed, prototyped, and tested in
  isolation — not wired into the enforcement path. `internal/kernel` ships
  its original three capabilities only (`container.wake`, `container
  .build_image`, `container.kill`). Tracked as a v1.1+ roadmap item, not a
  v1 claim.
- **The enforcement boundary is deliberately narrow** (EC-02, `ADR-016-p9-
  ec02-narrow-enforcement-boundary.md`): the kernel is the sole path for
  `docker create`/`stop`+`rm`/`build` only. Discovery (`listSessions`/
  `watchSessions`/`reapResidue`), attach-based supervision, and `exec` stay
  TypeScript-only by design, because none of them make an admission
  decision.
- **Guard-catalog coverage is intentionally partial** (EC-04, `ADR-015-p9-
  ec04-kernel-side-guard-verification.md`): only the self-mod `install_
  packages`/`add_mcp_server` checks and the CLI-derived `restart` guard are
  independently re-verified by the kernel itself, from its own DB read —
  the other ~40 guard-catalog fixtures remain permanently TS-only, by
  design. **Actor identity itself is not independently verified**: the
  kernel trusts the TS host process as the sole terminus of every
  per-container connection, with no independent channel to confirm "which
  agent group is really asking." This is an accepted, documented v1 limit,
  not an oversight.
- **The `allowlisted-extra` mount class's safety depends on how `nanogo
  serve` is started** (EC-05/ADR-018, revised by Phase 11's P10-01). A
  bare `nanogo serve` invocation with no `-allowlist` flag trusts every
  `allowlisted-extra` mount unconditionally, and `serve` and the
  standalone `security-check` subcommand each warn loudly about exactly
  that when invoked without one (`doctor` has no allowlist check at
  all — see the EC-05 section above). **But the normal install path
  never hits this case**: `src/modules/kernel-supervisor/index.ts`
  always launches `nanogo serve` with `-allowlist` pointing at
  `MOUNT_ALLOWLIST_PATH`, so a host started the sanctioned way instead
  gets `mount.CheckAllowlistedExtra`'s fail-closed behavior against
  whatever that file currently contains — denying every
  `allowlisted-extra` mount until an operator populates
  `~/.config/nanoclaw/mount-allowlist.json` (the same file
  `mount-security`'s TS module already manages), not trusting them.
  Confirmed live, 2026-09-05, against a fresh install with no allowlist
  file configured yet.
- **EC-06's live-smoke evidence has a stated scope boundary**
  (`ADR-019`): it covers the kernel-mediated wake/message/kill path
  specifically. It does not cover a real Slack/Discord/CLI channel
  adapter round trip (TS-host routing, deliberately out of scope, same
  boundary P3-06 drew) or a real, non-deterministic Claude Agent SDK reply
  (P3-04 already covers that, pre-EC-02, manually, once). Nor is it
  (yet) wired into CI — it needs a previously-built agent-runner image and
  scaffolding a CI runner doesn't have; `docs/release-gate-checklist.md`
  treats it as a manual re-run before each release, matching that
  checklist's own existing language for both the rows it closes.
- **Duplicate-wake idempotency is unsupported** and a non-default
  `DbDriver` storage backend is unsupported (`go-host/docs/compatibility-
  matrix.md`, P9-09) — both documented, not hardened.
- **SQLite cross-driver file compatibility is Preview/Pending**: whether
  this project's `modernc.org/sqlite` (an independent Go reimplementation)
  can read a `data/v2.db` written by upstream's Node-22 `better-sqlite3`
  upgrade has not been checked against a real file (`ADR-017`).
- **No macOS notarization** (`ADR-020-p10-01-minimum-trust-install.md`):
  this project has no paid Apple Developer account. A binary installed via
  `go-host/scripts/install.sh`'s download path has its Gatekeeper
  quarantine flag cleared automatically, but only after that script
  verifies the binary's checksum against the release's own published
  `SHA256SUMS` — see `go-host/docs/release-verification.md`.
- **Only the kernel-mediated Go-side path has this level of adversarial
  testing.** Upstream NanoClaw's own TypeScript security surface
  (guard.ts's ~40 TS-only fixtures, channel-adapter input handling, etc.)
  is covered by upstream's own test suite and this project's contract
  tests, not by EC-05's kernel-specific adversarial pass.

## What "100% of defined tests pass" means here, concretely

It means: every test named above ran, for real, against the real code, and
passed — not simulated, not assumed, not skipped and reported clean. It
does **not** mean: that no bug remains in the roughly 8,700 lines of new Go
across `go-host/internal/` and `go-host/cmd/`, that the TypeScript↔Go wire
protocol has been fuzzed for malformed NDJSON framing beyond `FuzzDispatch`'s
payload-level coverage, that every combination of concurrent `wake`/`kill`
requests has been raced against each other beyond what `-race` catches in
the existing test suite, or that a determined attacker with a different
threat model than the ones EC-05 named would find nothing. The Known
Limitations section above is this report's honest attempt to name what is
*known* not to be covered; it cannot, by definition, name what nobody has
found yet.

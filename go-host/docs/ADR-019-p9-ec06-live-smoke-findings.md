# ADR-019: Phase 9 EC-06 — Post-EC-02 Protocol Integration and Live Smoke Test

Status: accepted, 2026-09-05.

## Context

`docs/release-gate-checklist.md` names two gates as BLOCKERs for a real v1
release, distinct from EC-05's adversarial/security pass:

- **Row 5 (protocol integration)** — "Go inbound → real agent-runner → Go
  outbound end to end." The closest existing evidence before this work was
  `scripts/p3-04-launch.sh` (P3-04, one manual round trip against a real
  Claude reply) and `scripts/p3-06-e2e.sh` (P3-06, a deterministic,
  repeatable version of the same round trip). Both were written **before EC-02
  existed**, so both still issue `docker create`/`docker start` themselves —
  exactly the enforcement gap EC-02 closed in the running system.
  `container-runner.ts` no longer calls Docker directly at all. A proof
  harness that still does is no longer proving what the system actually
  does.
- **Row 11 (live smoke tests)** — "no CI job stands up a real container +
  real provider + a real test channel ... must be run against the actual
  release candidate, with the Go kernel in the live path ... has not
  happened since EC-02 landed."

EC-05 (ADR-018) already proved the kernel's *security* properties hold
against a real Docker daemon (the mount-allowlist default-gap finding). It
did not exercise the kernel's *day-to-day correctness* — an ordinary
wake → message round trip → kill, the thing the kernel does on every single
real session, end to end, for real.

## What was built

- **`go-host/cmd/livesmoke`** — a throwaway, NDJSON wire-protocol client
  (deliberately *not* a `nanogo` subcommand — see its own doc comment for
  why). It reads one `kernel.Envelope` as JSON from stdin, dials the real
  kernel Unix socket, sends it as one NDJSON line, and prints the raw
  response — the exact mechanism `cmd/nanogo/serve_test.go`'s own
  `TestServe_EndToEndRoundTripOverRealSocket` already proved in-process,
  generalized so a shell harness can drive it from outside the process.
- **`scripts/ec06-live-smoke.sh`** — starts a real, long-lived `nanogo
  serve` process (real Unix socket, real `-allowlist`, real
  `-surface-root`). For each of 2 repeats, it prepares the mailbox
  (`-prepare-outbound`, `-write-chat`, both unchanged from P3-03/P3-06),
  builds a full, realistic `mount.Session` (the same mount classes and
  fields a production session actually carries: `group-state` for the
  workspace/group/context/`.claude-shared` mounts, `install-surface` for
  `plugins`/agent-runner `src`/`skills`/`CLAUDE.md`), and dispatches
  `container.wake` through the real kernel socket via `livesmoke`. It never
  computes or asserts the resulting container's name — it reads
  `payload.containerName` back from the kernel's own response, which is
  exactly the property EC-02 exists to guarantee
  (`ContainerName(spec.Key)`, derived by the kernel itself). It then polls
  for the reply via `-read-outbound`, dispatches `container.kill` through
  the same socket, and confirms via `docker inspect` that the container is
  actually gone afterward.

The mailbox protocol and the deterministic-provider trick are **reused
unchanged from P3-06** (`scripts/p3-06-mock-provider.ts`, the same fixed
`isError:true` reply routed through `poll-loop.ts`'s
`deliverErrorResult`) — this proof deliberately isolates the one thing that
actually changed since P3-06 was written: who issues `docker
create`/`start`/`stop`/`rm`, and under what name.

## Evidence

Run against `nanoclaw-agent-v2-6ecff360` (the real, unmodified image
`nanoclaw.sh` built), real Docker Desktop, on the user's Mac, 2026-09-05.
Both repeats passed with byte-identical `kind`/`content`:

```
-- container.wake (dialing the real kernel socket via livesmoke) --
{"version":"v1","requestId":"ec06-wake-sess-ec06-1788568151-4634-1","ok":true,
 "payload":{"allowed":true,
   "containerId":"5ba6b53dc3d8cd5594a34943b2145ac0a7f8fc520aca02cf305dc1c32af1c0be",
   "containerName":"ncl-ec06-livesmoke-sess-ec06-1788568151-4634-1"}}
kernel-derived container name: ncl-ec06-livesmoke-sess-ec06-1788568151-4634-1

-- polling for a reply via nanogo -read-outbound (up to 30s) --
seq=3 id=msg-1788568154243-oxoylc kind=chat content={"text":"p3-06: deterministic reply from the fake provider"}

-- container.kill (dialing the real kernel socket via livesmoke) --
{"version":"v1","requestId":"ec06-kill-sess-ec06-1788568151-4634-1","ok":true,"payload":{"allowed":true}}
confirmed: ncl-ec06-livesmoke-sess-ec06-1788568151-4634-1 no longer exists after container.kill

== run 1 passed (kernel-mediated wake -> real reply -> kernel-mediated kill) ==
```

Run 2 (a fresh session against the **same still-running** `nanogo serve`
process, no restart in between) produced the identical `kind`/`content`,
confirming the kernel's in-process session registry correctly handles
repeated independent lifecycles without needing a restart between them —
the complementary case to P9-03's crash/restart tests, which prove behavior
*across* a restart rather than within one process's lifetime.

```
== summary: 2/2 run(s) passed, fully kernel-mediated, byte-identical kind/content ==
-- stopping nanogo serve (pid 4658) --
```

## Bugs found and fixed during this work

Recorded plainly, matching ADR-018's own discipline of naming what this
pass itself surfaced rather than only what it set out to prove:

1. **A `set -e` trap that would have turned an expected denial into a fatal
   script abort.** Bash aborts immediately on a bare `VAR="$(cmd)"` whose
   command fails, even though the very next line was meant to inspect that
   failure. This was caught and fixed during self-testing (before any Mac run) by
   empirically confirming the behavior with a throwaway repro, then
   rewriting both the `container.wake` and `container.kill` response
   captures as the condition of an `if`, which correctly exempts them from
   `set -e`.
2. **A cleanup-trap-ordering bug that would have orphaned `nanogo serve`.**
   `trap - EXIT` clears a trap slot entirely rather than restoring
   whatever was active before it, so the run-loop's per-iteration
   `cleanup_run` trap would have permanently shadowed the outer
   `cleanup_all` trap (the one that actually stops the kernel process). This was
   caught during self-testing by tracing the trap-swap sequence and
   confirmed with a standalone repro before delivery, then fixed by explicitly
   re-arming `cleanup_all` once the run loop finishes.
3. **A live bug that only surfaced on the real Mac.** The
   `container.kill` envelope's `EC06_SESSION_ID="$SESSION_ID"` assignment
   was placed *after* the `python3 -c '...'` invocation instead of before
   it. Bash only exports an assignment as an environment variable for a
   command when it precedes that command; placed after, it becomes a
   positional argument instead, and `os.environ` never saw it
   (`KeyError: 'EC06_SESSION_ID'`). This one was **not** caught in the
   cloud sandbox, because the sandbox has no real Docker daemon: the
   `container.wake` request there gets validated correctly and reaches a
   real `docker create` call, but fails at that final step for lack of a
   daemon. So the harness never got far enough to also exercise the
   `container.kill` path against a real, live container the way a real Mac
   run does. This is worth naming as a small methodological finding of its
   own: sandbox self-testing caught 2 of 3 bugs before ever reaching a
   real machine. The one bug whose own trigger condition depends on a
   real Docker daemon genuinely could not be caught there — which is
   exactly the gap live smoke testing exists to close, not a shortfall in
   the self-testing discipline itself.

## Scope — what this does not cover

- **No real channel/routing round trip.** This proof, like P3-06 before
  it, stays entirely inside the mailbox protocol — no Slack/Discord/CLI
  channel adapter is exercised. That is TypeScript-host routing
  infrastructure, deliberately out of scope here (see P3-06's own header
  comment for the same boundary).
- **A deterministic mock provider, not a real Claude Agent SDK call.**
  P3-04 already proved real-Claude interop once, manually, pre-EC-02; this
  proof's point is exact repeatability of the kernel-mediated lifecycle
  itself, which a real (non-deterministic) LLM reply cannot cleanly assert
  on. The two proofs are complementary.
- **Not (yet) wired into CI.** Unlike EC-05's two live-Docker tests (which
  run on GitHub-hosted runners' pre-installed Docker daemon with no other
  dependencies), this proof needs the `ping_test` group's real, previously
  built agent-runner image and its scaffolding to exist on the machine
  running it. That is infrastructure a CI runner does not have, and building it
  fresh in CI is a materially larger, separate task. This matches
  `release-gate-checklist.md`'s own existing language for both rows 5 and
  11 ("must be re-run manually before each release" / "must be run against
  the actual release candidate") — this script is that manual re-run,
  not a new automated gate.

## Recommendation

`docs/release-gate-checklist.md` rows 5 and 11 should be updated from open
BLOCKER to closed-with-evidence, citing this ADR and `scripts/
ec06-live-smoke.sh` as the concrete artifact to re-run before each future
release. With this closed, no named blocker remains from Phase 9's revised
scope (EC-01 through EC-05, ADR-018's own follow-up, and this EC-06 work).
Every gap the Phase 5 readiness review and the Phase 6/7/8 close-outs
named for the enforcement boundary itself is now closed, live-verified, or
explicitly and honestly scoped as a documented v1 limit.

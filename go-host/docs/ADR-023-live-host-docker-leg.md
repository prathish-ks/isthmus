# ADR-023: EC-07 — the live-Docker leg, with the TypeScript host in front

Status: accepted, 2026-09-19. Verified live on the user's Mac the same day
(2/2 repeats — see Evidence below).

## Context

Three proofs already exist for pieces of one path, and each names the
boundary it stops at.

`scripts/ec06-live-smoke.sh` (ADR-019) is live and real below the kernel: a
long-lived `nanogo serve`, a real Docker daemon, the real unmodified
agent-runner image, a real round trip, container lifecycle fully
kernel-mediated. Its own header states what it does not attempt — "a real
Slack/Discord/CLI channel adapter round trip ... is TypeScript-host
routing/channel infrastructure this proof's scope deliberately does not
touch." It drives the kernel by speaking the NDJSON wire protocol itself,
from a shell script, through `go-host/cmd/livesmoke`.

`src/cli-channel-kernel-smoke.test.ts` (ADR-022) is real above the kernel,
on every PR: a line typed at the real CLI adapter's real Unix socket, the
real router, real session resolution, real `inbound.db`/`outbound.db`, the
real composition path, the real `DockerSessionDriver` including
`validateSpec`, the real `KernelClient`, a real NDJSON round trip. Its own
header states what it does not attempt — "No container is created, no
agent-runner image runs, no provider replies."

`go-ec05-live-docker` and `go-egress-live-docker` run live against a real
daemon on CI, but from inside the Go kernel's own test binary; no host, no
image, no mailbox.

So the two halves are each proven, and the join is not. Nobody has ever run
the whole path automatically. EC-06 has only ever been a manual re-run on
one Mac, which `docs/release-gate-checklist.md` rows 5 and 11 both say
plainly.

## Decision

Add EC-07: one harness that runs the joined path live, and a report-only CI
job that runs the harness.

- **`scripts/ec07-live-host-smoke.ts`** — the proof. Mirrors `src/index.ts`'s
  own startup order (central DB → adapters → delivery bridge →
  `startHostModules` → delivery polls), seeds exactly what
  `scripts/init-cli-agent.ts` seeds for a CLI-wired agent, then connects to
  the CLI adapter's real Unix socket, writes one line, and waits for the
  reply on the same socket. Nothing in the host is faked. The kernel is a
  real `nanogo serve`, spawned by the real kernel supervisor through the
  same `onHostStart` registration a production host uses — not started by
  hand in another terminal, the way every live run before ADR-020 was.
- **`container/agent-runner/src/providers/livesmoke.ts`** — a deterministic
  provider, in the tree and NOT in the barrel, exactly like `mock.ts` beside
  it.
- **`scripts/ec07-live-host-smoke.sh`** — the wrapper: builds `nanogo` where
  the supervisor looks for it, appends the one barrel import that installs
  the provider, runs the harness, and removes both the import and the
  scratch install on every exit path.
- **`live-host-docker`** in `.github/workflows/ci.yml` — report-only
  (`continue-on-error: true`, outside the `ci` gate's `needs:`), on
  `schedule` + `workflow_dispatch`.

## Evidence

Run on the user's Mac against Docker Desktop, 2026-09-19, image
`nanoclaw-agent-v2-423e35f7:latest` built from this checkout. 2/2 repeats
passed against one long-lived host process; both round trips completed in
about six and three seconds respectively, the whole two-repeat run in
thirteen seconds after host start.

```
[23:42:23.350] INFO nanogo serve is listening socket=".../data/nanogo-kernel.sock" pid=61766
host is up (cli adapter listening, nanogo serve supervised, delivery polling)

---- run 1/2 ----
[23:42:23.428] INFO Session created id="sess-1789825343406-zs0z46" ...
[23:42:23.465] INFO Spawning session containerName="nanoclaw-v2-ec07-livesmoke-1789825343464"
kernel-derived container name : ncl-423e35f7-sess-1789825343406-zs0z46
host's predicted name (label) : nanoclaw-v2-ec07-livesmoke-1789825343464
[23:42:29.390] INFO Message delivered channelType="cli" platformId="local"
reply: {"text":"ec07: deterministic reply from the live-smoke provider"}
confirmed: ncl-423e35f7-sess-1789825343406-zs0z46 is gone after a kernel-mediated kill
== run 1 passed ==
```

Run 2 woke the same session (`created=false`, `session_mode: 'shared'`) and
produced a second, different host-predicted name —
`nanoclaw-v2-ec07-livesmoke-1789825350358` — against the **same**
kernel-derived name, `ncl-423e35f7-sess-1789825343406-zs0z46`.

That pair was not designed for; it fell out of the first green run, and it
is a stronger statement of EC-02's property than the assertion this harness
originally carried. The host's name embeds `Date.now()`, so it is necessarily
different on every wake. `ContainerName(spec.Key)` is a pure function of the
session key, so it is necessarily identical. Two wakes of one session
therefore have to produce one stable kernel name and two different host
names — a much harder thing to satisfy by accident than "these two strings
differ", and a shape a host that had smuggled its own name through could not
produce. The harness now asserts it.

## Bugs found during this work

Recorded plainly, matching ADR-018's and ADR-019's own discipline of naming
what the pass itself surfaced rather than only what it set out to prove. All
three are in the harness, not the product — which is the correct place for a
first live run to fail.

1. **The harness ran a subset of the host's imports that merely looked
   sufficient.** It imported the kernel supervisor directly and skipped
   `src/modules/index.ts`, not knowing that barrel is the only path to
   `src/mailbox/compose.ts`, the singular mailbox composition slot. The host
   came up, the kernel came up, the CLI socket accepted the line, and
   `getAgentMailbox()` threw "No agent mailbox registered" the moment the
   router tried to create a session. The file even carried a comment
   asserting the supervisor was the only module needed. Fixed by importing
   the barrel, as `src/index.ts` does — the general lesson being that a
   harness claiming "the real host in front" should run the host's own
   imports rather than a reasoned-about subset.
2. **A routing failure could only ever surface as a timeout.** The host
   routes on a floating promise (`void routeInbound(...)`, with a `.catch`
   that only logs — `src/index.ts` does the same), so bug 1 above was
   visible in the log four milliseconds in while the harness went on to
   spend its full 120-second budget waiting for a container that could not
   exist. Fixed with an `unhandledRejection` latch that every wait checks
   first, so a run now fails with the host's own error instead of a
   stopwatch. Reset per repeat, so one bad run does not decide the next.
3. **A passing run printed an error.** `execFileSync` inherits stderr by
   default, and two `docker inspect` calls here are *expected* to fail — the
   preflight's image check, and the check that confirms the container is gone
   after the kill. So a green run printed "Error: No such object: ncl-..."
   immediately above "confirmed: ... is gone". Cosmetic, but this is a proof
   whose whole job is to be read.

## Why the provider is installed rather than shipped

`composeSessionSpec` hard-codes the container's command — `exec bun run
/app/src/index.ts` — and no container-config knob changes it. That is
deliberate: the command is part of what the kernel admits. EC-06 could
substitute a provider only because its harness issued `docker create`
itself and overrode the entrypoint; with the host in front, that seam is
gone by design.

So the provider has to arrive the way a real provider arrives: through
`providers/index.ts`, the self-registration barrel that `/add-opencode` also
appends to. Three shapes were considered.

**Ship it in the barrel.** Rejected: a production image built from this
checkout would then carry a reachable fake provider that any group's
`container.json` could select. In a project whose whole subject is what the
container is allowed to be, that is not a small thing.

**Ship it behind an env-var gate in the barrel.** Rejected for the same
reason, one level down: it ships the same reachability, with the switch in
the environment rather than in a file, and adds a branch to a barrel whose
only job is to be a list.

**Install it for the run and remove it afterwards.** Chosen. The file exists
in the tree — reviewable, type-checked, formatted, linted like everything
else — and is dead code in every image until something imports it. The
wrapper's trap removes the import on failure and on Ctrl-C, and the harness
refuses to start if the line is already there, because a leftover one means
a previous run died without its trap and the next reader deserves to be told
that rather than to inherit it.

## Why not a vitest test

`src/cli-channel-kernel-smoke.test.ts` mocks `config.js` to move `DATA_DIR`
into `/tmp`, which is right for a test that must never touch a running
install. It cannot be right here: the kernel's own policy roots
(`GroupsRoot`, `DataRoot`) are derived from the same two paths and handed to
`nanogo serve` through its `-config` file, so a mocked `config.js` would put
the host and the kernel in different worlds and every mount would be denied
for a reason that has nothing to do with the code under test.

The harness therefore runs from the checkout, against the checkout's own
`data/` and `groups/` — and refuses outright if `data/v2.db` already exists,
because that is what a real install looks like and this thing seeds its own
agent group, messaging group and wiring. It also needs minutes, a daemon and
an image, none of which belong in the `test` job. Same posture as
`ec06-live-smoke.sh`: a harness you run, plus a job that runs it for you.

## What this proves that nothing else does

- A message crosses **every** seam in one run: CLI socket → router →
  session → `inbound.db` → `wakeContainer` → `DockerSessionDriver` →
  `KernelClient` → real Unix socket → real `nanogo serve` → real `docker
  create`/`start` → real agent-runner → `outbound.db` → delivery poll → the
  same CLI socket.
- The kernel supervisor is in the path. Every live run before this one
  started `nanogo serve` by hand; ADR-020 built the supervisor, and nothing
  until now exercised it against a real daemon with a real wake behind it.
- **EC-02's naming property, observed against a real container.** The
  harness reads the live container's actual name from `docker ps` and the
  host's own predicted name from that container's `nanoclaw-container-name`
  label, asserts the shape of each, asserts they differ, and — across the two
  repeats, which share one session — asserts that the kernel's name held
  still while the host's changed. ADR-022's in-process test asserts the first
  half of this against a fake kernel that was told what to answer; this one
  asserts all of it against `internal/kernel/naming.go` doing the deriving.
- The teardown is kernel-mediated too: `killContainer` → `container.kill` →
  the daemon no longer has the container, confirmed by `docker inspect`.

## What this deliberately does not do

**It does not exercise the `<message to="...">` delivery path.** The
deterministic provider returns `isError: true` with zero message blocks,
which routes through `poll-loop.ts`'s `deliverErrorResult` — the one path
that needs no row in the session's `destinations` table. Destinations are
written by the agent-to-agent module only when an operator has added them
(`ncl destinations add`), so requiring one would make this proof depend on
operator state a fresh install does not have. This is the same path EC-06
used and the same path that produced P3-04's real observed Claude reply, so
it is a real path — but the formatter's destination resolution is not in
this run, and a future EC-07b that seeds a destination row would close that.

**It does not use a real model.** Same reason EC-06 did not: a
non-deterministic reply cannot be asserted on, and P3-04 already proved
real-Claude interop once, manually. The two proofs stay complementary.

**It does not run on every PR.** The image build is apt + chromium + bun +
pnpm globals. The host half of this path is already covered per-PR by
`src/cli-channel-kernel-smoke.test.ts` inside the required `test` job, and
the kernel half by `go-ec05-live-docker`; what was missing was that the
joined path had no automation at all, and weekly plus on-demand closes that
without taxing every PR. If the drift this job catches turns out to be
frequent enough to want per-PR coverage, the honest fix is a cached image
build, not a quieter job.

**Its CI timing is unmeasured.** The one real data point is local: a cold
`./container/build.sh` on an M-series MacBook Air took **757 seconds**, of
which 367 was the image export and unpack alone. The round trips themselves
are cheap by comparison — thirteen seconds for both repeats. So the job's
cost is the image, as predicted, and a GitHub-hosted runner is not a
MacBook; the first scheduled run is the first real measurement. The job
carries a deliberately generous `timeout-minutes: 45` rather than a
guessed-tight one, in the same "correct by careful reading, confirmed on
real infrastructure" posture this file's neighbours already take for
`govulncheck`, `semgrep` and `upstream-watch`.

**It does not replace `ec06-live-smoke.sh`.** That harness drives the kernel
directly, with no host in the way, which is what makes it the right tool
when the question is about the kernel rather than about the path. Both stay.

## Consequences

`docs/release-gate-checklist.md` rows 5 and 11 gain a second, automatable
piece of evidence: "re-run `ec06-live-smoke.sh` manually" becomes "dispatch
`live-host-docker` against the release candidate, and re-run
`ec06-live-smoke.sh` if the kernel itself is what changed."

The backlog item this closes is 13b, the live-Docker leg ADR-022 deferred.

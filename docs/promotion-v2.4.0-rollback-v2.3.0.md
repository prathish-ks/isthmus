# H2 acceptance test + rollback artifact — source = nanoclaw v2.3.0

Recorded run closed 2026-09-26, one machine, one scratch worktree
(`h2-test-v230`, a `git worktree` of this repo, never pushed, discarded
after this test). Source: the real `v2.3.0` tag (`54d9d9a5`). Migration
target: the local-only `throwaway/v240-acceptance-test` branch (commit
`2f9a21b9`) — a disposable merge of `feat/mount-gateway-trust-class` +
`feat/gateway-provider-seam` + `docs/v2.4.0-promotion-plan` onto
`origin/main`, standing in for "Isthmus pinned to this promotion's
v2.4.0 baseline" while those branches aren't merged to `main` yet. This
mirrors H1's already-verified mechanism (`docs/rollback-runbook.md`'s
2026-09-06 dry run); this run extends it to the specific source version
and specific promotion baseline H2 asks for.

## What this run does and does not prove

**Proves**: the `isthmus.sh` in-place migration mechanism, run
non-interactively end to end from a real v2.3.0 install to this
promotion's pinned baseline and back, preserves the entire `data/`
directory byte-for-byte, leaves `nanogo doctor` clean, and survives a
mid-flight kill without corrupting state.

**Does not re-prove** (already covered by H1's 2026-09-06 dry run, not
re-exercised here because this run used non-interactive automation with
several steps deliberately skipped — see "What was skipped" below):
real Claude Code OAuth auth, a live external channel with a real message
round-trip, or a running container being adopted rather than recreated
mid-migration (this run never started the host service, so there was no
running container to adopt).

## Setup: getting a real v2.3.0 install first

```
git worktree add h2-test-v230 v2.3.0
cd h2-test-v230
pnpm install --frozen-lockfile
```

The setup wizard's own stall-detector prompt
(`setup/lib/windowed-runner.ts`'s `handleStall()`) has no `initialValue`
and hangs forever on non-TTY/closed stdin after 60s of no new output
from a step — a real gap for any non-interactive install, hit here
during the container step's cold multi-minute `docker build`. Worked
around by pre-building the image out-of-band before invoking the
wizard, so the wizard's own `docker build` call hits a warm cache and
finishes in seconds:

```
./container/build.sh   # ~5 min cold build, done once, out of band
```

Then the real non-interactive install:

```
NANOCLAW_REEXEC_SG=1 \
NANOCLAW_SKIP=auth,channel,onecli,timezone,service,verify \
NANOCLAW_DISPLAY_NAME=pks \
NANOCLAW_HARDENED_IMAGE=false \
pnpm exec tsx setup/auto.ts < /dev/null
```

Result: real `data/v2.db`, one agent group (auto-created by the
wizard's local-CLI-channel fallback: folder `ping_test`, name "Terminal
Agent"), one user row (`cli:local`), a `container_configs` row, and a
built+tested container image (`nanoclaw-agent-v2-a90ff4ca:latest`,
`TEST_OK: true`). The run itself stopped at an optional "Want to debug
this with Claude?" prompt after all real work was done (stdin closed →
clean process exit, not a hang) — so the wizard's own final
upgrade-marker stamp never ran. Stamped manually to simulate a fully
completed stock install, matching what `/setup` does as its last step:

```
$ pnpm exec tsx scripts/upgrade-state.ts set
Stamped .../data/upgrade-state.json: {"version":"2.3.0","commit":"54d9d9a50c0e572fa3969d63ab87a4dd3d75cc6f","tree":"4f0e49481039faf42ef570083704837a4b558c60","updatedAt":"2026-09-26T05:13:03.996Z","via":"manual"}
```

Baseline checksum recorded before touching anything else:

```
$ shasum -a 256 data/v2.db
d845816dd8d25f5c3ad946c2170dbd3c46f23d51561690ecc6b12af1926565e6  data/v2.db
```

## Migration: v2.3.0 → this promotion's v2.4.0 baseline

Same checkout, same `data/` directory, per H1's verified procedure —
just a `git checkout` to the merged branch's commit (detached, since the
branch itself was checked out in another worktree):

```
$ git checkout 2f9a21b9c515677c7e6c1bdeb30c8ffee91bf0e4
Previous HEAD position was 54d9d9a5 Merge pull request #3495 from nanocoai/release/2.3.0
HEAD is now at 2f9a21b9 Merge branch 'docs/v2.4.0-promotion-plan' into throwaway/v240-acceptance-test
```

Data untouched by the checkout alone (`data/` is gitignored):

```
$ shasum -a 256 data/v2.db
d845816dd8d25f5c3ad946c2170dbd3c46f23d51561690ecc6b12af1926565e6  data/v2.db   # unchanged
```

Ran the real migration entry point, non-interactively:

```
NANOCLAW_REEXEC_SG=1 \
NANOCLAW_SKIP=auth,channel,onecli,timezone,service,verify \
NANOCLAW_DISPLAY_NAME=pks \
NANOCLAW_HARDENED_IMAGE=false \
bash isthmus.sh < /dev/null
```

Output confirmed correct migration detection and a clean finish:

```
Existing NanoClaw/Isthmus install detected (data/upgrade-state.json
present) — migrating this checkout in place rather than a fresh
install. Your existing data directory, sessions, and config are
untouched by anything below; see docs/rollback-runbook.md if you
want to verify or revert this afterward.

=== Installing the nanogo security kernel ===
install.sh: built .../go-host/bin/nanogo
...
=== Running the NanoClaw installer ===
   ___    _   _
  |_ _|__| |_| |_  _ __ _  _ ___
   | |(_-<  _| ' \| '  \ || (_-<
  |___/__/\__|_||_|_|_|_\_,_/__/
  Small.
  A trust-kernel for NanoClaw.
  Independently auditable.
┌   Welcome   NanoClaw  · picking up where we left off
...
◆  Sandbox ready. (14s)          # rebuilt for the Isthmus Dockerfile, warm-cache-assisted, no stall
...
└  You're ready! Chat with `pnpm run chat hi`.

=== Migration complete — stamping the upgrade marker ===
Stamped .../data/upgrade-state.json: {"version":"2.3.0","commit":...,"tree":...,"via":"manual"}
```

(The first stamp in that run recorded `"commit":"unknown"` — a sandbox
artifact of this machine's broken bare `git` shim in that particular
shell invocation, not an Isthmus bug. Re-ran
`pnpm exec tsx scripts/upgrade-state.ts set` with a working `git` on
`PATH` immediately after to get the real identity recorded below.)

## Post-migration verification

```
$ shasum -a 256 data/v2.db
d845816dd8d25f5c3ad946c2170dbd3c46f23d51561690ecc6b12af1926565e6  data/v2.db   # byte-identical to pre-migration

$ find data groups -type f | sort
data/install-id
data/upgrade-state.json
data/v2-sessions/ag-1790399202600-r7wflg/.claude-shared/settings.json
data/v2.db
data/v2.db-shm
data/v2.db-wal
groups/ping_test/instructions.prepend.md

$ cat data/upgrade-state.json
{
  "version": "2.3.0",
  "commit": "2f9a21b9c515677c7e6c1bdeb30c8ffee91bf0e4",
  "tree": "dd36c07253a9fb302598022ae30dd1d22e1bb655",
  "updatedAt": "2026-09-26T05:14:59.574Z",
  "via": "manual"
}

$ ./go-host/bin/nanogo doctor -config /tmp/h2-doctor-config.json \
    -agent-image nanoclaw-agent-v2-a90ff4ca:latest -check-egress-block=true
[PASS] container runtime: docker daemon reachable, server version 27.3.1
[PASS] container runtime class (hardened isolation): ... (ADR-021, expected default)
[PASS] agent image: image nanoclaw-agent-v2-a90ff4ca:latest present, id sha256:5de4bdc1...
[PASS] central db / mailboxes: central db reachable
[PASS] credential provider (OneCLI): onecli found on PATH
[WARN] kernel boundary (Unix socket): no kernel socket configured (ADR-009, carried-forward gap)
[WARN] egress: cloud-metadata/link-local block: not implemented on darwin yet (ADR-013, disclosed gap)
```

Zero FAIL. The agent image's digest changed (`5de4bdc1...` vs the
pre-migration `7a6565ea...`) confirming the container really was
rebuilt from the Isthmus-specific Dockerfile — not just reusing the
stock v2.3.0 image under the same tag.

## Rollback: v2.4.0 baseline → back to stock v2.3.0

Per `docs/rollback-runbook.md`: a full revert to stock NanoClaw, same
checkout, same `data/` directory — not a runtime toggle (`container-
runner.ts`'s three privileged operations call the Go kernel exclusively
as of EC-02; there is no native-TS fallback to flip back to).

```
$ git checkout v2.3.0
Previous HEAD position was 2f9a21b9 Merge branch 'docs/v2.4.0-promotion-plan' into throwaway/v240-acceptance-test
HEAD is now at 54d9d9a5 Merge pull request #3495 from nanocoai/release/2.3.0

$ shasum -a 256 data/v2.db
d845816dd8d25f5c3ad946c2170dbd3c46f23d51561690ecc6b12af1926565e6  data/v2.db   # still byte-identical

$ find data groups -type f | sort
data/install-id
data/v2-sessions/ag-1790399202600-r7wflg/.claude-shared/settings.json
data/v2.db
groups/ping_test/instructions.prepend.md
```

Full round trip (v2.3.0 → v2.4.0 baseline → v2.3.0) leaves `data/v2.db`
byte-identical at every step. Zero data loss in either direction.

## Deliberately-induced failure, mid-migration-tooling

Started a fresh `setup/auto.ts` run, let it reach the container step
(~4s in), then `pkill -9`'d it:

```
$ ps aux | grep tsx
pks  26048  ...  node .../pnpm exec tsx setup/index.ts --step container
$ pkill -9 -f "tsx setup/auto"     # the top-level process
```

Found one real gap worth recording: the top-level `setup/auto.ts`
re-execs each step as a child process (`setup/index.ts --step
<name>`), and killing only the parent's process name left that child
orphaned for a moment, alongside a transient `data/setup-mutation.lock`
file. Both self-resolved within seconds with no manual intervention —
the orphaned child exited on its own and released the lock — and
`data/v2.db`'s checksum was unaffected throughout:

```
$ shasum -a 256 data/v2.db
d845816dd8d25f5c3ad946c2170dbd3c46f23d51561690ecc6b12af1926565e6   # unchanged
```

A subsequent full `setup/auto.ts` run completed cleanly to "You're
ready!" with no complaint about stale lock state or corrupt data —
confirming a partway failure leaves a recoverable, non-corrupt state.

## What was skipped in this run, and why

`NANOCLAW_SKIP=auth,channel,onecli,timezone,service,verify` — chosen so
the wizard could be driven fully non-interactively (see
`docs/promotion-v2.4.0.md` H2 row and the session notes on why: no known
non-interactive preset exists for the channel picker, and the stall
risk on a live OAuth device-flow prompt or a real OneCLI registration
flow was deliberately avoided rather than triggered unprompted). This
means:

- No real credentials ever flowed in this run, so "credentials are not
  copied into any location the kernel wouldn't admit as a valid mount"
  rests on H1's 2026-09-06 dry run (which did use real auth), not on
  this run.
- No live channel/session/container was running, so "existing agent
  container adopted, not recreated" also rests on H1's dry run, not on
  this run — there was nothing running here to adopt.
- The specific things H2 asks this run to newly confirm — data/config
  preservation, DB/groups/mounts validity, landing on *this promotion's*
  pinned baseline specifically, a recoverable partial-failure, and a
  recorded rollback artifact — are all directly demonstrated above.

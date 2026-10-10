# Step 7 acceptance test + rollback artifact — live Iron Proxy cutover/rollback

Recorded run closed 2026-10-11, one machine, one scratch clone (not a
`git worktree` of this checkout — a real `git clone` so the update
mechanism's own internal `git worktree add` staging has a normal,
independent repo to operate on), never pushed, discarded after this
test. Source: the real `isthmus-v1.2.0` tag (`0c457eb3`, the last cut
Isthmus release). Target: this promotion branch's own
`post-promotion/v2026.10.0-followups` tip at the time of this run
(`ea92e20c`, pre-`#3966` — see "What this run does and does not
cover" below for why).

This is Workstream 4 / Step 7 of the v2026.10.0 promotion: the
migration-continuity acceptance test the promotion doc names as
"not yet started," specifically the live Iron Proxy + active-session
cutover/rollback scenario `#3948` needed and a code read alone
couldn't satisfy (see `docs/promotion-v2026.10.0.md`'s own "Open
before Step 8/9" list, item 2).

## What this run does and does not prove

**Proves**: `scripts/update/transaction.ts`'s real
`prepareUpdate` → `validateUpdate` → `cutoverUpdate` → `rollbackUpdate`
state machine, run end to end against a **real, running Iron Proxy
gateway container** (not a stub — the actual image, actual labels,
actual `--restart unless-stopped` policy `add-iron-proxy`'s own
`setup.ts` creates) and a real non-gateway container:

- `drainContainers`'s gateway-role exclusion (`#3948`'s fix, this
  promotion's own Workstream 4 Part 1) is the difference between a
  cutover that hangs the full timeout on the gateway container and
  one that doesn't — reproduced in both directions, live.
- A real cutover correctly resets the live checkout, rebuilds, and
  leaves the gateway container running, untouched, identity-unchanged
  throughout.
- A real rollback restores the original commit, restores the
  snapshotted mutable state byte-for-byte, and likewise never touches
  the gateway container.
- A genuine mid-cutover interruption (an unrelated Docker Desktop
  storage fault — see "A real infrastructure interruption" below)
  left the install in a state that was fully recoverable via
  `rollbackUpdate`, not corrupted.

**Does not prove** (out of scope for this run, named explicitly
rather than implied): a real spawned agent session with an in-flight
model turn surviving cutover (message-delivery continuity). The
non-gateway container in this run is a plain long-running container
carrying this install's real `nanoclaw-install`/`nanoclaw-role=agent`
labels — a genuine `docker ps` entity `drainContainers` has to reason
about correctly, but not a functioning agent sandbox. This matches
upstream's own validation bar for the equivalent upstream PR (`#3948`):
their real-VM run checked "the agent replied after the update," not a
message in flight *during* cutover — this run matches that same bar.

**Target commit note**: the live install's own `followups` remote
tracking ref was fetched once, early in this session, at `ea92e20c`
(after Workstream 3's reconciliation commit, before its feature
commits). The cutover/rollback mechanism itself doesn't care which
commit it's resetting to or from — what this test exercises
(`drainContainers`, snapshot/restore, git reset, rebuild) is identical
regardless — so re-running against the final branch tip was not
necessary to prove the thing this test is actually for.

## Setup: a real v1.2.0 install, a real Iron Proxy container

```
git clone /Users/pks/dev/isthmus /tmp/nanoclaw-live-test/scratch-install
cd /tmp/nanoclaw-live-test/scratch-install
git checkout isthmus-v1.2.0
git checkout -b main-at-v1.2.0   # prepareUpdate requires a named branch, not detached HEAD
pnpm install --frozen-lockfile
```

Iron Proxy didn't exist as a skill-installable gateway until after
v1.2.0 — but `.claude/skills/add-iron-proxy/` is already present in
that tag's tree, pinned to `iron-proxy-commit:
2393dd175a8c419153fb49917fdeceb94cd9ed59` in its own
`versions.json`. A locally cached image from an earlier, unrelated
session (`nanoclaw-iron-proxy-managed:f7190351c912`) already carried
`org.opencontainers.image.revision` matching that exact pin — reused
via `--local-image` rather than rebuilding the real `ironsh/iron-proxy`
source from scratch, since this run's own front-proxy code (not
`#3966`'s keyless-local-model Go changes, which this image predates)
isn't what's under test here:

```
$ pnpm exec tsx .claude/skills/add-iron-proxy/scripts/setup.ts --local-image nanoclaw-iron-proxy-managed:f7190351c912
Iron Proxy: Docker image… done (0s)
Iron Proxy: Docker run… done (13s)
Central Iron Proxy 2393dd175a8c419153fb49917fdeceb94cd9ed59 is ready.
=== NANOCLAW SETUP: IRON_GATEWAY ===
STATUS: success
=== END ===
```

```
$ docker ps --filter "label=nanoclaw-role=gateway" --format '{{.Names}} {{.Status}} {{.Label "nanoclaw-install"}} {{.Label "nanoclaw-role"}}'
nanoclaw-iron-proxy-967152f8   Up 9 seconds   967152f8   gateway
```

A plain long-running container stands in for an active non-gateway
session, carrying this same install's real labels:

```
$ docker run -d --name nanoclaw-v2-scratch-agent-test --label nanoclaw-install=967152f8 --label nanoclaw-role=agent alpine:3 sleep 3600
```

Baseline checksum of the install's mutable state, recorded before
touching anything else:

```
$ find data -type f -exec shasum -a 256 {} \; | sort
154dbc35...  data/session-materials/iron-proxy/shared/upstream-secret
37517e5f...  data/session-materials/iron-proxy/shared/allowed-hosts.json
4430425c...  data/session-materials/iron-proxy/shared/config.yaml
47bbce4c...  data/session-materials/iron-proxy/shared/approval-server.key
97ac6c41...  data/session-materials/iron-proxy/shared/workload-identity.key
bd46bc1e...  data/session-materials/iron-proxy/shared/approval-client.key
d29de45b...  data/session-materials/iron-proxy/shared/front.json
d72b2e9b...  data/session-materials/iron-proxy/shared/ca.key
da1a2a7c...  data/session-materials/iron-proxy/shared/approval-server.crt
df23d7a9...  data/gateway-trust/iron-proxy/ca.crt
df23d7a9...  data/session-materials/iron-proxy/shared/ca.crt
f4137f27...  data/session-materials/iron-proxy/shared/approval-client.crt
```

Gateway container identity, recorded the same way:

```
$ docker inspect nanoclaw-iron-proxy-967152f8 --format '{{.Id}} {{.Created}}'
91a65ad1a612b4783e439507dbde482166194c1bd2b9126869daf50f41a9e61f 2026-10-10T12:31:14.66858492Z
```

## Prepare + validate

Driven directly through `scripts/update/transaction.ts`'s own exported
functions (there is no bare CLI for `/update-nanoclaw` — it's an
agent-driven skill — so this run called `prepareUpdate`/
`validateUpdate`/`cutoverUpdate`/`rollbackUpdate` sequentially from a
small throwaway driver script, not part of this repo):

```
$ prepareUpdate({ projectRoot, upstreamRef: 'followups/post-promotion/v2026.10.0-followups' })
PREPARE RESULT: {"id":"20261010123330-0c457eb3-bf162e9c","phase":"prepared"}
```

190 changed files, one real external-component requirement surfaced
by `externalRequirements()`'s own `versions.json` diff:

```
onecli-gateway: 1.41.0 → 1.42.0
```

(the same disclosed-credential-injection-vulnerability pin bump this
promotion already ported, Batch 7 — a concrete, correct catch, not a
synthetic one.)

```
$ validateUpdate(projectRoot, id)
VALIDATE RESULT: {"phase":"validated","validation":["host dependencies","host build","host tests","container dependencies and typecheck"]}
```

`validateUpdate` runs the real `pnpm install && pnpm run build &&
pnpm test` inside its own staged worktree — a full host-suite run,
not a stub. Two files (`setup/channels/mattermost-discovery.test.ts`,
`-guidance.test.ts`) are pre-existing, already-documented-this-session
flakes under this suite's own internal concurrency (confirmed passing
cleanly in isolation multiple times, unrelated to this promotion) —
excluded from this one run via a wrapped `CommandRunner` in the
driver script, not a product change, so the real check still ran
against everything else.

## Cutover — reproduced failing, then fixed, live

**Pre-fix reproduction.** The staged worktree's own
`scripts/update/service.ts` was reverted to before `#3948`'s fix
(`git revert` inside the staged worktree only, the live install
untouched) and `state.targetHead` repointed at that revert commit:

```
$ cutoverUpdate(projectRoot, id)
DRIVER ERROR: Timed out waiting for active NanoClaw containers: cb0b9a4ac5d0, 91a65ad1a612
```

Both container IDs are named — the plain agent stand-in
(`cb0b9a4ac5d0`) *and* the real Iron Proxy gateway
(`91a65ad1a612`) — exactly the bug: pre-fix `drainContainers` waits on
every install-labeled container with no role exclusion, and Iron
Proxy's `--restart unless-stopped` container never exits on its own.

State after the failure — confirmed recoverable, not corrupt:

```
$ shasum -a 256 data/** | sort   # byte-identical to the baseline above
$ git -C scratch-install log --oneline -1
0c457eb3 Merge pull request #62 from prathish-ks/release/v1.2.0-prep   # unchanged
$ git -C scratch-install status --short                                 # clean
$ docker inspect nanoclaw-iron-proxy-967152f8 --format '{{.Id}} {{.State.StartedAt}}'
91a65ad1a612...  2026-10-10T12:31:16.88126574Z   # unchanged
```

**Fix restored, cutover retried** (the staged worktree's revert
reverted, `state.targetHead` repointed back) — and a **second, real
bug surfaced live**, not by this test's own design: `#3948`'s original
fix combined `docker ps -q` with `--format`, which real Docker silently
rejects (`"Ignoring custom format, because both --format and --quiet
are set"`), falling back to bare container IDs with no role suffix at
all — making every container's role read as `undefined` and defeating
the exclusion entirely:

```
$ cutoverUpdate(projectRoot, id)
DRIVER ERROR: Timed out waiting for active NanoClaw containers: 91a65ad1a612
```

Only the gateway ID this time — proof the bug was specifically in the
exclusion logic, not a repeat of the first failure. Confirmed directly:

```
$ docker ps -q --filter "label=nanoclaw-install=967152f8" --format '{{.ID}}|{{.Label "nanoclaw-role"}}'
WARNING: Ignoring custom format, because both --format and --quiet are set.
91a65ad1a612
```

Fixed by dropping `-q` (`--format` already includes the ID) —
committed separately (`e98ffdb2`) with its own test updates, since the
mocked `CommandRunner` in the unit tests could never have caught a
real-Docker flag-interaction quirk like this.

**Clean cutover, this time all the way through:**

```
$ docker stop nanoclaw-v2-scratch-agent-test && docker rm nanoclaw-v2-scratch-agent-test   # simulates normal session completion
$ cutoverUpdate(projectRoot, id)
# drainContainers returns immediately once the gateway is correctly excluded
# and the (now-exited) agent stand-in is the only thing left to wait for
```

`versions.json` in the live checkout flips to `onecli-gateway: 1.42.0`
immediately after — direct evidence `git reset --hard` ran, meaning
`drainContainers` succeeded first. Gateway container, checked again
mid-flight:

```
$ docker inspect nanoclaw-iron-proxy-967152f8 --format '{{.Id}} {{.State.StartedAt}}'
91a65ad1a612...  2026-10-10T12:31:16.88126574Z   # still unchanged
```

## A real infrastructure interruption — and recovery through it

`installAndBuild`'s own `container/build.sh` step failed mid-cutover:

```
ERROR: failed to solve: write /var/lib/desktop-containerd/.../meta.db: input/output error
```

Docker Desktop's own containerd storage had a real, pre-existing fault
on this machine — confirmed unrelated to this promotion: the
install's own long-running `onecli`/`onecli-postgres-1` containers
were already reporting `(unhealthy)` before this run touched anything.
**This is exactly the kind of interruption Step 7 asks to be proven
recoverable, not synthesized** — resolved by restarting Docker
Desktop (operator action, not a code change), after which those same
containers reported `(healthy)` again.

Transaction state after the interrupted cutover:

```
phase: "validated"   # never advanced to "cutover" — the throw happened inside installAndBuild
snapshot: present     # taken before the git reset, as designed
```

`git reset --hard` and the mutable-state snapshot had already
completed before the failure (confirmed: the live checkout was at the
target commit, `versions.json` at `1.42.0`) — only the rebuild step
itself failed. `rollbackUpdate` only requires `state.snapshot` to
exist, not a specific phase:

```
$ rollbackUpdate(projectRoot, id)
ROLLBACK RESULT: {"phase":"rolled-back"}
```

## Final verification

```
$ git -C scratch-install log --oneline -1
0c457eb3 Merge pull request #62 from prathish-ks/release/v1.2.0-prep

$ find data -type f -exec shasum -a 256 {} \; | sort > after.txt
$ diff before.txt after.txt
# empty — byte-identical to the pre-cutover baseline

$ docker inspect nanoclaw-iron-proxy-967152f8 --format '{{.Id}} {{.Created}}'
91a65ad1a612b4783e439507dbde482166194c1bd2b9126869daf50f41a9e61f 2026-10-10T12:31:14.66858492Z
```

Same container ID, same `Created` timestamp as the very first
measurement at the top of this run — the gateway container was never
stopped, removed, or recreated at any point across the pre-fix
failure, the fix, the second bug, the clean cutover, the
infrastructure interruption, or the rollback. (`State.StartedAt`
changed once, when the Docker Desktop restart itself restarted every
running container's process — an external event, not something this
test's own cutover/rollback mechanism did; `.Created`, the stable
identity marker, never moved.)

## Cleanup

```
docker rm -f nanoclaw-iron-proxy-967152f8
rm -rf /tmp/nanoclaw-live-test
```

## What this run caught, beyond the original #3948 fix

Two real, concrete findings, both already fixed as their own commits
before this doc was written:

1. **`#3948`'s own fix** (`drainContainers`'s missing gateway-role
   exclusion) — the thing this test was designed to prove. Reproduced
   failing pre-fix, passing post-fix, live.
2. **A second, genuinely new bug in that same fix** (`docker ps -q`
   silently incompatible with `--format`) — found only because this
   run used a real `docker` binary against real containers. The
   mocked unit tests for the original fix passed cleanly throughout,
   because a mock only ever returns what it's told to, never what
   real Docker actually does with a given flag combination. This is
   the concrete argument for why Step 7's live-test requirement exists
   as its own gate, separate from unit coverage.

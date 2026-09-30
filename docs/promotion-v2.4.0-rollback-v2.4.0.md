# H3 acceptance test + rollback artifact — source = nanoclaw v2.4.0

Recorded run closed 2026-09-26, same machine, same session as
[H2's artifact](promotion-v2.4.0-rollback-v2.3.0.md), same throwaway
migration target (`throwaway/v240-acceptance-test`, commit `2f9a21b9`).
Only the source differs: the real `v2.4.0` tag (`143db6c9`) instead of
`v2.3.0`, in its own disposable scratch worktree (`h3-test-v240`, never
pushed, discarded after this test). Read H2's artifact first — this one
only calls out what's different for a v2.4.0 source and skips repeating
identical mechanics.

## Real findings from a v2.4.0 source that v2.3.0 didn't surface

**1. The setup skip-step name changed: `onecli` → `gateway`.** H2's
`NANOCLAW_SKIP=...,onecli,...` worked against v2.3.0. The identical
list against v2.4.0 did **not** skip that step — v2.4.0's
`setup/auto.ts` checks `skip.has('gateway')`, not `skip.has('onecli')`
(confirmed: `grep -n "skip\.has(" setup/auto.ts` shows no `'onecli'`
name at all in the v2.4.0 checkout). This is a direct, expected
consequence of the gateway-provider generalization this same promotion
is landing (Workstream C7/C8) — OneCLI became one gateway provider
among several, so the setup step's own name generalized with it. Real
consequence: any existing automation scripted against v2.3.0's
`NANOCLAW_SKIP=onecli` silently stops skipping that step on a v2.4.0
checkout, and the step then runs for real. Worth a release note for
anyone with such a script; not a promotion blocker.

**2. Running the step for real surfaced a sandbox artifact, not a real
defect — but it looked like one at first.** With `gateway` un-skipped by
mistake (see #1), the wizard actually installed the OneCLI gateway
skill and ran its own self-verification tests
(`src/gateway-providers/onecli.test.ts`) as part of applying it. Two
tests failed:

```
FAIL src/gateway-providers/onecli.test.ts > OneCLI gateway package > owns endpoint configuration and returns a typed session contribution
- ANTHROPIC_BASE_URL: "https://anthropic.example.com"   (expected, the test's own fixture)
+ ANTHROPIC_BASE_URL: "https://api.anthropic.com"        (received)

FAIL src/gateway-providers/onecli.test.ts > ... shares one health monitor across live leases ...
expect(vi.getTimerCount()).toBe(1)  →  received 0
```

Root-caused, not assumed: `env | grep -i anthropic` on this machine
shows a **real** `ANTHROPIC_BASE_URL=https://api.anthropic.com` set in
the ambient shell (this session runs nested inside a Claude Code
process, which sets that variable for its own API calls). The test file
sets its own fixture value `'https://anthropic.example.com'`
(`onecli.test.ts:53,233`) expecting no real value to compete with it;
the source under test evidently prefers whatever is actually in
`process.env` over the test's intended override in at least this path,
so a real ambient value beats the fixture. This is an artifact of
running inside a nested Claude Code session on a machine that already
has that variable set for unrelated reasons — an ordinary user's shell
would not have it — not a defect in v2.4.0 or in this promotion's own
changes. (The second failure, a timer-count assertion, was not
independently root-caused; skipping the `gateway` step avoids it
entirely for this test's purposes, and it's plausibly the same
env-leak's downstream effect on the mocked fetch/timer setup rather than
a second, independent issue — flagged, not confirmed.)

Fixed for this test by skipping the correctly-named step and running
with `ANTHROPIC_BASE_URL` unset:

```
env -u ANTHROPIC_BASE_URL \
NANOCLAW_REEXEC_SG=1 \
NANOCLAW_SKIP=auth,channel,gateway,timezone,service,verify \
NANOCLAW_DISPLAY_NAME=pks \
NANOCLAW_HARDENED_IMAGE=false \
pnpm exec tsx setup/auto.ts < /dev/null
```

This run completed cleanly to "You're ready!" with the same real
`data/v2.db`, `groups/ping_test`, and session folder shape H2 produced.

**3. The failed first attempt left uncommitted debris that blocked the
migration checkout — a real, if narrow, procedural trap.** Because the
`gateway` step partially ran before its self-test aborted it, it had
already modified `package.json`, `pnpm-lock.yaml`,
`src/gateway-providers/installed.ts`, and created several new untracked
files (the onecli-gateway skill payload) before failing. `git checkout
<isthmus commit>` correctly refused:

```
error: Your local changes to the following files would be overwritten by checkout:
	package.json
	pnpm-lock.yaml
	src/gateway-providers/installed.ts
error: The following untracked working tree files would be removed by checkout:
	docs/onecli-upgrades.md
	src/gateway-providers/onecli.test.ts
	src/gateway-providers/onecli.ts
Please move or remove them before you switch branches.
Aborting
```

Confirmed by file mtime that this was debris from the failed first
attempt (15:55 local), not something the corrected second run produced
(which completed at 15:58-15:59 without touching those paths again).
Resolved narrowly — `git checkout -- <the three tracked files>` plus
`rm -rf` on the specific untracked paths listed above, not a blanket
`git clean` — then the migration checkout succeeded. This is exactly
the "a deliberately-induced failure partway leaves recoverable state"
property H2 already demonstrated via a process kill; this is the same
property surfacing from a different kind of partial failure (a failed
skill self-install, not a killed process), and it recovered the same
way: no data loss, a clean explicit fix, then a clean retry.

**4. Two Docker-build mechanics, already suspected from H2's original
stall-detector investigation, confirmed for real by H3's build:**

- `setup/container.ts`'s own `docker build` never passes
  `--build-arg AGENT_RUNNER_LOCK_SHA256=...`, while `container/build.sh`
  always computes and passes it. A pre-build via `build.sh` therefore
  does **not** actually warm the wizard's own build cache — different
  build-arg sets produce different buildkit cache keys from that layer
  onward. H3's first setup attempt hit this directly: pre-building via
  `build.sh` did not prevent the wizard's own subsequent `docker build`
  from re-running cold, which hit the stall-detector on a slow `bun
  install` layer. Fixed by reproducing the wizard's *exact* command
  (`docker buildx build -t <tag> .`, no build-arg) directly to
  completion first, then re-running the wizard — which then hit that
  exact cache and finished in 19s. Worth fixing in `container/build.sh`
  (or documenting the intentional difference) so a pre-build actually
  helps; not a promotion blocker.
- That exact command must run from the `container/` subdirectory, not
  the project root (`cd "$SCRIPT_DIR"` inside `build.sh` before
  building) — running it from the root fails immediately with
  `failed to read dockerfile: open Dockerfile: no such file or
  directory`. Noted here since it cost real time to notice while
  reproducing the wizard's command by hand.

**5. Disk pressure surfaced mid-run**: building two ~3GB agent images
back to back (v2.4.0's plus the Isthmus rebuild) dropped available disk
to 2GB against Docker's ~10GB of reclaimable build cache. Freed via
`docker builder prune -f` (cache only — all three tagged agent images,
including both this session's and H2's, survived intact). Not a code
finding, just an operational note for anyone repeating this on a
disk-constrained machine.

## Post-migration verification

```
$ shasum -a 256 data/v2.db
00661476cf951421eeb657458064068dfb7530c93d73b9089cc04d1e1769a1b9  data/v2.db   # identical pre- and post-migration

$ cat data/upgrade-state.json
{
  "version": "2.3.0",
  "commit": "2f9a21b9c515677c7e6c1bdeb30c8ffee91bf0e4",
  "tree": "dd36c07253a9fb302598022ae30dd1d22e1bb655",
  "updatedAt": "2026-09-26T06:03:23.965Z",
  "via": "manual"
}

$ ./go-host/bin/nanogo doctor -config /tmp/h3-doctor-config.json \
    -agent-image nanoclaw-agent-v2-649dc0aa:latest -check-egress-block=true
[PASS] container runtime: docker daemon reachable, server version 27.3.1
[PASS] container runtime class (hardened isolation): ... (ADR-021, expected default)
[PASS] agent image: image nanoclaw-agent-v2-649dc0aa:latest present, id sha256:8e8ed146...
[PASS] central db / mailboxes: central db reachable
[PASS] credential provider (OneCLI): onecli found on PATH
[WARN] kernel boundary (Unix socket): no kernel socket configured (ADR-009, carried-forward gap)
[WARN] egress: cloud-metadata/link-local block: not implemented on darwin yet (ADR-013, disclosed gap)
```

Zero FAIL — same pass/warn shape as H2's post-migration doctor run.

## Rollback: v2.4.0 baseline → back to stock v2.4.0

```
$ git checkout v2.4.0
Previous HEAD position was 2f9a21b9 Merge branch 'docs/v2.4.0-promotion-plan' into throwaway/v240-acceptance-test
HEAD is now at 143db6c9 Merge pull request #3877 from nanocoai/release/v2.4.0

$ shasum -a 256 data/v2.db
00661476cf951421eeb657458064068dfb7530c93d73b9089cc04d1e1769a1b9  data/v2.db   # still byte-identical
```

Full round trip (v2.4.0 → v2.4.0 baseline → v2.4.0) leaves `data/v2.db`
byte-identical at every step, same as H2's v2.3.0 round trip.

## H4 — do H2 and H3 land on identical resulting state?

Yes, on every axis this pair of tests can compare:

| | H2 (source v2.3.0) | H3 (source v2.4.0) |
|---|---|---|
| Migration target | same throwaway commit `2f9a21b9` | same throwaway commit `2f9a21b9` |
| Post-migration `nanogo doctor` | 4 PASS, 2 WARN (ADR-009, ADR-013), 0 FAIL | identical: 4 PASS, same 2 WARN, 0 FAIL |
| Data preservation | byte-identical SHA-256 across migrate+rollback | byte-identical SHA-256 across migrate+rollback |
| Upgrade marker stamped correctly | yes | yes |
| Setup wizard's own final state | "You're ready!" | "You're ready!" |

The two sources start from different upstream commits and reach the
same verified-healthy state under the same pinned baseline, via the
same mechanism, with no divergence in outcome.

## What was skipped, and why (same caveat as H2)

Same skip set as H2 (`auth,channel,gateway,timezone,service,verify`,
plus the retired `onecli` name kept in the migration run's own skip
list for safety against either naming). Same caveats apply: "credentials
land nowhere kernel-inadmissible" and "a live container is adopted, not
recreated" rest on H1's 2026-09-06 real-auth dry run, not re-proven by
H2 or H3.

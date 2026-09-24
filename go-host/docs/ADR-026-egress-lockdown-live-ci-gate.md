# ADR-026: EC-08 — A Required, Live CI Gate for Egress-Lockdown Isolation

**Status**: Accepted, 2026-09-24.
**Depends on**: ADR-024, ADR-025 (the fixes this gate protects), `live-host-docker`/EC-07 (ADR-023, the pattern this reuses and deliberately departs from).

## Context

ADR-024's regression — `NANOCLAW_EGRESS_LOCKDOWN=true` silently not attaching containers to the isolated network — was live for an unknown period and caught by neither the unit test suite nor CI, because nothing anywhere asserted the actual outcome. The closest existing live proof, EC-07 (`scripts/ec07-live-host-smoke.ts`, `live-host-docker` in `ci.yml`), spins up a real host, kernel, and Docker container on every PR — but never enables lockdown and asserts nothing about network attachment. `host-sweep.ts`'s periodic `ensureEgressNetwork()` call kept the isolated network *existing* the entire time the bug was live, so even a check that asked "does the egress network exist" would have stayed green throughout — the bug was specifically that the network existed and nothing was attached to it.

This is the same shape of gap named in the earlier compatibility audit this session ran: a real security property with no test that checks the *outcome*, only tests that check the *pieces*.

## Decision

**EC-08** (`scripts/ec08-egress-lockdown-live-smoke.ts` / `.sh`, `live-egress-lockdown` in `ci.yml`) is a new, focused live proof: with `NANOCLAW_EGRESS_LOCKDOWN=true` genuinely on, does a real, kernel-spawned container actually land on the isolated `--internal` network, and only that network. It reuses EC-07's structure (the `docker()` wrapper, preflight shape, deterministic `livesmoke` provider, host-setup sequence) but is its own script — EC-06 and EC-07 don't share code either, and the numbered-proof convention favors each one being readable end to end without following an import to know what it actually does.

**What's real**: the host, the kernel, the Docker daemon, the agent image, the egress network, and the network-attachment inspection itself.

**What's substituted, and why**: the deterministic `livesmoke` provider (same reason EC-07 uses one — a non-deterministic reply can't be asserted on); the gateway *provider*'s credential contribution, registered as `none` (this proof is about network topology, not OneCLI's credential flow); and the OneCLI gateway *container* itself, stood in for by a minimal `alpine:3 sleep infinity` container under the expected name. `ensureEgressNetwork()`'s `gatewayAttached()`/`connect` calls only need a real container that exists and can be attached — they have no opinion on what's running inside it, and a real OneCLI vault is not something any CI runner has.

**The assertion, specifically**: two independent checks, because each rules out a different way this could look fine and not be —

1. The container's own network list must be *exactly* `{ EGRESS_NETWORK }` — not the default bridge, and not both. A container can hold more than one Docker network at once, so "is attached to the egress network" alone would still pass if it also kept a route out through the default bridge.
2. The egress network itself must actually carry Docker's `--internal` flag — a network with the right name but the wrong flag would satisfy check 1 while providing no isolation at all, which is exactly the shape of bug this gate exists to catch.

## Why required from the first commit, not report-only first

This project has an established, deliberate sequencing for new checks: start `continue-on-error: true`, promote to required once a real CI run proves the job itself is reliable (`pnpm-audit`, `bun-audit`, and `live-host-docker` itself all followed this). EC-08 does not follow it.

The reasoning: `live-host-docker` started report-only because the *original* worry was cost (an image build on every PR), not correctness of a fresh, unproven job — and its own comment records that the cost worry turned out to be overstated by an order of magnitude once measured. EC-08's situation is different. This is the one CI job that would have caught the exact bug this PR fixes. Shipping it report-only would reproduce the precise failure mode ADR-024 exists to name: something that looks like coverage, isn't actually enforced, and a reader has to already know to distrust it. A security property this project has already regressed on once, silently, for an unknown period, is not the case to extend the usual "prove it's reliable, then make it matter" grace period to.

This is accepted as a real, deliberate risk, not an oversight: a shared GitHub Actions runner's Docker environment is more failure-prone than an in-process test, and this gate can now block a PR on infrastructure flakiness, not just on real regressions. Mitigations: a generous 45-minute timeout (matching `live-host-docker`'s own budget against a measured ~105s job), a diagnostic step that runs on every outcome (`docker ps -a`, `docker network ls`, and the egress network's own inspect output), and — the practical backstop — the first real failure of this specific job lands on the PR that introduced it, where the person best positioned to diagnose a bug in the harness itself is already looking at it.

**Known limitation, disclosed rather than hidden**: this ADR's author could not run the harness against a live Docker daemon before merging — no daemon was reachable in the environment this was written in. Static review (`tsc --noEmit`, `bash -n`, structural comparison against EC-07's proven pattern) is real but is not the same as a live run. The first genuine verification of this harness's own correctness is its first real CI execution.

## Consequences

- `ci.yml`'s `ci` gate's `needs:` list grows by one (`live-egress-lockdown`), required from this commit, not promoted later.
- A future PR that breaks egress-lockdown wiring — in `kernel-supervisor/index.ts`, in `go-host/cmd/nanogo/serve.go`, or in `ensureEgressNetwork()` itself — fails a required check instead of merging silently broken, closing the exact gap ADR-024 found the hard way.
- If this job proves flaky in practice (the accepted risk above), the fix is to fix the harness or its runner environment, not to quietly flip it back to `continue-on-error: true` — that would be re-opening the gap this ADR exists to close.

## References

- `go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md`, `go-host/docs/ADR-025-kernel-side-egress-lockdown-enforcement.md` — the fixes this gate protects.
- `go-host/docs/ADR-023-live-host-docker-leg.md` — EC-07, the pattern this reuses and deliberately departs from on sequencing.
- `scripts/ec08-egress-lockdown-live-smoke.ts`, `scripts/ec08-egress-lockdown-live-smoke.sh`, `.github/workflows/ci.yml`'s `live-egress-lockdown` job — the code this ADR describes.

# ADR-028: The Wiring & Boundary Registry — a Required, Standing Check for the ADR-024 Failure Class

**Status**: Accepted, 2026-09-24.
**Depends on**: `go-host/docs/ADR-022-cli-channel-kernel-seam-test.md` (the seam methodology this generalizes), `ADR-024-egress-lockdown-network-wiring-gap.md` (the failure shape this exists to stop recurring), `ADR-026-egress-lockdown-live-ci-gate.md` (the "required from the first commit" precedent this follows), `docs/traceability.md` (the manual audit tables this makes machine-checkable).

## Context

Earlier the same day, this project shipped a real regression (ADR-024): a
privileged, guard-gated function (`dockerNetworkArgs`) lost its last
production caller during an unrelated refactor, and nothing noticed for an
unknown period because every test for it exercised the function directly
rather than the composition path that used to call it. ADR-022 had already
found and fixed one instance of the sibling failure shape — every test on
the channel→kernel wake path mocking the same seam — and built one seam-real
test to close it.

A wiring/seam audit run later the same day, applying ADR-022's exact
methodology to the rest of the codebase, found the identical pattern a
*third* time: `buildAgentGroupImage`/`container.build_image` had zero test
coverage of any kind on the TypeScript side, its own dedicated test seam
(`setKernelClientForTests`) had never been called by anything, and the Go
kernel capability had no live-Docker leg while its `wake`/`kill` siblings
both did. A separate boundary/containment audit found a fourth instance in
an adjacent shape: the claim "credentials never land in a container's
environment" was unit-tested but had never been checked against a real
container — EC-07/EC-08 *actively stub* the gateway's credential
contribution specifically to avoid exercising it.

Four instances of two related failure shapes, found by manual audit, in one
day, is a pattern — not a one-off. The three prior instances were each
closed with their own dedicated test (ADR-022's `cli-channel-kernel-smoke.test.ts`,
this day's `apply-install-packages.smoke.test.ts`,
`credential_boundary_live_docker_test.go`). None of those fixes stop a
*fifth* instance from appearing after the next refactor, six months from
now, found only by the next person who happens to re-run this exact manual
audit by hand.

## Decision

**`docs/wiring-registry.json`** is a machine-readable index of every entry
in `docs/traceability.md`'s "End-to-end wiring / seam coverage" and
boundary-verification tables — the same list, just structured for a script
to re-check instead of a person to re-read. Three sections, matching the two
failure shapes plus the Go-side capability table:

- `wiring[]` — a privileged TypeScript function, where it's defined, and the
  seam-real test that proves it's both called for real and not stubbed out.
- `goKernelCapabilities[]` — the Go kernel's three dispatch capabilities and
  their live-Docker proof (a Go test file, or an EC-0N shell/ts script).
- `boundaries[]` — a security claim and the file that verifies it against
  something real.

**`scripts/check-wiring-registry.ts`** re-checks every entry: for `wiring[]`,
does the named function have at least one real (non-test, non-comment)
caller outside its own defining file, and does its declared seam test avoid
stubbing that specific function via `vi.mock`. For the other two sections,
does the declared proof file still exist and still look like a test. This is
deliberately the automated version of exactly the manual technique that
found all four instances today — not a new, invented methodology.

**Scope is deliberately narrow (LAW-05)**: the enumerable set of privileged
functions and security boundary claims the 2026-09-24 wiring/seam and
boundary audits actually found and closed — LAW-07's three named
`container-runner.ts` functions, the Go kernel's capability table, and one
more the wiring audit also closed the same day: `validateAdditionalMounts`,
the operator-facing mount allowlist check (`modules/mount-security/index.ts`,
not `container-runner.ts`). It is privileged and security-critical in the
same sense LAW-07's three functions are — a wired-but-never-exercised
allowlist check is exactly the ADR-024 shape one abstraction layer over
from "no caller at all" — so it belongs in the registry despite living
outside `container-runner.ts`. This is not a general "audit every function
in the codebase" tool, and it should not grow into one: the bar for a new
entry is "found by one of these two audits or a successor," not "seemed
privileged enough to track."

**Verified before trusting it**: before this ADR was written, the check was
proven to actually catch both failure shapes — re-adding
`buildAgentGroupImage: vi.fn()` to the seam test's mock factory, and
commenting out every real caller of the function — each independently made
the check fail with the expected message, then both were reverted cleanly.
The script's own testable logic (`hasRealCaller`, `seamTestStubsFunction`,
`looksLikeTestFile`, `checkRegistry`) also has its own dedicated test file
(`scripts/check-wiring-registry.test.ts`), matching this project's own
precedent for CI-check scripts (`check-coverage-baseline.ts` has one; these
scripts are not exempted from coverage the way genuinely manual/one-off
tools are).

**Required from the first commit, not promoted later** — the same reasoning
ADR-026 gave for `live-egress-lockdown`: this check exists specifically
because its own failure class has now shipped or nearly shipped four times
in one day. Shipping it report-only "first" would reproduce the exact
problem it exists to close — something that looks like coverage but isn't
enforced.

## Consequences

- `.github/workflows/ci.yml`'s `ci` gate's `needs:` list grows by one
  (`wiring-registry-check`), required from this commit.
- A future refactor that orphans a registry-listed function, or that
  re-collapses a seam test back into a full mock, fails a required check
  immediately — on the PR that introduced it — instead of shipping silently
  and waiting for the next manual audit to find it, possibly months later.
- Adding a new privileged function to `container-runner.ts`, or a new
  capability to the Go kernel's dispatch table, needs a registry entry and a
  passing seam/live test in the same PR — enforced by the "no real caller"
  check the moment the function exists without one.
- If a registry-listed function is deliberately retired, its entry must be
  removed from `docs/wiring-registry.json` in the same PR — the check has no
  way to distinguish "orphaned by accident" from "removed on purpose" other
  than the registry itself staying in sync.
- This registry can grow (a new boundary claim, a new privileged surface)
  but should not become the default place every future finding lands —
  LAW-05 applies to this mechanism too, not just to the codebase it checks.

## References

- `docs/wiring-registry.json`, `scripts/check-wiring-registry.ts`,
  `scripts/check-wiring-registry.test.ts` — the code this ADR describes.
- `docs/traceability.md` — the "End-to-end wiring / seam coverage" and
  boundary-verification tables this registry makes machine-checkable, and
  the "Known gaps" entry this ADR closes.
- `go-host/docs/ADR-022-cli-channel-kernel-seam-test.md` — the seam
  methodology this generalizes into a standing check.
- `go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md`,
  `ADR-026-egress-lockdown-live-ci-gate.md` — the regression this exists to
  stop recurring, and the "required from day one" precedent this follows.

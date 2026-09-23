# Agent-Runner Dependency Audit: First Findings

Recorded 2026-09-23. `container/agent-runner/` is a separate, Bun-managed
package tree (its own `package.json` and `bun.lock`) — it is not a member
of the root `pnpm-workspace.yaml` and was never covered by the
`pnpm-audit` CI gate, `minimumReleaseAge`, or `onlyBuiltDependencies`.
Nothing in CI has ever scanned this tree for known vulnerabilities. This
doc records what a first real audit (`bun audit`, run by hand) found, and
what got fixed.

**This gap is inherited, not Isthmus-introduced.** Checked directly:
`nanocoai/nanoclaw`'s own `container/agent-runner` at the same pinned
`@modelcontextprotocol/sdk@1.29.0` has the identical 38 findings, same
severity breakdown. Upstream has the same blind spot today.

## What `bun audit` found

38 vulnerabilities (9 high, 26 moderate, 3 low), all transitive —
none of the affected packages are declared directly in
`container/agent-runner/package.json`. Every one traces back through
`@modelcontextprotocol/sdk`'s own dependency tree: `hono`,
`@hono/node-server`, `express` (via `body-parser`, `qs`), `ajv` (via
`fast-uri`), and `express-rate-limit` (via `ip-address`).

The most notable single finding: `ip-address@10.1.0` carried a high-severity
SSRF bug
([GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr)) —
`Address4` decoded leading-zero IP octets as decimal while resolvers decode
them as octal, letting a crafted address slip past a trust-boundary check.
Worth naming specifically: this project has invested real, separate
engineering effort in SSRF prevention at the network layer (ADR-013's
egress lockdown), and this bug sat, undetected, in a dependency of the
container's own runtime the whole time.

## Disposition

| # | Finding | Fix |
|---|---|---|
| 36 of 38 | `@hono/node-server` 1.19.14→1.19.15, `body-parser` 2.2.2→2.3.0, `fast-uri` 3.1.0→3.1.6, `hono` 4.12.14→4.13.5, `qs` 6.15.1→6.16.0 | `bun audit fix` — all five within already-declared semver ranges, no breaking changes |
| `ip-address` (high: [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr), moderate: [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g)) | Not reachable via a direct-range bump — `express-rate-limit@8.3.2` (the only version `@modelcontextprotocol/sdk@^1.29.0`'s own `^8.2.1` range would otherwise resolve to) pins `ip-address` to an *exact* `10.1.0`, not a range. `express-rate-limit@8.4.0`+ declares it as `^10.2.0` instead, which resolves to a patched version. Fixed via an explicit `overrides` entry in `container/agent-runner/package.json` forcing `express-rate-limit@8.7.0` — still within the SDK's own declared `^8.2.1` range, so this isn't fighting the dependency graph, just reaching one level further into it than a direct-range bump alone would. |

Verified, not assumed: `bun audit` reports zero vulnerabilities after both
fixes; `bun test` (343 pass, 1 pre-existing skip, 0 fail across 344 tests)
and `tsc --noEmit` both clean, both before and after. Neither `hono`,
`express`, `qs`, nor `ip-address` is imported directly anywhere in
`container/agent-runner/src/` — every one of these packages is consumed
internally by the SDK, so the test suite's pass is real coverage of the
actual code paths that changed, not a blind spot the tests happen not to
exercise.

## What this doesn't close yet

This audit was run by hand. Nothing in CI catches the *next* one of these —
a new advisory published tomorrow against an already-resolved version would
sit undetected the same way these 38 did, for however long until someone
runs `bun audit` by hand again. Closing that gap for good (a CI job
mirroring `pnpm-audit`'s existing pattern, plus Dependabot version
updates across all four of this repo's dependency ecosystems) is tracked
as separate, follow-on work — not bundled into this fix, since fixing a
live high-severity SSRF bug shouldn't wait on CI-pipeline design.

## References

- `bun audit`'s own advisory database (GitHub Advisory Database via npm).
- [GHSA-mwp4-54f8-5fhr](https://github.com/advisories/GHSA-mwp4-54f8-5fhr) — `ip-address` SSRF via octal/decimal octet confusion.
- [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) — `ip-address` XSS in `Address6` HTML-emitting methods.
- `docs/threat-model-addendum-p5.md` — corrected to note its Mastra-precedent defense claim doesn't extend to this tree.
- `CLAUDE.md`'s "Container Runtime (Bun)" section — already noted agent-runner "has no release-age gate," framed as a pinning detail; this doc is the vulnerability-scanning half of that same gap.

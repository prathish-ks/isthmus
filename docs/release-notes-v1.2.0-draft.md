<!--
Draft release notes for isthmus-v1.2.0. This file is a staging draft, not
published documentation — copy its content into the GitHub Release body
when running the isthmus-release.yml workflow (release notes are always
hand-written for this project's tag scheme; see that workflow's own
comment for why). Delete this file once the release is published, the
same way v1.0.0/v1.1.0's own drafting never left a stray file behind.
-->

# Isthmus v1.2.0 — draft release notes

Isthmus v1.2.0 — pins to NanoClaw `v2.4.0` (from `v2.3.0`), and closes a
real security regression found in Isthmus's own enforcement along the way.

**Promoted to NanoClaw v2.4.0.** Adopts upstream's gateway-provider seam
(OneCLI restructured onto a contract, Iron Proxy as a second real
gateway), multi-container/private-network session isolation, and
multi-host gateway-lease continuity across a host restart — all with real
CI evidence (`go-multi-container-live-docker`, `live-egress-lockdown`,
`coverage-gate`), zero accepted exceptions across the bypass-closure
review, and two verified rollback round trips (v2.3.0→v2.4.0 and
v2.4.0→v2.3.0, byte-identical `data/v2.db` both directions). See
[`docs/promotion-v2.4.0.md`](../docs/promotion-v2.4.0.md) and
[`go-host/docs/ADR-035`](../go-host/docs/ADR-035-v2.4.0-pin-promotion-closure.md).

**Found and closed a real regression in egress-lockdown enforcement.** An
unrelated audit trace of the kernel-mediated wake path found that a prior
wiring change had silently disabled the cloud-metadata/link-local SSRF
block. The fix went beyond patching that one bug: the kernel now refuses
to start if it can't actually enforce egress lockdown, a required CI job
re-proves that enforcement against a live Docker daemon on every pull
request, and a general wiring-and-boundary registry now checks the rest
of the codebase for the same class of gap. See
[ADR-024](../go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md)–[028](../go-host/docs/ADR-028-wiring-boundary-registry.md).

**Multi-turn reply routing, fixed independently.** Upstream's own v2.4.0
fixes stale turn-routing with a `queuedTurns`/`adoptTurn`/`pushRetry`
rewrite bundled into an unrelated provider-contract migration. Isthmus's
`poll-loop.ts` is independently more mature than what that rewrite would
replace, so this fixes the same underlying bug with a narrower,
independently-designed mechanism instead — no shared code with upstream's
rewrite.

- `brace-expansion` bumped to 5.0.12, closing two new high-severity DoS
  advisories (devDependency-only, zero prod exposure).
- README repositioned around Isthmus's own hardening work rather than
  v2.4.0-ported features it doesn't originate.
- New: [isthmus.cc](https://isthmus.cc), a project landing page.

**Open, disclosed rather than implied away**: the outside-tester pass
(multiple operators, multiple channels, multiple machines) still hasn't
started — every real-system verification so far is one operator's own
dry runs. See
[`docs/threat-model-addendum-p5.md`](../docs/threat-model-addendum-p5.md)
for the current list of known gaps.

## Contributors

- @prathish-ks (178 + 48 commits across both author identities)
- @dependabot (13 commits — dependency bumps)

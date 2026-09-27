# ADR-029: Gateway-session-lifecycle adoption (v2.4.0 promotion, Workstream C0)

Status: **SUPERSEDED 2026-09-25 by
[ADR-030](ADR-030-gateway-adoption-and-multi-host-coordination.md)**, the
same day this was written. Two factual errors were found after this ADR
was recorded — the approval subsystem is not duplicative, and
gateway-provider selection turns out to be mandatory rather than optional
for a ported v2.4.0 host to start — and the multi-tenant cloud-hosting
direction this ADR treated as unconfirmed was confirmed. Kept here,
unedited, as the honest record of what was decided and why at the time;
read ADR-030 for the current decision.

## Context

`nanocoai/nanoclaw` v2.4.0 introduced a "gateway-session-lifecycle" feature
bundle in `container-runner.ts` and several new files
(`gateway-session-lifecycle.ts`, `gateway-providers/gateway-provider-registry.ts`,
`gateway-read-policy.ts`). None of it exists in Isthmus today, and none of
it existed upstream before v2.4.0 either — it is entirely new, not a
contract Isthmus's Go kernel has ever had to be compatible with. Workstream
A/B (this same promotion) already ported and tested everything the Go
kernel needs to admit a gateway's contribution safely if one is ever
composed: the `gateway-trust` mount class, `NetworkAccessIntent`, and the
multi-container/network executor. This decision is about the layer above
that — whether Isthmus adopts the TypeScript orchestration that would
actually produce and manage such a contribution.

**What the feature does, read directly from `container-runner.ts` and
`gateway-providers/gateway-provider-registry.ts` at the v2.4.0 tag:**

1. A single, pluggable "gateway provider" (`GatewayProviderDefinition`) is
   selected process-wide (`NANOCLAW_GATEWAY_PROVIDER`). It exposes
   `sessions.ensure()`, returning a `GatewaySessionLease` whose typed
   `GatewayContribution` (mounts/containers/env/labels/`networkAccess`) is
   what actually reaches `composeSessionSpec` and, from there, the
   kernel-validated `SessionSpec` — the part Workstream A/B built to
   receive.
2. `ensureGatewaySession()` is called on every spawn; its lease is watched
   for the container's entire lifetime (`watchGatewayAvailability`) — if the
   gateway reports unavailable mid-session, the container is killed
   immediately (`killContainer(sessionId, 'gateway-unavailable')`), not just
   refused at spawn time.
3. `stopGatewaySessionsForUnavailability(reason)` is a host-wide circuit
   breaker: closes admission and kills every active session the moment the
   selected gateway can no longer authorize requests.
4. The provider contract also owns a **separate approval subsystem**
   (`GatewayProviderDefinition.approvals`: `subscribe`/`decide`/`listPending`,
   optionally `durable`) that translates the gateway's own native approval
   protocol into an approval UX — parallel to, and independent of, Isthmus's
   existing `guard()` / `src/modules/approvals/` pipeline.
5. Every spawn (gateway or not) is gated through a **cross-host session
   claim** (`session_claims`, `host_instances`, `claimSessionRun`,
   `getLiveHostInstance`) — a compare-and-set lease keyed by a durable host
   instance id, explicitly built so "two live hosts must never trade a
   session back and forth." `claimantId()` falls back to
   `hostname:pid` only when no host-instance lease is running.

## Decision

**Decline the multi-host claim/lease layer outright. Defer the
gateway-provider orchestration layer (contribution, availability-watching,
its own approval subsystem) until Isthmus actually has a gateway provider
to run — do not port it speculatively. If/when that happens, build a
narrower, single-host version that reuses Isthmus's existing approval
primitives instead of the upstream provider-native approval contract.**

Checked against all nine laws (`docs/design-laws.md`):

- **LAW-01 / LAW-02** (flexible above, rigid below; no Go for ordinary
  customization) — not a blocker either way. Everything in this feature is
  TypeScript; only the resulting mount/network shape crosses into the
  kernel, and that admission path is already built and tested. Adopting or
  declining the orchestration layer requires zero Go changes.
- **LAW-03** (compatibility before feature growth) — argues against rushing
  this. The compatibility prerequisite this promotion actually owes upstream
  — the kernel/wire-protocol seam staying correct for whatever a future
  gateway contribution looks like — is already satisfied by Workstream A/B.
  Nothing in Isthmus today composes a gateway session (confirmed: no
  registered `GatewayProviderDefinition`, and `add-iron-proxy` — the one
  concrete gateway this bundle exists to support — is itself out of scope
  for this promotion per the plan's own Non-goals). Porting a large
  orchestration layer with no consumer is feature growth ahead of an
  actual need, which is exactly what LAW-03 orders after compatibility, not
  before.
- **LAW-04** (every security control needs low-friction UX) — mixed. The
  upstream approval-request shape (`GatewayApprovalRequest`: bounded
  `displayFields`, `trigger`, durable persisted decisions) is clearly
  designed with approval fatigue in mind, matching Isthmus's own approval
  ethos. But porting the gateway-provider's own **separate** approval
  contract verbatim would give users two distinct approval surfaces for
  privileged actions — `guard()`'s existing flow, and a second,
  gateway-native one. That is friction and incoherence LAW-04 exists to
  prevent. The fix is straightforward if/when this is built: a gateway
  provider that needs an approval decision should route through Isthmus's
  existing `guard()` / `modules/approvals/primitive.ts` machinery, not
  bring its own parallel one.
- **LAW-05** (every component must justify itself; a personal-agent
  architecture growing into a distributed system is the named failure
  signal) — the clearest and strongest signal, and it's exactly this
  feature's failure mode almost verbatim. `session_claims` /
  `host_instances` / cross-host liveness checks solve session-ownership
  coordination across **multiple concurrent host processes sharing one
  database** — a deployment topology Isthmus's own architecture doesn't
  have (`CLAUDE.md`: "The host is a single Node process"). Every piece of
  it — the CAS claim table, the live-peer-host check, the
  `hostname:pid`-fallback claimant identity — exists to answer a question
  ("which of several live hosts owns this session?") that has exactly one
  possible answer in Isthmus's deployment model. Importing it adds a new
  DB table, new CAS-race invariants to test and maintain, and a whole
  liveness-check code path, for zero behavioral difference in the only
  configuration Isthmus actually runs. This is declined outright,
  independent of the gateway-provider question — it is really a separate
  upstream feature (multi-host durability) tangled into the same diff, and
  belongs to Workstream D's classification, not adoption.
- **LAW-06** (contracts before rewrites) — procedural, not a go/no-go
  factor. Applies to whatever slice is eventually built: capture the
  chosen TS behavior in tests before any Go-side work, though per LAW-07
  below none should be needed.
- **LAW-07** (mechanism in Go; experience in flexible layer, read per this
  document's own "exclusive enforcement" annotation) — satisfied by
  construction, regardless of this decision. The real privileged effect —
  what gets mounted, what network a session can reach — is the
  `GatewayContribution`'s typed output, and that already terminates in the
  kernel-validated `SessionSpec` (Workstream A/B). The orchestration this
  ADR defers — lease-watching, approval translation, claim bookkeeping — is
  TS-side policy, not a privileged effect, the same category LAW-07's own
  annotation already says is fine to leave in TypeScript (`guard()` and
  `modules/approvals/` are exactly this today). Nothing here calls for
  moving anything further into Go.
- **LAW-08** (no weaker security than upstream) — not a blocker to
  declining. Upstream itself has no Go kernel, so every property this
  bundle provides is TS-enforced-by-convention there too; Isthmus's
  kernel-side admission (already built) is strictly stronger than
  upstream's own bar in this area whether or not the orchestration layer
  above it is ever adopted. The one real obligation this law creates: *if*
  a gateway provider is ever built, Workstream C1/C2's original
  bypass-tracing questions (can a session reach the gateway, or keep
  reaching it after unavailability, through a path that skips the
  fail-closed checks?) become load-bearing and must actually be done then
  — deferred, not waived.
- **LAW-09** (upstream moves independently) — neutral on this specific
  question; already satisfied by the process this promotion follows
  (`upstream-promotion-playbook.md`, this ADR itself).

## Consequences

- Workstream C1/C2 (`docs/promotion-v2.4.0.md`) stay **blocked, correctly**
  — they trace functions (`ensureGatewaySession`,
  `permitsConfiguredGatewayRead`) this decision declines to adopt for now.
  Re-open them only when a concrete gateway provider is actually being
  built for Isthmus.
- The multi-host claim/lease cluster (`session_claims`, `host_instances`,
  and everything in `container-runner.ts`'s diff that exists only to
  arbitrate between live host processes) is declined outright and should
  be classified Bucket C / `declined:non-goal` in the Workstream D file
  inventory, not left open for reconsideration by a future promotion
  unless Isthmus's deployment model itself changes to support multiple
  concurrent hosts.
- If/when Isthmus adopts a real gateway provider, the narrower design this
  ADR points at — single-host lease + fail-closed availability watching +
  typed contribution, routed through the *existing* `guard()`/approvals
  pipeline rather than a second one — should be its own ADR at that time,
  built against an actual consumer rather than speculatively.
- This is a decision to defer and narrow, not to violate a law: no
  exception is being taken against any of the nine, so no further
  ADR-internal justification is owed beyond this document.

## What would change this

A concrete request to install a gateway provider in Isthmus (e.g.
`add-iron-proxy`, or another), or a change to Isthmus's deployment model
that introduces multiple concurrent host processes against one database —
either would warrant revisiting this ADR and designing the narrower version
described above.

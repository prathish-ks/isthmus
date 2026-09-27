# ADR-030: Gateway adoption and multi-host coordination (supersedes ADR-029)

Status: decided 2026-09-25, same day as ADR-029. Supersedes it entirely —
recorded as a new ADR rather than an edit so the decision history stays
honest about what changed and why, per this project's own ADR convention.
Gates `docs/promotion-v2.4.0.md` Workstream C's tasks C1/C2 and adds new
tasks C7–C9.

## Why ADR-029 is being superseded, not just corrected in place

Two factual errors in ADR-029, found by reading `docs/gateway-seam.md`
(upstream's actual contract document) after the ADR was written, rather
than reasoning from the `GatewayProviderDefinition` type signatures alone:

1. **The approval subsystem is not duplicative.** ADR-029's LAW-04 concern
   was that adopting the gateway-provider contract verbatim would give
   users two parallel approval surfaces. It would not: `src/gateway-
   approval-coordinator.ts` is the *one* human-approval flow every gateway
   gets — approver resolution, delivery, the `pending_approvals` row, the
   card, persistence, retries, all core-owned and identical regardless of
   provider. A provider's `approvals.subscribe` is a thin protocol
   translator feeding that single flow; it "never talks to a channel,
   never touches `pending_approvals`, and never decides anything itself"
   (upstream's own words). This concern is retracted.
2. **Gateway-provider selection is mandatory, not optional.** ADR-029's
   LAW-03 reasoning ("defer — nothing consumes this yet") assumed adopting
   the orchestration layer was optional feature growth. It is not: "With no
   provider registered, the host refuses to start: there is no implicit
   default and no open-egress fallback" (upstream, verbatim). A ported
   v2.4.0 `container-runner.ts` will not boot without something
   implementing `GatewayProviderDefinition`. That something is most
   naturally OneCLI, upstream's own shipped default (`gateway.json`:
   `{"kind": "onecli", ..., "default": true}`) — meaning restructuring
   OneCLI into this contract is load-bearing, not optional, the moment
   Isthmus adopts the real upstream lifecycle code.

Also confirmed since ADR-029, by direct product direction rather than by
code-reading: multi-tenant, multi-replica cloud hosting is a real near-term
target for Isthmus, not speculative. That changes the LAW-05 calculus for
the multi-host claim/lease layer specifically (see below).

## What "the gateway" is, for the record

A **credential gateway** is the component that holds real secrets and
injects them at the network boundary, so no credential ever enters an agent
container (upstream's own definition, `docs/gateway-seam.md`). Isthmus
already has one — OneCLI. v2.4.0 does not introduce a new concept; it turns
the previously hardcoded OneCLI integration into a swappable seam
(`GatewayProviderDefinition`) so any implementation can plug in behind the
same three things: a typed session contribution (mounts/env/containers/
`networkAccess`), approval-event translation, and an optional read-only
account-connection handoff. Iron Proxy is a second, additional
implementation of that same seam — a self-hosted MITM proxy plus admin
console, which is what the `gateway-trust` mount class (Workstream A1)
exists to support: the public CA certificate the agent must trust for the
proxy's TLS interception to work, pinned and forced read-only, never a
credential itself.

## Decision

Adopt all three pieces, matching upstream v2.4.0, in this sequence:

**C7 (new) — Restructure OneCLI into `GatewayProviderDefinition`.**
Mandatory: this is what makes a ported v2.4.0 host bootable at all. Ports
`src/gateway-providers/onecli.ts`'s existing logic (session identity,
credential injection, `onecli-approvals.ts`'s manual-approval callback)
behind `sessions.ensure`/`approvals.subscribe`, matching upstream's own
default-gateway shape. Stays 100% TypeScript — see "What does NOT change
in Go," below.

**C8 (new) — Install Iron Proxy as the second, catalogued gateway option.**
On par with upstream's own two-gateway catalog (OneCLI default, Iron Proxy
opt-in via `/add-iron-proxy`). Exercises the `gateway-trust` mount class
and the multi-container/`networkAccess` executor Workstream A already
built and tested — the first real consumer of that work.

**C9 (new) — Port the multi-host claim/lease coordination
(`session_claims`, `host_instances`, `db/coordination.ts`,
`host-instance.ts`) in TypeScript.** Reverses ADR-029's decline of this
piece. Given multi-replica cloud hosting is now a confirmed direction, this
is cheap (a DB migration plus a bounded CAS-lease module, not a new
service, daemon, or network surface), already built and tested upstream,
and strictly cheaper to adopt now than to rebuild once a single-host
deployment already exists in production. Includes `availability.publish`/
`.read` — the mechanism for exactly the "approval handling and session
admission run in separate processes" case: one process owns the live
subscription to the gateway's native approval stream and publishes health;
every other replica watches that published health and gates its own local
session admission on it, without ever starting a second competing
subscription to the same native event stream.

## What does NOT change in Go

Nothing. The kernel stays exactly as Workstream A/B already built it: one
kernel per node (`net.Listen("unix", socketPath)` — inherently
machine-local, confirmed by reading `go-host/internal/kernel/server.go`
directly), admitting only the resulting mount/network *shape* a session
carries, blind to which TypeScript process or which gateway produced it.
This was the actual scope decision Workstream A made, and it holds
regardless of how many gateway providers or host replicas exist above it:

- Session-lease acquisition, approval-event translation, and per-provider
  credential handling are TypeScript, per LAW-01/LAW-02, in Isthmus exactly
  as upstream keeps them. No part of this ADR proposes moving any of that
  into Go.
- Cross-node/cross-replica coordination — which of several live TS host
  processes owns a given session — is also TypeScript (C9), arbitrated over
  the existing central DB. Each host process, wherever it runs, only ever
  talks to its *own* local kernel and its *own* local Docker daemon once it
  has won that arbitration. The kernel is not made aware that other
  replicas exist.
- This is the same LAW-07 "exclusive enforcement" reading ADR-029 already
  established and this ADR does not revisit: the real privileged effect —
  what gets mounted, what network a session can reach — is what must be
  physically impossible to produce except through the kernel. Which
  TypeScript module (single-host OneCLI, restructured OneCLI, Iron Proxy,
  a future gateway, or a multi-replica claim winner) decided to *ask* for
  that mount/network shape has never been the kernel's concern, and
  remains so.

## Checked against the nine laws (delta from ADR-029)

- **LAW-01/LAW-02** — unchanged: still fully TS-side, no Go work implied.
- **LAW-03** — reversed for C7/C8: no longer "feature growth ahead of
  need." OneCLI-as-provider is a compatibility requirement (the ported host
  must start); Iron Proxy is the confirmed, concrete feature this
  promotion is meant to deliver, not speculative growth.
- **LAW-04** — the specific concern is retracted (see above); adopting the
  real contract, with its single core-owned approval flow, is *more*
  LAW-04-compliant than a bespoke Isthmus-only shortcut would be.
- **LAW-05** — reversed for C9 specifically, now that the use case is
  confirmed real: this is DB-row coordination, not one of the law's named
  examples (bridges, daemons, gRPC, Redis, policy services), and it removes
  more complexity than it adds by reusing tested upstream code instead of
  designing bespoke multi-host arbitration later, under production
  pressure, without a reference implementation.
- **LAW-06/LAW-07/LAW-08/LAW-09** — unchanged from ADR-029's reasoning;
  none of today's corrections or confirmations touch them.

## Consequences

- `docs/promotion-v2.4.0.md` Workstream C: C1/C2 unblocked — they become
  real diligence once a gateway session actually exists (LAW-08 obligation,
  not optional once C7/C8 land). C7/C8/C9 added as new tasks.
- The plan's Non-goals section needs updating: "not scoped to install the
  add-iron-proxy skill itself" no longer holds and should be removed;
  scope is now explicitly on par with upstream v2.4.0's own gateway
  catalog.
- Workstream D's file inventory: the 6 rows classified `declined:non-goal`
  citing ADR-029 for gateway-provider orchestration files, and the 5 rows
  classified the same way for the multi-host coordination cluster, are
  reclassified — bucket A (seam-adjacent, feeds the kernel-validated spec)
  for the gateway-provider files, bucket A for the multi-host coordination
  files (touches the spawn path), both citing this ADR instead.
- This is genuinely new implementation work, not documentation — C7/C8/C9
  are each a real port, not a checkbox. Sequencing: C7 first (load-bearing
  for the host to start at all under a real v2.4.0 `container-runner.ts`),
  then C9 (independent of C7/C8, lower risk), then C8 (the most involved —
  a local Docker-built proxy, a Rails console, gRPC bridge dependencies).

## What would change this

Only a reversal of the confirmed multi-tenant cloud direction (back to
single-host only), which would make C9 premature complexity again per
ADR-029's original LAW-05 reasoning — narrow enough that it would warrant
its own future ADR if it happens, rather than assuming it here.

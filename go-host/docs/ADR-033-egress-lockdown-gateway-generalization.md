# ADR-033: Egress-lockdown gateway generalization

Status: decided and implemented 2026-09-26, v2.4.0 promotion, part of
Workstream D3's egress-lockdown auxiliary-gateway reconciliation item.

## Background

Upstream nanoclaw's v2.3.0→v2.4.0 diff generalizes `src/egress-lockdown.ts`
from a hardcoded assumption ("the OneCLI gateway is the only gateway, its
container name is `ONECLI_GATEWAY_CONTAINER`") to a `NetworkAccessIntent`-
based model: `ensureEgressNetwork(access: NetworkAccessIntent)` takes the
gateway to attach as a parameter instead of reading a hardcoded constant,
sourced per-session from `SessionSpec.networkAccess` (the same
`NetworkAccessIntent` type this promotion's Workstream A ported into
`internal/mount`/`drivers/types.ts` for gateway-trust/multi-container
support — see ADR-030). Upstream's own call site is `drivers/index.ts`'s
`dockerNetworkArgs(spec)`, invoked on every session wake.

Mechanically porting that call site is what Workstream D3 originally
flagged as needing reconciliation ("egress-lockdown auxiliary-gateway
generalization"). Investigating it directly (not assuming the mechanical
port applies) found it doesn't — Isthmus's own architecture already moved
the real decision point somewhere else, for reasons that predate this
promotion.

## Why a straight port doesn't fit

Per EC-02/ADR-016 (already implemented, unrelated to this promotion): the
Go kernel now performs the real `docker create`/`docker start`, not the
TypeScript `DockerSessionDriver`. Network topology became **kernel startup
configuration** — the `-docker-network` flag `nanogo serve` reads once at
boot — not a per-session field, because "the kernel never accepts a
caller-supplied network name" (ADR-016's own boundary). Isthmus's own code
already documents the consequence, in `docker-driver.ts`:

> "Network topology is driver-private: injected at registration... EC-02
> moves the actual `docker create`+`docker start` behind `internal/kernel`
> (ADR-016); the network flag becomes kernel STARTUP configuration... this
> driver no longer appends it to an argv it no longer builds. An overlay's
> `networkArgsFor` is retained on `DockerDriverOptions` for API
> compatibility and any TS-native realization step that still shells
> `docker` directly (**none does today**), but no longer participates in
> container creation itself."

So `drivers/index.ts`'s `dockerNetworkArgs(spec)` — the exact function
upstream's diff would generalize — is confirmed dead code for real spawns.
The live enforcement point is a *different*, same-named function in
`modules/kernel-supervisor/index.ts`, added by this project's own earlier
work (ADR-024/025/026, the "egress lockdown looked active and silently
wasn't" regression and its fix): it runs once at kernel boot, resolves
`ensureEgressNetwork()` with no session in scope, and pins the kernel's
network flag for the process's whole lifetime. Today it still calls the
old hardcoded-OneCLI `ensureEgressNetwork()` — the generalization gap is
real, just not where upstream's diff assumes it is: the moment a second
gateway (Iron Proxy, Workstream C8) ever becomes the configured default,
this startup check would keep trying to attach the wrong container name,
reproducing the exact "looks active, silently isn't" ADR-024 failure
shape this project already paid once to close.

Confirmed separately: upstream's matching `docker-driver.test.ts` diff
(auxiliary-container realization, `watchSessions`/`reapResidue` role
filtering) is TS-side multi-container *implementation* — the same thing
Workstream A's Go kernel already does, with live-Docker verification
(A3/A5). Not applicable here either, for the same reason.

## Decision

Generalize the *real* enforcement point instead of the dead one:

1. **`GatewayProviderDefinition` gains an optional, install-wide,
   session-independent descriptor**: `egressGateway?(): NetworkAccessIntent`.
   Deliberately not reusing `GatewayContribution.networkAccess`'s field
   name at this level, and deliberately not deriving one from the other,
   because they answer different questions that happen to share a type:
   `GatewayContribution.networkAccess` is a *per-session* declaration,
   Go-kernel-validated, about what network one session's containers may
   reach (still a placeholder `kind: 'host'` for OneCLI — Workstream C7's
   own "declared but unconsumed" staging, unrelated to this change).
   `egressGateway()` is an *install-wide* declaration, TS-host-consumed
   only, about which single Docker container the host's own
   egress-lockdown network should attach — meaningful before any session
   exists, which is exactly when kernel-supervisor needs it. Conflating
   them would mean either shipping a `kind: 'host'` placeholder somewhere
   that must be `kind: 'runtime'` to mean anything (breaking egress
   lockdown outright for the only gateway that ships in trunk), or
   quietly changing C7's own deliberate staging decision as a side effect
   of an unrelated change.
2. **`onecli.ts` implements it**: `{ endpoint: 'host.docker.internal',
   target: { kind: 'runtime', identity: ONECLI_GATEWAY_CONTAINER } }` —
   the exact value `egress-lockdown.ts` hardcoded before this change,
   just expressed through the generic contract instead of a literal
   import.
3. **`egress-lockdown.ts`'s `ensureEgressNetwork` becomes
   `(access: NetworkAccessIntent) => boolean`** (module-level
   `selectedAccess` remembers the last resolved value so
   `host-sweep.ts`'s periodic re-heal call, which has no session or
   gateway context of its own, can keep calling it with no argument).
   `gatewayAttached` is parametrized on `identity` the same way upstream
   does — but Isthmus's own newline-delimited exact-match membership
   check (a real hardening fix over upstream's space-join-then-split
   version, closing a container-name-with-a-space false-negative that
   would have misreported an attached gateway as absent) is preserved
   verbatim, not reverted to upstream's version.
4. **`kernel-supervisor/index.ts`'s startup check resolves the access from
   the configured gateway and fails closed if it can't**:
   `resolveEgressGatewayAccess: () => getGatewayProvider().egressGateway?.()`
   joins `DockerNetworkDeps` (the project's own existing injectable-deps
   pattern for this exact function, chosen originally because module-level
   `vi.doMock` proved flaky here). When lockdown is on and the configured
   gateway declares no `egressGateway()`, this throws explicitly — the
   same "refuse to start with unenforceable egress lockdown" contract
   ADR-025 established, now correct for *any* configured gateway, not
   just one that happens to be OneCLI.
5. **`drivers/index.ts`'s dead per-session call site is left untouched.**
   Its existing no-arg `ensureEgressNetwork()` call still compiles and
   still resolves via the same `selectedAccess` fallback — coincidentally
   correct, since kernel-supervisor's startup call will have already set
   it — but no effort was spent making its now-unreachable-in-production
   behavior more "correct" for a per-session model Isthmus's architecture
   no longer uses. Removing it entirely was considered and declined: it's
   explicitly retained today "for API compatibility and any TS-native
   realization step that still shells `docker` directly" per its own
   comment, and this ADR's scope is the real gap, not a cleanup pass.

## Consequences

- Closes the real half of Workstream D3's "egress-lockdown auxiliary-
  gateway generalization" item — the reconciliation D3 originally deferred
  turned out to need this architectural translation, not a mechanical
  diff-apply.
- The moment C8's Iron Proxy (or any future gateway) becomes the
  configured default with `NANOCLAW_EGRESS_LOCKDOWN=true` set, it now
  either declares a working `egressGateway()` or the kernel refuses to
  start — never a silent open-egress fallback. Today, with OneCLI as the
  sole shipped default, behavior is unchanged (same container name, same
  alias, same fail-fast contract).
- `docs/traceability.md`'s LAW-07/LAW-08 rows (egress-lockdown enforcement)
  should eventually cite this ADR alongside ADR-024/025/026 once this
  lands in the traceability update pass, for the same reason ADR-030 was
  added there for the gateway-trust boundary generally.

## What would change this

If Isthmus ever reintroduces a TS-native container-creation path that
bypasses the Go kernel (contradicting ADR-016's own boundary), the dead
per-session call site in `drivers/index.ts` would need the same treatment
as the kernel-supervisor path did here. Not expected; not designed for.

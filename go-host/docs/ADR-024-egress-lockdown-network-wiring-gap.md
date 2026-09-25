# ADR-024: Closing the EC-02 Regression That Silently Disabled Egress Lockdown

**Status**: Accepted, 2026-09-24.
**Found during**: a 2.4.0-baseline compatibility audit (unrelated task) that traced the kernel-mediated wake path end to end and noticed `drivers/index.ts`'s `dockerNetworkArgs` had no remaining caller.

## Context

`NANOCLAW_EGRESS_LOCKDOWN=true` (`src/egress-lockdown.ts`, documented in `docs/SECURITY.md` §5) is meant to force every agent container onto an isolated Docker `--internal` network with no route out except through the OneCLI gateway. Before EC-02 (ADR-016), this was wired per-spawn: `drivers/index.ts` registered a `networkArgsFor(spec)` closure on `DockerSessionDriver` that called `ensureEgressNetwork()` — idempotent, self-healing, and fail-fast (throws `EgressLockdownError` if the network/gateway can't be established) — and appended `--network <name>` to the `docker create` argv it built.

EC-02 moved `docker create`/`start` behind `internal/kernel` so a compromised or buggy TS process can no longer construct that argv directly. ADR-016 documented the necessary consequence for networking specifically: *"the network flag becomes kernel STARTUP configuration ... not a per-request field."* What wasn't traced through at the time is that `drivers/index.ts`'s `networkArgsFor` closure was never removed or rewired — it's still constructed, still registered on `DockerDriverOptions`, and `docker-driver.ts`'s own `prepare()` comment says plainly it's *"retained ... for API compatibility ... but no longer participates in container creation itself."*

The practical effect: `NANOCLAW_EGRESS_LOCKDOWN=true` still created and maintained the isolated network (`src/host-sweep.ts`'s 60-second sweep calls `ensureEgressNetwork()` unconditionally), so `docker network ls` showed exactly what an operator would expect to see. But no container was ever attached to it — the kernel's own `dockerExecutor` (`go-host/internal/kernel/exec.go`) builds `docker create` from a single, fixed `networkName` set once at `nanogo serve` startup via the `-docker-network` flag, which defaults empty unless the separate, undocumented `NANOCLAW_KERNEL_DOCKER_NETWORK` env var happened to be set to the same value — which nothing in the documented lockdown flow ever did. Every agent container landed on Docker's plain default bridge network with unrestricted egress, regardless of the lockdown setting, and `ensureEgressNetwork`'s own fail-fast guarantee (throw rather than silently spawn with open egress) never ran for a real spawn, because nothing on the live path called it anymore.

This is the same class of failure ADR-004/ADR-006/ADR-007 already found once for the mount allowlist (a real check, present in the code, quietly disconnected from the path that actually creates containers) — found here in the one other place network topology touches admission.

## Decision

Network topology for a kernel-mediated install stays kernel-startup configuration, per ADR-016 — that hasn't changed and shouldn't. What changes is *who computes it*: `src/modules/kernel-supervisor/index.ts` (the only thing that spawns `nanogo serve`) now derives the `-docker-network` flag from the same `EGRESS_LOCKDOWN`/`ensureEgressNetwork()` decision `host-sweep.ts` already keys off, instead of relying on a separate env var nobody wiring up documented lockdown would know to set:

- If `EGRESS_LOCKDOWN` is on: call `ensureEgressNetwork()` before spawning the kernel (restores the fail-fast property — a misconfigured lockdown now fails kernel startup loudly instead of silently spawning open) and pin `-docker-network` to `EGRESS_NETWORK`.
- If `NANOCLAW_KERNEL_DOCKER_NETWORK` is also set to a *different* value while lockdown is on, refuse to start rather than silently pick one — a conflicting configuration should be loud, not resolved by priority order.
- If `EGRESS_LOCKDOWN` is off, behavior is unchanged: `NANOCLAW_KERNEL_DOCKER_NETWORK` still works for any other custom-networking need, falling back to no `--network` flag (default bridge) when neither is set.

`spawnKernel` catches a failure here the same way it already handles a missing `nanogo` binary or an over-long socket path: log loudly, resolve `false`, don't crash the whole host's startup. This is a deliberate change from the pre-EC-02 behavior, where a failure here only failed one session's spawn — now every session shares one kernel-pinned network, so failing once, at kernel start, is strictly better than the old per-session failure this replaces, not a new fragility.

This ADR does **not** touch the now-fully-dead `dockerNetworkArgs`/`networkArgsFor` plumbing in `drivers/index.ts`/`docker-driver.ts` itself — removing it is a separate cleanup, tracked as a follow-up, not bundled into this fix to keep the security-relevant change minimal and reviewable on its own.

## Consequences

- `NANOCLAW_EGRESS_LOCKDOWN=true` now does what `docs/SECURITY.md` §5 says it does on a kernel-mediated install: every agent container is actually attached to the isolated network, not just co-located with one that exists.
- A misconfigured lockdown (gateway container not running) now surfaces as a loud, immediate kernel-startup failure instead of a silent, per-agent open-egress condition discoverable only by inspecting actual container network attachments.
- `src/modules/kernel-supervisor/index.ts`'s `dockerNetworkArgs`/`buildServeArgs`/`spawnKernel` are now exported and directly unit-tested (`index.test.ts`, six new cases) — this function had zero direct coverage before, which is part of how the regression went unnoticed for as long as it did.
- Follow-up, not done here: remove the dead `networkArgsFor` closure and its `DockerDriverOptions` field once nothing references it, so a future reader can't make the same "this looks wired in" mistake this ADR is closing.

## References

- `go-host/docs/ADR-016-p9-ec02-narrow-enforcement-boundary.md` — the decision that made network topology kernel-startup configuration in the first place.
- `docs/ADR-004-p5-02-mount-hardening.md` — the earlier instance of the same failure shape (a real check, disconnected from the live path) for mount validation.
- `docs/SECURITY.md` §5 ("Egress Lockdown (Forced Proxy)") — the user-facing guarantee this restores.
- `src/modules/kernel-supervisor/index.ts` (`dockerNetworkArgs`, `buildServeArgs`, `spawnKernel`), `src/egress-lockdown.ts` (`ensureEgressNetwork`, `EGRESS_NETWORK`), `go-host/internal/kernel/exec.go` (`dockerExecutor.networkName`) — the code this ADR describes.

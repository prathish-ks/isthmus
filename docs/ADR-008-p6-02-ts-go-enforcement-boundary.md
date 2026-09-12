# ADR-008: The TypeScript ↔ Go host API, and closing Phase 5's enforcement gap

Status: accepted, 2026-09-02, as task P6-02. Prerequisite: P6-01 (satisfied). Supersedes nothing; fulfills the commitment ADR-003 Decision 1 made when Phase 5 started: *"exclusive enforcement is explicitly P6-02's job (not pulled forward)."* This is that job.

## Context

Phase 5 delivered five Go packages (`mount`, `containerdefaults`, `ownership`, `credential`, `security`) that **validate** a fully-composed session/build/kill request. Nothing in Phase 5 **executes** anything — `container-runner.ts` still calls `docker` directly, whether or not it consulted a Go validator first. The Phase 5 readiness review named this precisely: a passing differential-parity test proves the *decision* matches; nothing proves the *effect* is actually blocked when it should be. design-laws.md's LAW-07 annotation is exact about what closing this requires: `wakeContainer`, `buildAgentGroupImage`, and `killContainer` must become "physically uncallable except through a boundary the kernel itself checks."

Two decisions were needed to close this gap: what the boundary's shape is (the five primitives master-plan P6-02 names), and what transport carries it.

## Decision 1: `internal/kernel` is the single exec chokepoint

A new Go package, `internal/kernel`, is the only code in the module (and, once wired, the only code in the *host process*) with a path to `os/exec`-invoke `docker` for `create`/`start`/`build`/`kill`. Its `CapabilityRequest` handler runs the relevant Phase 5 validators — `mount.ValidateSpec`, `containerdefaults.ValidateRunAs`/`EnforceSafeDefaults`, `ownership.ValidateID` — and only on a pass constructs and runs the `Executor` call. Every handler function returns before constructing an `Executor` call on any denial path; there is no "validate, then separately call exec, and trust the caller checked" pattern — `kernel_test.go`'s `*_NeverReachesExecutor` tests assert the executor's call count is exactly zero on every denial branch, which is what actually distinguishes enforcement from advisory validation.

Two non-obvious calls, both closing a real bypass:

- **`container.kill` takes a `sessionID`, never a container name.** The kernel resolves the name from its own `lifecycle.Registry`, populated only by a `container.wake` this same process performed. A caller cannot ask the kernel to kill a container it did not itself spawn — `TestCapabilityRequest_Kill_ResolvesNameFromOwnRegistry_NotFromCaller` is the test that would fail if this regressed to "trust the caller's name."
- **`container.build_image`'s build context directory is derived, never caller-supplied.** `CapabilityRequestPayload` has no `buildContextDir` field at all (`TestCapabilityRequest_BuildImage_HasNoCallerSuppliedContextDirField` documents this as a compile-time property, not a runtime check). The kernel joins `GroupsRoot` with the caller's `groupFolder`, itself checked against `mount.LabelValueLegal`.

### Reconciling `buildAgentGroupImage`'s classification

`docs/host-decomposition.md` (#4) calls `buildAgentGroupImage` "genuine KEEP TYPESCRIPT... not on any runtime hot path... developer convenience, not security posture," written before LAW-07's sharpened reading existed. `design-laws.md`'s later annotation names it as one of the three enforcement targets regardless. This ADR follows `design-laws.md`: hot-path status is irrelevant to whether an operation can construct a privileged Docker invocation. Leaving `buildAgentGroupImage` directly TS-callable while gating `wakeContainer`/`killContainer` would relocate the bypass, not close it — an attacker (or a bug) doesn't need the hot path, only *a* path. `host-decomposition.md`'s risk framing is still honored in what's validated: build's structural checks stay deliberately thin (tag format, group-folder legality, non-empty Dockerfile) rather than inspecting Dockerfile content, because inspecting build recipes is exactly the ordinary per-skill customization LAW-01/LAW-02 keep flexible.

## Decision 2: five primitives, one coarsened per-op contract

`route.request`, `session.lookup`, `capability.request`, `delivery.request`, `status.trace` — the master plan's own list, implemented as one dispatch surface (`Kernel.Dispatch`, `server.go`) rather than one call per underlying Go function. `internal/routing`'s seven pure functions (P4-02) and `internal/delivery`'s four (P4-04) were designed as an in-process library, before there was a process boundary between caller and callee. Exposing each as its own socket round trip would mean 5-7 network hops per inbound message; `route.request`'s `Kind: "wiring" | "unwired"` discriminator bundles `EvaluateEngage` → `DecideWiringOutcome` → `EffectiveSessionMode`/`ResolveThreadPolicy`/`MessageIDForAgent` into the one call shape `router.ts`'s fan-out loop actually needs per wiring.

`session.lookup` reuses `internal/session`'s existing SQLite-backed reads (P4-01) unmodified, including the one write path (`ResolveSession`, find-or-create) — included here rather than gated behind `capability.request` because ordinary session bookkeeping is mechanism already classified GO KERNEL in Phase 4, not a Docker-facing privileged action LAW-07 scopes enforcement to.

`delivery.request` is decision-only by design: `internal/delivery.ResolveDeliveryTarget`/`ClassifyOutboundMessage`/`NextAttempt` run behind it, but the actual send still goes through TypeScript's channel-adapter registry — `host-decomposition.md` (#5) is explicit that registry is a first-class, essentially universally-used extension point, and moving it would violate LAW-01 for a decision (destination authorization) that's already guard-shaped and separable.

`status.trace` is read-only and additive: it required one new method (`lifecycle.Registry.RunningSessionIDs`) alongside the existing `IsRunning`/`Get`/`Register`/`Unregister`/`Wake` — no existing method's behavior or signature changed.

## Decision 3: transport is a Unix domain socket, JSON envelopes — not gRPC

LAW-05 requires every component to justify itself against the complexity it adds. A boundary with exactly one legitimate local peer (the same-host TypeScript process) gains nothing from gRPC, mTLS, or a token store — those solve multi-tenant or networked authentication problems this host doesn't have. The socket file is created mode `0600`; only the process owner's user can connect at all, which is the entire authentication story and is sufficient for a single-user personal-agent product (`TestServe_RoundTripOverUnixSocket` pins the mode). If NanoClaw ever hosts multiple users' agents behind one kernel process, or the kernel moves off-host, this decision is the one to revisit — that is a materially different threat model, not a reason to add the complexity preemptively today.

Every envelope carries a literal `"version": "v1"`. A version bump is required for any request/response shape change, any new `Capability` value, or any change — tightening or loosening — to a non-capability constraint; `v1`'s shape is otherwise frozen.

## Explicit non-capabilities

(Full list and rationale: `internal/kernel/doc.go`'s package comment — reproduced here per P6-02's own done-when, "explicit non-capabilities.")

1. No raw command line, argv, or shell string ever reaches a caller-writable field — `internal/kernel` always constructs the exact `docker` argv itself.
2. No operation can name an arbitrary container to kill (kill resolves names from the kernel's own registry only).
3. No operation can widen a mount class, inject an extra mount post-validation, or bypass the mount allowlist — `mount.ValidateSpec` runs against exactly the `Session` value received.
4. No build invocation accepts extra Docker flags or a caller-chosen context directory — a fixed flag set, kernel-derived path.
5. No credential value crosses the socket — only structured mount/contribution descriptors (`internal/credential.GatewayContribution`), with `mount.IsSecretShaped`/`LooksLikeCredential` as a backstop.
6. The socket is not a network listener and carries no auth token/TLS — file permissions are the entire access control, matching the personal-agent threat model this project targets.

## Consequences

- `container-runner.ts`'s three named functions (not yet rewired in this pass — see "Not done in this ADR," below) will, once rewired, no longer contain a `docker` invocation at all; they become thin callers of a `capability.request` envelope.
- Every existing Phase 4/5 Go package remains unmodified except `lifecycle.Registry`, which gained one additive read method.
- `internal/kernel`'s own test suite (`kernel_test.go`, 22 cases, including a real Unix-socket round trip and a `-race` run) is the first Go test suite in this project that asserts an *executor call count*, not just a decision value — the concrete difference between testing validation and testing enforcement.

## Platform note: a second macOS-only failure, caught by the user's own test run

The same lesson Phase 5's symlink bug taught (sandbox verification alone is not sufficient for platform-dependent filesystem behavior) recurred in a new shape here. `TestServe_RoundTripOverUnixSocket` passed cleanly in the Linux sandbox (0.01s) and failed on the user's real Mac with `connect: invalid argument`. Root cause: the test built its socket path under `t.TempDir()`, which on macOS nests deeply (`/var/folders/<x>/<x>/T/<TestName+random>/001/kernel.sock`) — 108 bytes in the failing run, one byte over Linux's `sockaddr_un.sun_path` limit and four over macOS's stricter 104-byte limit. Linux's own limit happened to be just wide enough that the identical path never failed in the sandbox at all.

Fixed two ways, not one: the test now builds its socket path directly under `/tmp` (short and stable on every POSIX target this project runs on) instead of `t.TempDir()`. `Serve` itself gained an upfront length check (`maxSocketPathLen = 104`, the stricter of the two real limits) that turns a cryptic OS errno into an actionable error — the same LAW-04 "deny reasons must not be swallowed" discipline `mount.ValidationError`'s `Kind`/`Detail` split already applies elsewhere. `TestServe_RejectsSocketPathOverPlatformLimit` pins the new check. Re-verified clean (build/vet/gofmt/test -race, whole module) in the sandbox; the corrected `server.go`/`kernel_test.go` have been delivered and committed to the Mac, superseding the first copies.

## Not done in this ADR (explicitly deferred, not forgotten)

Rewiring `container-runner.ts`'s three functions to actually dial the socket instead of calling `docker` is a TypeScript-side change against the live `nanocoai/nanoclaw` codebase (or this project's pinned baseline), not a Go one. It is scoped to P6-03/P6-04's compatibility work rather than P6-02's own done-when ("a small versioned API/protocol with examples and explicit non-capabilities" — satisfied by this ADR plus `internal/kernel`). Standing up `cmd/nanogo` to actually run `Kernel.Serve` as the host process's long-lived kernel listener is likewise a wiring task for whichever phase moves the project from "Go packages exist" to "a Go process runs alongside the TS host" — tracked as an open item for Phase 7+ (Release Engineering) rather than invented here.

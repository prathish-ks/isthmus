// Package kernel is P6-02's deliverable: the minimal TypeScript ↔ Go host
// API, and — per ADR-003 Decision 1 and the design-laws.md LAW-07/OBJ-04
// annotation — the point where Phase 5's validation becomes real exclusive
// enforcement.
//
// # Why this package has to exist (not just a protocol doc)
//
// Phase 5 (internal/mount, internal/containerdefaults, internal/ownership,
// internal/credential, internal/security) delivered VALIDATION functions:
// given a fully-composed SessionSpec/RunAs/Resources, they decide allow or
// deny. Nothing in Phase 5 executes anything. TypeScript's container-runner.ts
// still calls `docker` directly after consulting — or, if a bug or a
// compromised dependency skips the call, WITHOUT consulting — those
// validators. That is advisory, not enforcement: the Phase 5 readiness
// review named this precisely, and design-laws.md's LAW-07 annotation
// scopes the fix to three named functions (wakeContainer, buildAgentGroupImage,
// killContainer) becoming "physically uncallable except through a boundary
// the kernel itself checks."
//
// This package is that boundary. A Go process (cmd/nanogo, already the
// module's binary entry point) listens on a Unix domain socket and is the
// ONLY process on the host with a code path that shells out to `docker` for
// the three named operations. TypeScript's container-runner.ts stops calling
// `docker` for those three operations itself; it sends a CapabilityRequest
// over the socket instead. The validators from Phase 5 run inside this
// package, in the same process that then does — or, on denial, does NOT do —
// the exec. There is no longer a window between "decide" and "act" that a
// direct call from anywhere else in the TS process could exploit, because
// acting is no longer a TS-reachable code path at all for these three
// operations.
//
// # Reconciling a documented tension
//
// docs/host-decomposition.md (#4) classifies buildAgentGroupImage as "genuine
// KEEP TYPESCRIPT... not on any runtime hot path... developer convenience,
// not security posture," written before LAW-07's sharpened reading existed.
// design-laws.md's later LAW-07 annotation explicitly names all three
// functions, buildAgentGroupImage included, as the concrete enforcement
// target. This package follows design-laws.md: hot-path status is irrelevant
// to whether an operation can construct a privileged Docker invocation
// (`docker build` runs a Dockerfile with host build-context access same as
// `docker create`/`docker kill` touch a live container) — leaving
// buildAgentGroupImage directly TS-callable while gating the other two would
// just relocate the bypass, not close it. host-decomposition.md's risk
// framing (low priority to port, safe to iterate on) is still correct and is
// exactly why buildAgentGroupImage's VALIDATION stays intentionally thin here
// (path/tag structure only, see capability.go) — the point isn't to relitigate
// Dockerfile content, only to make the exec itself single-chokepoint.
//
// # The five primitives (master plan P6-02's exact list)
//
//  1. RouteRequest      — one coarse call composing internal/routing's
//     already-ported pure functions (EvaluateEngage, DecideWiringOutcome,
//     NoAgentEngaged, DecideUnwiredChannel, EffectiveSessionMode,
//     MessageIDForAgent, ResolveThreadPolicy) into a single routing verdict
//     per inbound message, instead of seven round trips across the socket.
//  2. SessionLookup     — read-only reads against internal/session's
//     existing SQLite-backed store (Get/Find/FindForAgent/FindByAgentGroup).
//  3. CapabilityRequest — the enforcement seam: validate (Phase 5 packages),
//     then — and ONLY on a validation pass — execute, for exactly the three
//     capabilities container.wake / container.build_image / container.kill.
//  4. DeliveryRequest   — a decision-only call (internal/delivery's
//     ResolveDeliveryTarget/ClassifyOutboundMessage/NextAttempt/InflightGuard).
//     TypeScript still executes the actual send through the channel-adapter
//     registry — LAW-01/LAW-02 keep that flexible; only the permission
//     decision, which is guard-shaped, moves behind this boundary.
//  5. StatusTrace       — read-only introspection: which sessions the
//     kernel currently believes are running (internal/lifecycle.Registry),
//     and a bounded audit log of the kernel's own recent capability
//     decisions, so an operator or a debugging skill can ask "what did the
//     kernel actually decide and why" without needing shell/log access.
//
// # Explicit non-capabilities (P6-02's own done-when: "no security bypass
// knobs")
//
//   - No operation accepts a raw command line, argv array, or shell string.
//     CapabilityRequest's payload is a small closed set of typed fields;
//     internal/kernel always constructs the exact `docker` argv itself. There
//     is no field that reaches a command line unvalidated.
//   - No operation can name an arbitrary container to kill. container.kill
//     takes a sessionID; the kernel resolves the container name from its OWN
//     lifecycle.Registry (populated only by a container.wake this same
//     process performed) — never from a caller-supplied name. A session this
//     kernel did not itself spawn cannot be targeted.
//   - No operation can widen a mount class, add an extra mount after
//     validation, or pass a mount-allowlist override. mount.ValidateSpec runs
//     against the exact Session value received; the kernel never merges in
//     additional mounts of its own or accepts a "skip validation" flag.
//   - No operation can request build-time Docker flags (`--network`,
//     `--add-host`, `--mount`, `--privileged`, `--cap-add`, etc.) or a build
//     context path outside the caller's own group directory. Build
//     invocations use a fixed flag set; only the image tag and Dockerfile
//     content (ordinary per-skill customization, per host-decomposition.md's
//     own framing) are caller-supplied.
//   - No credential value ever crosses the socket. CapabilityRequest's
//     gateway-contribution field carries internal/credential's
//     GatewayContribution shape (mount descriptors), never a secret value —
//     internal/mount.IsSecretShaped/LooksLikeCredential still runs as a
//     backstop (see security_test.go's area 6).
//   - The socket itself is not a network listener: a Unix domain socket file,
//     mode 0600, created by and readable only by the host process's own user.
//     No auth token, TLS, or RPC framework — LAW-05 ("every component must
//     justify itself... don't add distributed-system complexity a
//     personal-agent use case doesn't need") rules out gRPC/mTLS/a token
//     store for a boundary that only ever has one legitimate local peer.
//     ADR-009 (see docs/) records this choice and what would change it
//     (multi-tenant or remote hosting would).
//
// # Versioning
//
// Every envelope carries a literal protocol version ("v1" today). A version
// bump is required for any change to a request/response shape, a new
// Capability value, or a new non-capability constraint being added or
// relaxed — never a silent shape change on "v1". This is what P6-02's
// done-when means by "small versioned API."
package kernel

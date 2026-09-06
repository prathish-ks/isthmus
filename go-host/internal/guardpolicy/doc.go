// Package guardpolicy is Phase 9 EC-04's Go port of the narrow slice of
// src/guard that gates the three Docker-facing kernel capabilities:
//
//   - src/cli/guard.ts's commandDecide, as consulted for the `restart`
//     command (src/cli/resources/groups.ts) — the CLI-derived guard that
//     stands between an agent and container.kill/container.wake.
//   - src/modules/self-mod/guard.ts's install_packages/add_mcp_server gate —
//     the guard that stands between an agent and container.build_image.
//
// See docs/ADR-015-p9-ec04-kernel-side-guard-verification.md for why this
// package exists as a kernel-side, DB-backed policy engine rather than a
// decision mirror consulted by a TypeScript call site: a mirror consulted
// only before the kernel client is called reproduces the exact bypass
// LAW-07 exists to close, because nothing stops a different call site from
// reaching the kernel client directly. This package is instead designed to
// be consulted BY the kernel itself, from facts the kernel reads from its
// own database connection — never facts a caller merely asserts — mirroring
// the same "resolve the security-relevant fact ourselves" discipline
// internal/kernel's own container-name resolution already established for
// the kill capability.
//
// # Scope, deliberately narrow, confirmed against real source
//
// Every other action in the 43-fixture guard catalog (a2a.send,
// agents.create, senders.admit, channels.register, every CLI command other
// than restart, guard()'s own fail-closed backstops) gates something that
// never reaches internal/kernel's three capabilities and stays permanently
// TypeScript-only — see EC-04-guard-scope-design-notes.md for the full
// accounting. Porting those would violate LAW-01/LAW-02 for no security
// benefit.
//
// # What is, and is not, independently verified
//
// CLIScope and grant liveness/match are read by this package's caller from
// the shared central DB (container_configs, pending_approvals) — the same
// tables TypeScript's own migrations 014, 015, and the pending-approvals
// migration create — via the Lookup interfaces below, never taken as a
// caller-supplied value. Actor identity itself (which agent group a given
// kernel request actually originates from) is NOT independently verified in
// v1: the TypeScript host process is the sole terminus of every
// per-container connection, and the kernel has no channel to that fact
// other than the host's own assertion. ADR-015 records this limit
// precisely rather than glossing over it.
package guardpolicy

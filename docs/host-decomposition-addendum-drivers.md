# Host Decomposition Addendum: `src/drivers/`

**Status**: committed 2026-09-02, as pre-Phase-5 prep. Extends `host-decomposition.md` (P1-01) with a component that document's own scope note flagged as unread ("the concrete Docker driver in `src/drivers/`... not read, P1-02 territory") but which was never actually classified in P1-02, P1-03, or P1-04 either. Verified directly against the pinned `go-host-experiment` checkout (`v2.3.0` / `54d9d9a5`).

## Why this addendum exists

`host-decomposition.md`'s summary table has 15 numbered components. None of them is `src/drivers/`. `threat-model.md` states the Docker-facing authority surface is exactly `container-runner.ts`'s three exported functions (`wakeContainer`, `buildAgentGroupImage`, `killContainer`) — but this project's own later work (the mount-validation hardening PR, [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680)) found a real, code-verified gap one layer deeper: `DockerSessionDriver.prepare(spec)` — not any of the three named functions — is the actual unconditional chokepoint every `SessionSpec` passes through before real Docker realization, because it calls `validateSpec(spec, policy, capabilities)` as its literal first line. That correction has so far lived only in the out-of-repo `assessment.md`. This addendum brings it into the committed record and gives `src/drivers/` the classification entry it was missing.

## 16. Driver seam — `src/drivers/types.ts`, `src/drivers/index.ts`, `src/drivers/docker-driver.ts`

The abstraction between a fully-composed `SessionSpec` and its realization as an actual running container (or, per the seam's own design, a future non-Docker runtime — `runtimeTier: 'container' | 'vm'` and a driver registry already anticipate this).

**`types.ts`** (`SessionSpec`, `ContainerSpec`, `MountSpec`, `MountClass`, `MountPolicy`, `DriverCapabilities`, `SessionDriver`, `validateSpec`, `mountAllowed`, `isSecretShaped`, `looksLikeCredential`, `classRequiredByPath`) is the shared contract every driver realizes and the seam's own security logic. Genuinely striking property, worth stating plainly: **this file has zero external imports** — no DB, no config, no other project module. It is pure, self-contained TypeScript, executable in complete isolation from the rest of the codebase (confirmed directly: the fixture capture in `docs/mount-validation-fixtures-p5.md` runs `validateSpec` standalone via `tsx`, with nothing but the file itself). That property makes it an unusually clean Go-port target — closer to `guard.ts`'s profile (small, no hooks, no I/O) than `container-runner.ts`'s 958-line, multi-concern composition file the original #4 entry correctly flagged as too large for a first slice.

**`index.ts`** is driver *selection*: a registry (`registerSessionDriver`/`getSessionDriverFactory`), config resolution (`NANOCLAW_RUNTIME_DRIVER`, defaulting to `docker`), and the `MountPolicy` construction that feeds `validateSpec` (`mountPolicy()`, deriving `groupsRoot`/`dataRoot`/`surfaceRoots`/`materialsRoot` from `config.ts` and `process.cwd()`). This is orchestration/composition-root material, structurally similar to `src/index.ts` (#1) — no logic of its own worth porting independent of `validateSpec` itself.

**`docker-driver.ts`** (not read in full this pass — 30KB, flagged for a dedicated read before P5-02 begins in earnest) is the concrete `DockerSessionDriver`, whose `prepare(spec)` is the chokepoint described above.

**The mount-class taxonomy has grown since `host-decomposition.md` #10 was written.** That entry describes three classes (`group-state`/`install-surface`/`allowlisted-extra`); the pinned baseline's `MountClass` type already has **four**: `identity-material` was added for "provisioner-emitted certs and keys for an auxiliary container's leased identity," pinned read-only and structurally forbidden from ever mounting into the `agent` role — confirmed enforced by direct execution (see the fixture capture's `identity-material-into-agent-role-rejected` and `identity-material-writable-rejected-even-on-non-agent-role` cases). `host-decomposition.md` #10 is not wrong, exactly, but it undersells the current state — the mount-security posture at the pinned baseline is more developed than that entry suggests, in one specific, real, positive direction (the identity-material invariant), alongside the one real negative (the `allowlisted-extra` unconditional-trust gap `mount-security-hardening.patch` already fixes upstream but not yet in this project's pinned tree).

- **Classification**: `types.ts` — **GO KERNEL**, same profile and same priority tier as `guard.ts` (#7) and `mount-security/index.ts` (#10): small, self-contained, zero external dependencies, deterministic (spec in → allow/deny out), no customization hooks. `index.ts` — **KEEP TYPESCRIPT**, composition/config-resolution glue, same reasoning as `src/index.ts` (#1). `docker-driver.ts` — **UNDECIDED**, same reasoning as `container-runner.ts` #4 (large, threads together Docker-CLI-shelling, label stamping, network topology, and the driver-capability contract) — not read closely enough this pass to classify further; flagged as a required read before P5-02's actual implementation, not before this addendum.
- **Risk**: `types.ts`'s `validateSpec` is, by the chokepoint argument above, at least as high-value and high-risk a port target as `guard.ts` itself — arguably higher, since it is the literal last line of defense before real Docker realization, with no decision layer downstream of it the way `guard()` has actions gated both before and after it. `threat-model.md`'s framing should be read as "three functions **plus** `driver.prepare()`" going forward, not "exactly three functions" — the exhaustive call-site enumeration that document did for the three named functions has not yet been done for `driver.prepare()`'s own call sites (there may be more than one driver realization, or more than one path to `prepare()`, once the registry's overlay mechanism is used for anything beyond the single shipped `docker` kind).

## Summary table update

| # | Component | Classification |
|---|---|---|
| 16 | `drivers/types.ts` (`validateSpec`, mount-class taxonomy) | **GO KERNEL** |
| 16b | `drivers/index.ts` (driver selection/config) | KEEP TYPESCRIPT |
| 16c | `drivers/docker-driver.ts` (`DockerSessionDriver`) | UNDECIDED (not read closely this pass) |

## Consequences for `threat-model.md`

`threat-model.md`'s "Docker-facing authority surface, exhaustively enumerated" table should be read alongside this addendum as covering the *pre-driver* call sites only. A complete enumeration would add a row for `driver.prepare()` itself and trace every path that can reach it — not just through `wakeContainer`'s `buildMounts()` composition, but any hypothetical direct construction of a `SessionSpec`. That full enumeration is out of scope for this addendum (it requires the `docker-driver.ts` read flagged above) but should happen before, not during, P5-02.

## References

- `host-decomposition.md` (P1-01) — the document this addendum extends; entry #4 (`container-runner.ts`) and #10 (`modules/mount-security/index.ts`) for the classification precedents this addendum follows.
- `threat-model.md` (P1-04) — the authority-surface table this addendum's "plus `driver.prepare()`" correction applies to.
- `docs/mount-validation-fixtures-p5.md` — the direct-execution evidence for the mount-class taxonomy and identity-material claims above.
- `mount-security-hardening.patch` / [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680) — the corrected chokepoint finding this addendum formalizes into the committed record.
- ADR-003 — the enforcement-architecture decision this component's eventual Go port feeds into.

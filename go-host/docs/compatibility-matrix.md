# NanoClaw ↔ Go Kernel Compatibility Matrix

Status: living document, established 2026-09-03 (Phase 9, P9-09). Current as
of the pinned baseline in `docs/upstream-pin.json` (nanocoai/nanoclaw
`v2.3.0`) and `ADR-017-p9-07-upstream-overlap-review.md`'s review. Companion
to `version-compatibility.md` (P9-08 — the adapter-boundary/deprecation
mechanics this matrix is the current snapshot of).

**2026-09-26 update**: the "Gateway-trust / multi-container isolation" rows
below reflect work already implemented and tested on
`feat/mount-gateway-trust-class`/`feat/gateway-provider-seam`
(`docs/promotion-v2.4.0.md`'s Workstream A) — ahead of the pin itself, which
has not yet moved to `v2.4.0` (Workstream G's job, gated on Workstream H).
Per Workstream C5's accounting, this promotion produced zero open
acceptance records, so no row here is held below its earned rating by that
mechanism — every rating below reflects actual verification status, not a
placeholder pending an accepted-risk review.

Three ratings, matching this task's own "Done when" wording:

- **Stable** — this exact contract is independently enforced (or, for a
  read/format compatibility row, independently verified) by the Go kernel
  today, with tests exercising it, and no known open question against the
  pinned upstream baseline.
- **Preview / Pending** — prototyped, partially covered, or a known
  compatibility question is open and not yet resolved. Not something a
  deployment should depend on for its security properties yet.
- **Unsupported** — deliberately out of scope, or known/expected to be
  incompatible with a Go-kernel deployment as currently designed.

## Enforcement surface (what the kernel actively gates)

| Capability | Rating | Notes |
|---|---|---|
| `container.wake` mount/session admission (`validateSpec`/`mountAllowed`) | **Stable** | `internal/mount`, exercised by unit tests, differential parity fixtures (`docs/parity-schema.md`), and `FuzzValidateSpec` (P9-02). The one physical Docker `create` path (EC-02) runs this validator unconditionally — ADR-016/ADR-017 confirm this is still the real upstream chokepoint at v2.3.0. |
| Safe container defaults (non-root, resource caps) on `container.wake` | **Stable** | `internal/containerdefaults`, `FuzzEnforceSafeDefaults` (P9-02). |
| `container.kill` — resolves the target by session id from the kernel's OWN registry, never a caller-supplied container name | **Stable** | `internal/kernel`'s `handleKill`; `TestCapabilityRequest_Kill_ResolvesNameFromOwnRegistry_NotFromCaller`, `TestKill_ThenKillAgain_SecondCallReturnsUnknownSession` (P9-03). |
| `container.build_image` — build context is kernel-derived, never caller-supplied | **Stable** | `internal/kernel`'s `handleBuildImage`; `TestCapabilityRequest_BuildImage_RejectsIllegalTag_NeverReachesExecutor`. |
| Session/agent-group/mailbox path identity (no traversal via forged ids) | **Stable** | `internal/ownership`; `FuzzValidateID`, `FuzzSafeMailboxPath` (P9-02) — the latter found and fixed a real path-traversal bug in `SafeMailboxPath`'s unvalidated `side` parameter this same phase. |
| CLI-restart guard (`restart` command specifically), re-verified from the kernel's own DB read | **Stable, narrow** | `internal/guardpolicy`'s `DecideRestartLike`/`EvaluateWithGrant`; 13 golden fixtures ported from `fixtures-guard-catalog.test.ts`, plus P9-04's lookup-error/fail-closed suite (`corruptstate_test.go`) and `FuzzDecideRestartLike` (P9-02). Explicitly narrow — see the guard-catalog row below. |
| Self-mod guards (`install_packages`, `add_mcp_server`), re-verified from the kernel's own DB read | **Stable, narrow** | Same package; ADR-015's own scope statement. Same P9-04 lookup-error coverage now extends here too (`TestEvaluateSelfModWithGrant_ApprovalLookupErrorPropagates`, `TestDecideSelfMod_ImageBuildCapabilityErrorFailsClosed`). |
| Rest of the CLI guard catalog (every command other than `restart`) | **Unsupported (by design)** | Deliberately TypeScript-only — ADR-015/EC-04's own scope decision, not a gap this phase closes. Porting the rest of the catalog is a distinct, larger future task, not implied by anything in Phase 9/10. |
| Crash/restart session-tracking recovery | **Preview / Pending — documented gap, not a bug** | `internal/lifecycle.Registry` is purely in-memory; a `nanogo serve` restart always starts from zero session tracking (P9-03's `restart_test.go` pins this exactly). Real cleanup after a kernel restart depends on the TypeScript host's own `KernelError{code:"unknown-session"}` fallback (EC-02) — that fallback is NOT itself covered by this repo's Go tests (it's TS code); it is exercised only by this kernel correctly returning `ErrUnknownSession`, which P9-03 does verify. |
| Duplicate-wake idempotency for one session id | **Unsupported (documented, not hardened)** | `handleWake` has no guard against a second wake for an already-registered session id — `TestWake_DuplicateSessionID_OverwritesRegistryEntry` (P9-03) pins the orphaning consequence. TS-side pre-wake container-name prediction is understood to prevent this from being reached in the normal request path; this kernel does not independently enforce it. A real hardening candidate for a future phase, not silently assumed safe. |
| Capability scoping (`internal/capability`) / scoped credential brokering (`internal/credentialbroker`) | **Preview / Pending** | Prototyped and unit-tested in isolation (P8-02/P8-04), NOT adopted into any live request path — ADR-014's own v1.1-candidate framing. `credentialbroker`'s expiry semantics now have direct `Validate`-path coverage too (P9-04), on top of the existing `Resolve`-path test. |
| Egress/network controls | **Stable (Linux)** | Real enforcement shipped, not evaluation-only (P8-05, ADR-013): `internal/egress` installs and independently verifies a `DOCKER-USER` iptables rule blocking `169.254.0.0/16` (cloud-metadata/link-local) on every container — called from `nanogo serve` startup by default, checkable via `nanogo doctor`. Covered by `egress_test.go`'s fakeRunner suite and `live_docker_test.go`'s real-Docker tests (`NANOCLAW_EGRESS_LIVE_DOCKER=1`, run in CI). Linux only by design: Docker Desktop for Mac's `--network host` is a proxy/forwarding emulation, not real namespace sharing, so `Ensure`/`Check` report a disclosed `LevelWarn` gap rather than a false pass on any other `GOOS` — see ADR-013's "Scope: Linux only" section. The platform qualifier is part of the rating, not a footnote. |
| `container.wake` gateway-trust mount admission (`MountClass: gateway-trust`, `Policy.GatewayTrustRoot`, ro-only + agent-role-allowed, checked ahead of identity-material) | **Stable (new, 2026-09-26)** | `internal/mount`, v2.4.0 promotion Workstream A1/A6. Table-driven admission suite including a two-container test proving gateway-trust works on a non-agent (auxiliary proxy) role. A real bug (`underRoot(path, "")` matching every absolute path, silently misclassifying every mount when `GatewayTrustRoot` was unset) was found and fixed via an explicit empty-root fail-closed guard, verified by negative control. Full `go-host` suite green including `-race`. |
| Multi-container session wake/kill with per-session private network isolation (`--internal` Docker network, `--read-only` auxiliary containers, ordered start/teardown, allocate-all-or-roll-back-everything on partial failure) | **Stable (new, 2026-09-26), verified against a real Docker daemon** | `internal/kernel`'s `Executor.Wake`/`Kill`, v2.4.0 promotion Workstream A3/A5. No upstream Go source to port from (original implementation mirroring `docker-driver.ts`'s TS logic). Live-Docker evidence, not just a fake-CLI unit suite: `TestLive_Wake_MultiContainerSession_PrivateNetworkIsolatesAgentAndReachesProxy` (private network is `Internal:true` with exactly 2 members; agent reaches the auxiliary by alias but not the outside internet) and `TestLive_Wake_MultiContainerSession_AuxiliaryIsReadOnly` (the auxiliary's real read-only rootfs confirmed from inside it), both run against a real daemon (`NANOCLAW_EC05_LIVE_DOCKER=1`), 2026-09-25. `go-multi-container-live-docker` is wired REQUIRED into `ci.yml` (Workstream G1); the actual GitHub Actions run of that job is still the formal gate this local evidence stands in for. |
| Auxiliary-container health reflected in agent `status()` (an agent reporting "running" also implying every auxiliary still is) | **Unsupported (documented gap, not silently dropped)** | No Go-kernel equivalent exists yet — A3's own row names this explicitly as the one piece of upstream's paired change not ported this pass, flagged for a later task rather than assumed covered by the Wake/Kill row above. |

## Compatibility / format surface (what the kernel reads or must stay byte-compatible with)

| Surface | Rating | Notes |
|---|---|---|
| Central DB file (`data/v2.db`) row shapes this kernel reads (`container_configs.cli_scope`, `pending_approvals`) | **Stable** | Read-only from Go's side; schema confirmed via `docs/parity-schema.md`'s process and this phase's own `guardpolicy` fixtures (real sqlite schema in `openTestDB`). |
| Central DB file, `modernc.org/sqlite` (Go, vendored v1.57.0) vs. `better-sqlite3` (TypeScript host's native driver) — the SAME on-disk file, written and read by two independent driver implementations | **Preview / Pending — new watch item, not yet verified** | v2.3.0's own release notes state *"SQLite remains the default and existing `data/v2.db` files are unchanged"* despite its `DbDriver` abstraction — reassuring for the abstraction itself, but the SAME release also requires Node 22 for "the upgraded `better-sqlite3` release," a native-driver version bump this project doesn't control the timing of. Whether `modernc.org/sqlite` v1.57.0 can read whatever file-format/pragma choices that upgraded driver makes has not been checked against a real file (`version-compatibility.md` §4). **Action**: verify on the user's Mac against a real post-upgrade `data/v2.db`; not checkable from this project's development sandbox. |
| Non-default `DbDriver` backend (v2.3.0's storage-neutral registries, if configured away from the built-in SQLite implementation) | **Unsupported** | This kernel's `internal/mailbox`/`internal/session` assume direct sqlite file access; a deployment using a non-default `DbDriver` backend has no Go-kernel equivalent and is out of scope as designed. Worth restating plainly since v2.3.0 is the first release where this is a real configuration option, not a hypothetical. |
| Mailbox record contract (`mailbox/model.ts` eight record kinds) | **Stable, read-adjacent** | Not directly parsed by any shipped Go path yet (see `docs/compatibility-contract.md` A1) — rated Stable here because the single-source-of-truth generation this project's contract doc already confirmed removes the main drift risk, not because Go code exercises it. |
| `SessionDriver.prepare(spec)` as the enforcement chokepoint | **Stable (confirmed 2026-09-03)** | ADR-017's review re-confirmed this directly against v2.3.0's own release notes; no indication the admission chokepoint moved. |
| Driver seam beyond `prepare`/`stop` (`listSessions`/`watchSessions`/`reapResidue`, attach-based supervision, `execSpec`) | **Unsupported (by design)** | ADR-016's explicit scope decision — supervision, discovery, and exec stay TypeScript-native; not modeled in Go at all. |

## How to keep this current

Do not hand-edit ratings based on general impressions of "how mature this
feels." Each row's rating changes only when: (a) a new test/fuzz target
lands that changes what's actually verified (update the Notes cite), or (b)
an `ADR-017`-style upstream review (`version-compatibility.md` §3) finds a
contract change and its own ADR says whether a row's status changes. The
`upstream-watch` CI job (P9-05) is what should prompt the next review that
touches this file — it does not edit this file itself.

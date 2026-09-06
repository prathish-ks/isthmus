# Versioned Compatibility Adapter Boundary

Status: living document, established 2026-09-03 (Phase 9, P9-08). Defines the
consumed contracts this Go kernel depends on, where the adapter boundary
between "TypeScript's chosen shape" and "this kernel's own types" sits, how a
future upstream break is meant to be caught and handled, and the version-range
strategy this project follows. Companion to `docs/compatibility-matrix.md`
(P9-09, the per-component Stable/Preview/Unsupported table) and
`ADR-017-p9-07-upstream-overlap-review.md` (the dated review this document's
claims are current as of).

## 1. What this kernel actually consumes from upstream

This project ports specific TypeScript source files/functions, not "NanoClaw"
as a whole — `docs/host-decomposition.md` and its driver addendum are the
authoritative, function-by-function inventory. The contracts this kernel's
Go code depends on holding still are narrower than that whole inventory:

| Consumed contract | Upstream source | This kernel's adapter |
|---|---|---|
| Mount/session admission shape (`SessionSpec`, `ContainerSpec`, `MountSpec`, `MountClass`, `MountPolicy`) and its validation rules | `src/drivers/types.ts`'s `validateSpec`/`mountAllowed`/`isSecretShaped`/`looksLikeCredential`/`classRequiredByPath` | `internal/mount` (`mount.Session`, `mount.ValidateSpec`, `mount.Policy`) |
| Safe container defaults (RunAs, resource caps) | `src/drivers/docker-driver.ts`'s hardening posture (non-root, `--rm`, resource flags) | `internal/containerdefaults` |
| Session/agent-group/mailbox identity shape | `src/mailbox/model.ts` record kinds, `src/mailbox/sqlite/paths.ts`-equivalent path joins | `internal/mailbox`, `internal/ownership` |
| The one physical Docker chokepoint | `DockerSessionDriver.prepare(spec)` (first line: `validateSpec(...)`), `.stop()` | `internal/kernel`'s `Executor.Wake`/`Kill`/`BuildImage` (EC-02; note ADR-016's documented narrower scope — supervision/discovery/exec stay TypeScript) |
| CLI-restart guard decision logic | `src/cli/guard.ts`'s `commandDecide`, `src/cli/registry.ts`'s `CommandDef` | `internal/guardpolicy` (`DecideRestartLike`, `CommandSpec`) |
| Self-mod guard decision logic | `src/modules/self-mod/guard.ts` | `internal/guardpolicy` (`DecideSelfMod`) |
| `cli_scope`/`pending_approvals` row shapes | `container_configs`/`pending_approvals` tables (central DB) | `internal/guardpolicy`'s `SQLCLIScopeLookup`/`SQLApprovalLookup` (thin `*sql.DB` readers) |
| Central DB file itself | `data/v2.db` (sqlite, written by the TS host via `better-sqlite3`) | `internal/session`, `internal/mailbox` (read/write the same file via `modernc.org/sqlite`, a **different** driver implementation — see §4) |

Each row's "This kernel's adapter" column is a Go package whose own doc
comment already cites the exact upstream file/line range it ports (per this
project's own established convention — see e.g. `internal/mount`'s package
doc, `internal/lifecycle`'s package doc). This table is the index into those
citations, not a replacement for them.

## 2. The adapter boundary, precisely

The boundary is NOT "the Go/TypeScript language line." It is: **this
kernel's Go types model only the subset of an upstream shape its own
validators actually read**, and every such narrowing is stated in that
package's doc comment (e.g. `mount.Session`'s own comment: "the subset of
SessionSpec this package's rules read"). Two consequences:

- **A field upstream adds that this kernel's rules never consult is not a
  compatibility break.** `mount.Session` growing a new sibling field on the
  TS side that no validator reads doesn't need a Go change — the TS→Go
  request payload (EC-02's wire contract, `internal/kernel`'s
  `CapabilityRequestPayload`) simply doesn't carry it.
- **A field upstream renames, restructures, or changes the MEANING of, that
  this kernel's rules DO consult, is a break**, whether or not it also
  changes that field's Go-side name. This is why `ADR-017`'s kind of review
  reads release notes for the specific named contracts in §1's table, not
  just "does anything in NanoClaw look different."

The wire protocol between the TypeScript host and this kernel (EC-02;
`internal/kernel/protocol.go`'s `Envelope`/`ResponseEnvelope`,
`ProtocolVersion`) is a SEPARATE version axis from upstream NanoClaw's own
version — it only needs to change when THIS project changes the TS↔Go
contract, never as a direct consequence of an upstream nanoclaw release. Do
not conflate a `ProtocolVersion` bump with a compatibility-pin promotion;
they are independent and typically won't happen in the same change.

## 3. Deprecation / drift policy

1. **Detect.** `.github/workflows/ci.yml`'s `upstream-watch` job (P9-05,
   weekly + on-demand) diffs the live nanocoai/nanoclaw latest release tag
   against `docs/upstream-pin.json`. This catches "a new release exists,"
   nothing more granular.
2. **Review.** On a mismatch, run an `ADR-017`-style review: read the new
   release's notes specifically against §1's table above. Most releases will
   touch none of these rows (v2.3.0 itself shipped a Slack UX rework,
   scheduled-task cascade-delete semantics, and an OneCLI version bump
   alongside the driver-seam/DbDriver work this table does care about) — a
   clean review is a normal, expected, and still-worth-recording outcome
   ("the following upstream changes were checked and found not to touch any
   consumed contract"), not a signal something is broken.
3. **Decide.** If a row's contract genuinely changed: record a new ADR (this
   project's standing practice — see ADR-002 through ADR-016) stating what
   changed, whether this kernel's Go code needs a corresponding change, and
   whether existing parity fixtures/tests still hold or need re-capturing
   against the new upstream behavior (`docs/parity-schema.md`'s process).
4. **Promote.** Only after that ADR exists: update `docs/baseline.md`'s
   "Stable Baseline" section and `docs/upstream-pin.json` together, in the
   same commit as the ADR. Never let the pin move without a paired ADR —
   this is the same "deliberate, reviewed promotion, not something that
   should silently track upstream churn" discipline `docs/upstream-pin.json`
   itself documents (LAW-09).

There is deliberately no automatic "adapter versioning" scheme (no
`v1`/`v2` suffix on Go package names, no runtime negotiation of which
upstream shape a request matches) — this project has exactly one pinned
upstream baseline at a time, per LAW-09's "decoupled from active upstream
churn" posture, so there is nothing to negotiate between. If this project
ever needs to support two upstream baselines concurrently (e.g. mid-
migration for downstream users), that would be a deliberate, larger design
change warranting its own ADR before being retrofitted onto this doc.

## 4. Version-range strategy

- **Upstream NanoClaw**: pinned to exactly one tagged release at a time
  (`docs/baseline.md`, `docs/upstream-pin.json`), currently `v2.3.0`. No
  attempt to support a range of upstream versions simultaneously — see §3.
- **Go toolchain**: `go-host/go.mod` requires `go 1.25.0`. Bumping this is a
  normal dependency-maintenance change, unrelated to upstream NanoClaw's own
  version.
- **`modernc.org/sqlite` (this kernel's sqlite driver) vs. `better-sqlite3`
  (upstream TS host's sqlite driver)**: these are two INDEPENDENT
  implementations reading/writing the same on-disk file format, not two
  versions of the same library — there is no shared version number to pin
  against. Compatibility here rests on both drivers speaking a SQLite file
  format/feature subset the other can read, which is exactly what
  `ADR-017` flags as newly relevant: v2.3.0 requires Node 22 for "the
  upgraded `better-sqlite3` release," a driver upgrade this kernel had no
  part in and cannot control the timing of. **Action item, not yet done**:
  verify `modernc.org/sqlite` v1.57.0 (vendored) can read a `data/v2.db`
  actually written by the Node-22-era `better-sqlite3` on the user's real
  Mac — this needs the real file, not something this project's development
  sandbox can produce or check. Tracked in `docs/compatibility-matrix.md`'s
  SQLite row as Preview/Pending until that check runs.
- **Node.js / pnpm / Bun** (the TS/Bun side's own toolchain versions): out
  of this document's scope entirely — `docs/baseline.md`'s "Toolchain"
  sections already track these for the TypeScript side, independent of
  anything Go-side.

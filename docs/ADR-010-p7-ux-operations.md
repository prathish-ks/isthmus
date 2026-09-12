# ADR-010: Phase 7 — UX & Operations (status, doctor, trace, security-check, error taxonomy)

Status: accepted, 2026-09-02, covering P7-01 through P7-05. Prerequisite: P6-05 (satisfied). This ADR documents five small, independent additions rather than one architectural decision. Phase 7's own master-plan entry is "Added Value," not a design-law-level choice, so this record is closer to a design note than ADR-001/ADR-008's weight.

## Context

Phase 6 closed with `internal/kernel` built, tested, and documented, but with two carried-forward gaps ADR-009 named explicitly: `container-runner.ts` not yet rewired to call it, and no long-lived kernel process (`cmd/nanogo -serve`) yet exists. Phase 7's five tasks all had to be designed against that reality rather than against an imagined future where a daemon is already running — every command below is a point-in-time inspection tool, not a client of a live kernel, except where one happens to be reachable and worth probing opportunistically.

## P7-01 — `internal/status` / `nanogo status`

Reports host version, config validity, session counts by lifecycle/container status (from the central DB, `internal/session`), and kernel-socket reachability (a short-timeout Unix dial, nothing more — it never speaks the protocol). No secrets in the output: only directory paths and counts, matching the task's own "without exposing secrets" requirement.

## P7-02 — `internal/doctor` / `nanogo doctor`

Five independent named checks — container runtime, agent image, central DB/mailboxes, credential-provider (OneCLI) connectivity, kernel boundary — each returning a `Result{Name, Level, Detail, Remediation}`. `Level` is `pass|warn|fail`; a check with nothing configured to check reports `pass` with a skip explanation rather than being silently absent, so `nanogo doctor`'s output always accounts for every check it claims to run. Runtime-dependent checks (docker, onecli) go through a `CommandRunner` interface so tests fake the OS instead of requiring a real Docker/OneCLI install in CI. Per the task's own instruction, doctor never auto-fixes anything — every non-pass `Result` carries a `Remediation` string, the manual next step.

## P7-03 — `internal/trace` / `nanogo trace <id>`

The one task genuinely constrained by the "no daemon yet" reality above. A message trace conventionally means querying a live process's accumulated history; with none running, this task's real design decision was where that history lives at all.

**Decision: `internal/kernel.Dispatch` records trace events live**, on every `route.request`/`session.lookup`/`capability.request`/`delivery.request` call, into a `*trace.Store` attached via the new `WithTracer` option (nil by default — every kernel built before P7-03, and every existing `kernel_test.go` case, is unaffected). Keys are whatever id each op naturally carries: `route.request`'s `MessageID`, `session.lookup`'s looked-up/resolved session id, `capability.request`'s session or agent-group id, `delivery.request`'s `PlatformID`. Summaries never include message content, only structural facts (engage/deliver/wake booleans, allowed/denied, a reason string). This matches "redact message content/secrets by default."

**Decision: the Store is optionally file-backed** (`trace.NewFileBackedStore(path, capacity)`), mirroring every `Record` to an append-only JSON-lines file in addition to the in-memory ring buffer. This is what makes `nanogo trace <id>` usable at all as a *separate, short-lived CLI process* with no access to a live kernel's memory: it reads the same file via `trace.ReadFile`, filtered by key. A missing file or unknown key returns an empty result, never an error — "nothing traced yet" is the normal state for a fresh install.

**What this does NOT do**: the master plan's own illustrative stage list — "intake, route, session, container wake, outbound, delivery" — includes two stages (`intake`, `outbound`) that are TypeScript-owned pipeline points this Go module doesn't run yet. `trace.StageIntake`/`StageOutbound` are defined for forward compatibility but nothing in this codebase emits them today. This is the identical "component exists, full pipeline wiring is later" honesty ADR-009 already applied to `container-runner.ts`'s rewiring, restated here for trace specifically.

## P7-04 — `internal/securitycheck` / `nanogo security-check`

Five read-only invariant checks — user/privilege, dangerous mounts (scans a supplied `mount-allowlist.json` for suspiciously broad roots or Docker/Podman-socket coverage), Docker-socket exposure (checks supplied sample mounts directly), credential-exposure indicators (`mount.IsSecretShaped`/`LooksLikeCredential` against a supplied env snapshot — this package never reads `os.Environ()` itself), and runtime restrictions (`containerdefaults.EnforceSafeDefaults`). Reuses `internal/doctor`'s `Level`/`Result` types via a Go type alias rather than duplicating an identical four-field struct (LAW-05). Every check with nothing supplied to inspect reports `pass` with a skip explanation, the same discipline as doctor. This command changes nothing it inspects, full stop — there is no code path in this package that writes anything.

## P7-05 — `internal/hosterrors`

A small, closed `Category` enum (config/database/runtime/credential/adapter/security/unknown) plus a `HostError{Category, Message, Guidance, Cause}` type. `Categorize(err)` maps common low-level errors (`sql.ErrNoRows`, `os.ErrNotExist`/`ErrPermission`, `exec.ErrNotFound`, `*mount.ValidationError`, `*net.OpError` from a failed kernel-socket dial) into a category with actionable guidance, always preserving the original error via `Unwrap` so `errors.Is`/`errors.As` keep working. Built first among the five P7 tasks (despite its number) because doctor and status both consume it directly for their own error rendering.

## Testing

Each of the five packages above ships with its own table-driven unit tests (73 new test cases across `hosterrors`, `status`, `doctor`, `trace`, `securitycheck`, plus 7 new cases added directly to `internal/kernel/kernel_test.go` proving the trace wiring records the right key/stage for each op and never breaks any of the 24 pre-existing kernel tests). Full module regression (`go build`, `go vet`, `gofmt -l .` — clean except pre-existing vendored third-party files, never this project's own code — `go test -race ./...`) is green.

## cmd/nanogo wiring

`main()` dispatches on `os.Args[1]` before any flag parsing: `status`/`doctor`/`trace`/`security-check` route to their own `flag.NewFlagSet`-based handlers. Anything else (including every existing P3-era invocation, which always starts with `-config`, never a bare word) falls through unchanged to `runLegacyCLI` — the original P3-01 through P3-06 body, moved into its own function but otherwise untouched. This is fully backward-compatible with every existing script (`scripts/p3-*.sh`) by construction, verified by re-running the legacy `-config`/`-write-chat`/`-read-outbound` flow after the restructuring.

## Not done in this ADR (explicitly deferred, matching ADR-009's own pattern)

`cmd/nanogo -serve` (running `Kernel.Serve` as a long-lived process) is still not implemented — it remains the single item that would upgrade `status`/`doctor`'s kernel-socket checks from "opportunistic probe" to "the expected common case," and would let `nanogo trace` query a live process instead of only a durable file. Tracked as the same Phase 7+/release-engineering item ADR-009 already named, not invented here.

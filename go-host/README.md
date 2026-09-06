# nanoclaw-go-host

A small, independently-enforced Go security kernel for
[NanoClaw](https://github.com/nanocoai/nanoclaw) — an experimental,
unofficial companion project, not an official NanoClaw artifact.

## Thesis

NanoClaw's own founder frames its security model around extreme
simplicity: small enough to be "auditable in about eight minutes." This
project takes that seriously and asks what a still-smaller, physically
separate trust boundary would look like underneath NanoClaw's existing
TypeScript/Bun host and agent-runner — without requiring Go for any
ordinary customization (skills, channels, templates all stay exactly as
they are today). Everything above the boundary — routing, sessions,
delivery, the CLI, the whole extensibility surface — stays TypeScript.
Everything the boundary itself needs to physically enforce (mount
validation, container-argv hardening, capability-gated
wake/kill/build_image) moves into a small, separately-tested Go binary
(`nanogo`) that the TypeScript host talks to over a local Unix socket, and
that a compromised or buggy caller in the TypeScript process cannot bypass
by construction rather than by convention.

See [`docs/design-laws.md`](../docs/design-laws.md) for the nine design
laws this project holds itself to (in short: flexible above, rigid below;
no Go for ordinary customization; no weaker security than upstream; every
security control needs low-friction UX), and
[`docs/host-decomposition.md`](../docs/host-decomposition.md) for the full
inventory of what stays TypeScript versus what this repo ports.

## Status

**Not production. Not an official NanoClaw project.** Currently mid Phase
9/10 of the project's own roadmap (Enforcement Closure, now Hardening &
Quality Gates — see this repo's `docs/ADR-*.md` series for the individual
decisions that phase is made of). As of this writing:

- **The kernel is live in the request path.** `container.wake`,
  `container.kill`, and `container.build_image` — the three privileged
  Docker-facing operations the TypeScript host used to perform directly —
  now go exclusively through `internal/kernel`'s capability-gated NDJSON
  protocol (`cmd/nanogo serve`), reached by the TypeScript host's own
  `src/kernel/client.ts`. This is a physical boundary, not a decision
  mirror: the validators (`internal/mount`, `internal/containerdefaults`,
  `internal/guardpolicy`) run inside the Go process regardless of what the
  TypeScript caller asserts.
- **Discovery, supervision, and `exec` stay TypeScript-only, by deliberate
  design** (`docs/ADR-016-p9-ec02-narrow-enforcement-boundary.md`) — none
  of those paths make an admission decision, so narrowing the enforcement
  boundary to create/stop+rm/build closes the actual bypass gap without a
  full driver-parity rewrite.
- **Capability scoping and credential brokering
  (`internal/capability`, `internal/credentialbroker`) are prototyped and
  tested in isolation, not yet adopted** into any live request path — a
  named v1.1 candidate, not a v1 claim (`docs/ADR-014-p9-ec01-phase8-disposition.md`).
- **Guard-catalog coverage is real for a narrow, Go-enforced subset**
  (the CLI-derived `restart` guard and the self-mod `install_packages`/
  `add_mcp_server` gate, independently re-verified by the kernel itself
  from its own database read — `internal/guardpolicy`,
  `docs/ADR-015-p9-ec04-kernel-side-guard-verification.md`) and
  intentionally TypeScript-only for the rest of the guard catalog — by
  design, not because porting the rest was deferred.
- **No independent red-team pass has been run against the live boundary
  yet** — that is the project's own next step (EC-05), not yet started as
  of this README.

## Building and testing

From this directory (`go-host/`):

```sh
gofmt -l . | grep -v "^vendor/"  # formatting (vendored code is excluded; it is not this project's own)
go vet -mod=vendor ./...   # static analysis
go build -mod=vendor ./...
go test -mod=vendor ./... -v
go test -mod=vendor -race ./...
golangci-lint run          # aggregated lint — see .golangci.yml
```

Dependencies are vendored (`vendor/`), so none of the above needs network
access. CI (`.github/workflows/ci.yml`, job `go-host`) runs the first five
of these on every pull request as a required check; `golangci-lint`,
`govulncheck`, and a Semgrep scan run as separate, report-only jobs (see
that workflow's own comments for why they don't yet block a merge).

To run one of the Phase 9 fuzz targets (`internal/mount`,
`internal/ownership`, `internal/containerdefaults`, `internal/guardpolicy`,
`internal/kernel`) with real coverage-guided mutation rather than just its
seed corpus:

```sh
go test -mod=vendor ./internal/mount/ -fuzz=FuzzValidateSpec -fuzztime=60s
```

## Layout

- `cmd/nanogo/` — the CLI entrypoint and `serve` subcommand (the long-lived
  process `internal/kernel.Serve` runs inside).
- `internal/kernel/` — the NDJSON wire protocol, capability dispatch, and
  the one physical Docker-exec path (`exec.go`).
- `internal/mount/`, `internal/containerdefaults/`, `internal/ownership/`,
  `internal/guardpolicy/` — the validators the kernel consults before
  granting a capability; each ports a specific TypeScript source file,
  cited in its own package doc comment.
- `internal/mailbox/`, `internal/session/`, `internal/routing/`,
  `internal/delivery/`, `internal/lifecycle/`, `internal/restart/` —
  read-mostly Go ports of the host's own message/session/delivery
  contracts, used by `internal/parity` to prove behavioral parity against
  captured TypeScript fixtures (see `docs/parity-schema.md`).
- `internal/capability/`, `internal/credentialbroker/` — prototype-only,
  not wired into any live path (see Status above).
- `internal/doctor/`, `internal/status/`, `internal/trace/`,
  `internal/securitycheck/`, `internal/hosterrors/` — operator-facing
  diagnostics.

## Further reading

- [`../docs/design-laws.md`](../docs/design-laws.md) — the nine design laws.
- [`../docs/host-decomposition.md`](../docs/host-decomposition.md) — what
  stays TypeScript vs. what this repo ports, function by function.
- [`../docs/threat-model.md`](../docs/threat-model.md) and
  [`../docs/threat-model-addendum-p5.md`](../docs/threat-model-addendum-p5.md)
  — the threat model this kernel is built against.
- [`../docs/SECURITY.md`](../docs/SECURITY.md) — the security model this
  project extends.
- `../docs/ADR-*.md` — every architectural decision, in order, each
  stating what it does and does not prove.
- [`docs/compatibility-matrix.md`](docs/compatibility-matrix.md) — which
  NanoClaw↔Go-kernel contracts are Stable, Preview/Pending, or Unsupported,
  as of the currently pinned upstream baseline.
- [`docs/version-compatibility.md`](docs/version-compatibility.md) — the
  consumed-contract table, the adapter boundary, and the drift-detection/
  pin-promotion process the matrix above is a snapshot of.
- [`../docs/baseline.md`](../docs/baseline.md) and
  [`../docs/upstream-pin.json`](../docs/upstream-pin.json) — the pinned
  upstream revision itself (`v2.3.0` as of this writing) and the
  machine-readable form CI's `upstream-watch` job diffs against.

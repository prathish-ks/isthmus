<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/isthmus/isthmus-wordmark-inverted.svg">
    <img src="assets/isthmus/isthmus-wordmark.svg" alt="Isthmus" width="360">
  </picture>
</p>

<p align="center"><em>A hardened NanoClaw distribution: an independently-enforced Go trust-kernel, egress lockdown, and CI that runs against live infrastructure — the same NanoClaw v2.4.0 experience, secured underneath.</em></p>

<p align="center">
  <a href="https://github.com/prathish-ks/isthmus/actions/workflows/ci.yml"><img src="https://github.com/prathish-ks/isthmus/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

> **Independent, unofficial companion project.** Isthmus is not affiliated with, endorsed by, or an official artifact of NanoClaw or its maintainers ([nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw), [nanoclaw.dev](https://nanoclaw.dev)). It is a derivative work, built and published under its own name per NanoClaw's own MIT license, which preserves NanoClaw's entire ecosystem (channels, skills, customization model) untouched and re-implements a small set of security- and liveness-critical host decisions in Go. See [License](#license) for attribution.

**Status:** The Go trust-kernel (guard decisions, mount security, egress verification, and a handful of liveness/lifecycle decisions) is implemented, fuzzed, and race-detector-clean — behaviorally pinned against NanoClaw `v2.4.0`. It sits behind the TypeScript host, between it and every privileged operation: every Docker/filesystem/network call is mediated through it, so a compromised or buggy TypeScript caller can't bypass the checks by construction. See [What Isthmus adds](#what-isthmus-adds) below for what that buys on top of NanoClaw `v2.4.0` itself. A full solo dry run (install stock NanoClaw → pair a real Telegram bot → upgrade to Isthmus in place → round trip → roll back to stock → round trip again, same data directory throughout, zero data loss) is done and documented in [`docs/rollback-runbook.md`](docs/rollback-runbook.md) — that's one operator, one machine, one channel so far. Looking for outside testers across more channels and machines next; see [Current status](#current-status-and-whats-not-changed) below for exactly what's verified and what isn't yet.

## Why

NanoClaw demonstrated that a useful AI-agent host can be made simpler and safer through strong isolation. Isthmus takes the next architectural step. It preserves NanoClaw's TypeScript ecosystem and philosophy untouched, but identifies the small number of host-side contracts whose compromise would materially affect security or liveness — guard decisions, mount security, egress verification, a handful of liveness checks. It specifies those contracts first, then moves only those deterministic, privileged invariants into a small Go trust-kernel. Go was chosen after decomposition and comparative language reasoning, not before: a compact deployable runtime, straightforward concurrency, strong service boundaries, and operational simplicity, for exactly this narrow slice. The goal is a smaller, more auditable trusted computing base with zero loss of NanoClaw's ordinary customization and minimal upstream-fork friction.

Full background — the product reasoning that led here, the language-comparison criteria, and the design laws that kept the scope honest — is in [`docs/thesis.md`](docs/thesis.md).

## What Isthmus adds

Isthmus starts from NanoClaw `v2.4.0` and adds a security and quality layer underneath it. Day to day, using it looks identical to using NanoClaw — see [Current status](#current-status-and-whats-not-changed) for exactly what's unchanged.

- **A Go trust-kernel with no upstream equivalent.** Guard decisions, mount security, egress verification, and a handful of liveness/lifecycle decisions run inside a separately-tested Go binary (`nanogo`) that the TypeScript host reaches over a local Unix socket, instead of trusting the TypeScript process to enforce them itself. See [Architecture](#architecture).
- **Egress lockdown — a feature upstream doesn't have.** Isthmus blocks outbound traffic from agent containers to the cloud-metadata and link-local address ranges, closing off a well-known credential-theft path (the same SSRF pattern behind real incidents in the space). Getting it enforced correctly took several passes: a wiring gap that silently dropped the arguments enforcing it was found and closed ([ADR-024](go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md)), the kernel now refuses to start if it can't actually enforce the block ([ADR-025](go-host/docs/ADR-025-kernel-side-egress-lockdown-enforcement.md)), a required CI job re-proves the enforcement against a live Docker daemon on every pull request ([ADR-026](go-host/docs/ADR-026-egress-lockdown-live-ci-gate.md)), and a general wiring-and-boundary registry ([ADR-028](go-host/docs/ADR-028-wiring-boundary-registry.md)) now checks the rest of the codebase for the same class of gap. It's Linux-only today — see [ADR-013](docs/ADR-013-p8-05-egress-network-controls.md) for the macOS limitation, disclosed rather than silently no-op'd.
- **A turn-routing fix built independently of upstream, not ported from it.** Upstream's own v2.4.0 fixes the same underlying bug — a reply landing on the wrong queued turn — by adding a turn queue (`queuedTurns`/`adoptTurn`/`pushRetry`) bundled with an unrelated provider-contract migration. Isthmus solves it with a narrower mechanism instead: a `pendingTurns` queue plus an `answering` flag in `container/agent-runner/src/poll-loop.ts`, without adopting upstream's data structures or timing changes.
- **A much larger test suite than upstream ships.** A differential-fixture harness characterizes real TypeScript guard/routing/delivery behavior byte-for-byte (60+ contracts across the guard catalog alone) so every Go decision function is checked against NanoClaw's actual behavior rather than a guessed spec. That harness turned up two real bugs, both fixed here: a mount-validation bypass in `validateSpec`'s handling of `allowlisted-extra` mounts (the same failure class as OpenClaw's `CVE-2026-27002`, a Docker-socket exposure) and a macOS-specific symlink path-mismatch bug in the update-transaction machinery.
- **A CI pipeline sized for a trust boundary, not a typical app.** 18 distinct jobs, several required. Five run the kernel against a real Docker daemon (`go-multi-container-live-docker`, `live-egress-lockdown`, `live-host-docker`, `go-egress-live-docker`, `go-ec05-live-docker`), so enforcement is proven against actual infrastructure, not mocked. `pnpm-audit` and `bun-audit` scan the two JS runtimes independently, each against an accepted-baseline gate so a new advisory blocks the build until triaged; `go-vulncheck` and `semgrep` cover the Go side and static analysis; `coverage-gate` and `performance-gate` hold floors on test coverage and runtime performance; `go-fuzz-smoke` runs coverage-guided fuzz targets against the mount/ownership/guard/kernel validators. Dependabot watches all four ecosystems in play (pnpm, agent-runner's separate Bun tree, the Go kernel, and pinned GitHub Actions) on a weekly cycle, with every proposed bump still subject to the same audit gates.
- **Operator tooling that doesn't exist upstream**: `nanogo status` (host/session/kernel-socket health), `doctor` (seven independent pass/warn/fail checks — container runtime, hardened runtime class such as gVisor/Kata/Sysbox ([ADR-021](go-host/docs/ADR-021-hardened-runtime-class-check.md)), agent image, DB/mailboxes, credential provider, kernel boundary, egress lockdown — each with concrete remediation), `trace <id>` (content-free request tracing across routing/session/capability/delivery decisions), and `security-check` (read-only checks for privilege, dangerous mounts, Docker-socket exposure, credential-exposure indicators). 60+ test cases cover these alone.
- **Prototype-stage security work beyond the live boundary**: a scoped/expiring credential-token flow (`internal/credentialbroker`) whose `Token` type has no field that can hold a secret — an agent's environment builds from a token's opaque ID, the underlying secret never present in it — and a time-boxed filesystem capability grant (`internal/capability`) with real, active expiry. Neither is wired into a live request path yet.
- **Concurrency correctness proven under the race detector**, for the lifecycle and session-registry packages, including exactly-once-spawn and cancellation-under-race scenarios.
- **Open gaps tracked, not hidden.** For example, neither the TypeScript host's mailbox path handling nor the Go port validates a session/agent-group ID against path traversal before joining it into a filesystem path — unexploited today (those IDs are host-generated), and listed in [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md).

## Who this is for

This is a genuine, if narrow, security improvement — not a blanket "everyone should use this." The honest case for it scales with what an installation is actually exposed to:

**Higher-need profile** — you're a stronger candidate for a hardened host if your NanoClaw installation has any of the following. Real credentials or production/financial-system access reachable from an agent's container or mounts: mount security and the credential-broker design exist because a hallucinating or prompt-injected tool call reaching a mounted secret is a real failure mode — see the OpenClaw CVE and the 2026 Mastra npm supply-chain compromise cited in the threat model. Skills or MCP tools with outbound network access combined with sensitive local data, since the egress-lockdown work specifically targets cloud-metadata/link-local SSRF, a well-known credential-theft pattern. More than one agent or messaging identity sharing a host, where a single compromised agent's blast radius matters. Or a 24/7 personal-assistant bot that ingests untrusted inbound content (DMs, emails, scraped pages) where prompt injection is a live concern rather than a lab scenario.

**Lower-need profile** — if you're running NanoClaw for low-stakes personal use (a reminders bot, a weather query agent), with no credentials or production access reachable from the agent, and inbound messages only from people you already trust, NanoClaw's existing container isolation is probably already sufficient for your actual risk. Isthmus's value there is smaller: mostly a more auditable codebase, not a materially different outcome.

The honest summary: the risk this addresses is real and has a documented real-world precedent (CVE-2026-27002-class mount bypasses, real supply-chain compromises), but it scales with what's actually reachable from your agents — not with running an agent host per se.

## Architecture

```
TypeScript NanoClaw layer
  Channels • orchestration • hooks • workflows • permissions UX • domain/customization
              │
Explicit compatibility boundary
  Mailbox / DB / session / routing / guard contracts • versioned wire models • regression fixtures
              │
Go trust-kernel  (Isthmus)
  guard() • mount-security • egress verification • selected liveness decisions
              │
Privileged host capabilities
  Container runtime • filesystem/mount operations • network controls • credential-sensitive actions
              │
Agent/container side
  NanoClaw agent runtime and existing container philosophy, unchanged
```

The kernel sits behind the TypeScript host, between it and every privileged operation. Everything above the compatibility boundary — channels, skills, templates, customization, the entire NanoClaw ecosystem you'd install skills for — is untouched and continues to track NanoClaw upstream normally. Everything below it, down to the point where a Docker/filesystem/network call actually happens, is where the kernel mediates and where this project's own hardening work concentrates — see [What Isthmus adds](#what-isthmus-adds) above for specifics.

## Current status and what's *not* changed

- NanoClaw's channels, skills, templates, customization model, and agent-container runtime are unmodified. Installing and using Isthmus looks the same as using NanoClaw day to day.
- The Go kernel is pinned against and tested for behavioral parity with NanoClaw `v2.4.0`; an upstream-watch job flags new upstream releases for re-validation rather than tracking upstream continuously.
- Open for outside install-and-report testing; see [`docs/baseline.md`](docs/baseline.md) and the phase-closure docs under `docs/` for exact scope and what's been verified where (sandbox vs. real hardware). One real end-to-end lifecycle dry run (install → upgrade → rollback, real Telegram channel, real Mac) is done — see [`docs/rollback-runbook.md`](docs/rollback-runbook.md). The outside-tester pass itself (multiple people, multiple channels and machines) hasn't started yet — that's the next concrete thing this needs.
- Known open gaps are named, not implied away — see [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md) for the current list.
- **Supported hosts: macOS and Linux.** Native Windows is not supported and isn't expected to work — the mount-security layer requires POSIX host paths by design (a faithful port of NanoClaw's own upstream behavior, which has never targeted native Windows hosts either). Windows users should run under WSL2, a real POSIX environment, the same way plain NanoClaw would require.

## Trying it out

- **[`isthmus-scan`](https://github.com/prathish-ks/isthmus-scan)** — a free, read-only CLI (`npx isthmus-scan`) that checks a NanoClaw install's mount-allowlist config, container non-root posture, and egress exposure in under a second, no install required. Works against plain NanoClaw too — run it *before* installing Isthmus to see your current exposure, and again after to confirm the kernel is actually enforcing (it detects Isthmus's kernel liveness specifically and reports whether each check is kernel-enforced or just this install's own configuration).
- [`docs/quickstart.md`](docs/quickstart.md) — install `nanogo` and start the host.
- [`docs/tester-walkthrough.md`](docs/tester-walkthrough.md) — a ~20-40 minute walkthrough if you want to actually put it through its paces and report back.
- [`docs/rollback-runbook.md`](docs/rollback-runbook.md) — read before you install, not after something breaks.

If something doesn't work, `nanogo doctor`'s output is written to be handed to Claude Code (or any Claude session) for a first diagnosis before filing a bug — see the "If something doesn't work" section of the walkthrough.

## Relationship to NanoClaw

Isthmus is a derivative of [NanoClaw](https://github.com/nanocoai/nanoclaw), used and modified under its MIT license. It is not a fork of NanoClaw's *product* in the sense of competing feature scope — it exists to hollow out and re-implement a small, specific slice of NanoClaw's own host in a smaller, independently reviewable language runtime, while leaving everything else exactly as NanoClaw's own maintainers designed it. If you want the full-featured, actively-maintained, community-supported project this is built on top of, that's NanoClaw itself, at the links above.

## Documentation

- [`docs/thesis.md`](docs/thesis.md) — the full product-and-architecture reasoning behind this project
- [`docs/host-decomposition.md`](docs/host-decomposition.md) — which host modules are Go-kernel candidates vs. permanently TypeScript-owned, and why
- [`docs/threat-model.md`](docs/threat-model.md) and [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md) — the security reasoning and named open gaps
- [`docs/baseline.md`](docs/baseline.md) — the pinned NanoClaw baseline and upstream-watch status
- `docs/ADR-*.md` — individual architecture decision records (credential flow, egress controls, and others)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — NanoClaw's own skills-based contribution model applies unchanged to the TypeScript ecosystem; the Go trust-kernel (`go-host/`) has its own, stricter bar (contracts and compatibility tests before any port), covered in that file.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

MIT — see [LICENSE](LICENSE). The original NanoClaw codebase is Copyright (c) 2026 Gavriel Cohen; this project's own additions (the Go trust-kernel and related tooling) are separately copyrighted per the LICENSE file. Branding (name, logo) is not covered by the MIT grant and is not shared with NanoClaw's own branding — see the disclaimer at the top of this file.

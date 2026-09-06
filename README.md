<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/isthmus/isthmus-wordmark-inverted.svg">
    <img src="assets/isthmus/isthmus-wordmark.svg" alt="Isthmus" width="360">
  </picture>
</p>

<p align="center"><em>A small, independently auditable Go trust-kernel for a NanoClaw-based personal agent host.</em></p>

<p align="center">
  <a href="https://github.com/prathish-ks/isthmus/actions/workflows/ci.yml"><img src="https://github.com/prathish-ks/isthmus/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

> **Independent, unofficial companion project.** Isthmus is not affiliated with, endorsed by, or an official artifact of NanoClaw or its maintainers ([nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw), [nanoclaw.dev](https://nanoclaw.dev)). It is a derivative work, built and published under its own name per NanoClaw's own MIT license, which preserves NanoClaw's entire ecosystem (channels, skills, customization model) untouched and re-implements a small set of security- and liveness-critical host decisions in Go. See [License](#license) for attribution.

**Status:** pre-beta / experiment. The Go trust-kernel (guard decisions, mount security, egress verification, and a handful of liveness/lifecycle decisions) is implemented and tested — behaviorally pinned against NanoClaw `v2.3.0` — alongside NanoClaw's untouched TypeScript ecosystem. A full solo dry run (install stock NanoClaw → pair a real Telegram bot → upgrade to Isthmus in place → round trip → roll back to stock → round trip again, same data directory throughout, zero data loss) is done and documented in [`docs/rollback-runbook.md`](docs/rollback-runbook.md) — but that's one operator, one machine, one channel. Still early, and still seeking outside testers across more channels and machines before any broader claim; see [Current status](#current-status-and-whats-not-changed) below for exactly what that does and doesn't mean.

## Why

NanoClaw demonstrated that a useful AI-agent host can be made simpler and safer through strong isolation. Isthmus takes the next architectural step: it preserves NanoClaw's TypeScript ecosystem and philosophy untouched, but identifies the small number of host-side contracts whose compromise would materially affect security or liveness — guard decisions, mount security, egress verification, a handful of liveness checks — specifies those contracts first, and moves only those deterministic, privileged invariants into a small Go trust-kernel. Go was chosen after decomposition and comparative language reasoning, not before: a compact deployable runtime, straightforward concurrency, strong service boundaries, and operational simplicity, for exactly this narrow slice. The goal isn't "more Go" — it's a smaller, more auditable trusted computing base with zero loss of NanoClaw's ordinary customization and minimal upstream-fork friction.

Full background — the product reasoning that led here, the language-comparison criteria, and the design laws that kept the scope honest — is in [`docs/thesis.md`](docs/thesis.md).

## What Isthmus adds

Beyond a smaller trusted surface, building this produced concrete, verifiable side effects:

- **A regression/compatibility harness NanoClaw's own TypeScript codebase didn't have.** A differential-fixture suite characterizes real TypeScript guard/routing/delivery behavior byte-for-byte (60+ contracts across the guard catalog alone) *before* anything is ported, so every Go decision function is checked against NanoClaw's actual behavior, not a guessed spec.
- **Real bugs found and fixed as a byproduct of building that harness** — not hypothetical hardening: a mount-validation bypass in `validateSpec`'s handling of `allowlisted-extra` mounts (the same failure class as OpenClaw's real `CVE-2026-27002`, a Docker-socket exposure), found and fixed in this repo; and a macOS-specific symlink path-mismatch bug in the update-transaction machinery, also root-caused and fixed here.
- **Operator tooling NanoClaw doesn't have at all**: `nanogo status` (host/session/kernel-socket health), `doctor` (five independent pass/warn/fail checks — container runtime, agent image, DB/mailboxes, credential provider, kernel boundary — each with concrete remediation, never auto-fixing anything), `trace <id>` (structural, content-free request tracing across routing/session/capability/delivery decisions), and `security-check` (read-only invariant checks: privilege, dangerous mounts, Docker-socket exposure, credential-exposure indicators, runtime restrictions). Real, tested code (60+ test cases across these alone), not a design doc.
- **Security reasoning NanoClaw hadn't done, backed by working prototype code, not just documents**: a scoped/expiring credential-token flow (`internal/credentialbroker`) whose `Token` type has no field capable of holding a secret at all — structurally, not by convention — so an agent's environment can be built from a token's opaque ID without the underlying secret ever being present; a time-boxed filesystem capability grant (`internal/capability`) with real expiry enforcement, not just an expiry field; and explicit implement/defer/reject decisions on egress controls (outbound domain allowlisting deferred, a TLS-inspecting proxy deferred, cloud-metadata/link-local blocking implemented — a narrow, low-cost fix for a well-known severe threat class). Both prototypes are deliberately not yet wired into any live request path — that's stated plainly, not implied away.
- **Concurrency correctness proven, not assumed**, for the liveness/session code: the lifecycle and session registry packages pass under Go's race detector, including exactly-once-spawn and cancellation-under-race scenarios.
- **Gaps disclosed, not hidden.** Where the port surfaced a real open issue rather than closing one, it's tracked openly rather than left implicit: for example, neither the current TypeScript host's mailbox path handling nor the current Go port validates a session/agent-group ID against path traversal before joining it into a filesystem path — currently unexploited (those IDs are always host-generated today) but named as a real, assumed-not-checked gap in [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md), not swept under a "secure by design" claim.

## Who this is for

This is a genuine, if narrow, security improvement — not a blanket "everyone should use this." The honest case for it scales with what an installation is actually exposed to:

**Higher-need profile** — you're a stronger candidate for a hardened host if your NanoClaw installation has any of: real credentials or production/financial-system access reachable from an agent's container or mounts (mount security and the credential-broker design exist because a hallucinating or prompt-injected tool call reaching a mounted secret is a real, not hypothetical, failure mode — see the OpenClaw CVE and the 2026 Mastra npm supply-chain compromise cited in the threat model); skills or MCP tools with outbound network access combined with sensitive local data (the egress-lockdown work specifically targets cloud-metadata/link-local SSRF, a well-known credential-theft pattern); more than one agent or messaging identity sharing a host, where a single compromised agent's blast radius matters; or a 24/7 personal-assistant bot that ingests untrusted inbound content (DMs, emails, scraped pages) where prompt injection is a live concern, not a lab scenario.

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

Everything above the compatibility boundary — channels, skills, templates, customization, the entire NanoClaw ecosystem you'd install skills for — is untouched and continues to track NanoClaw upstream normally.

## Current status and what's *not* changed

- NanoClaw's channels, skills, templates, customization model, and agent-container runtime are unmodified. Installing and using Isthmus looks the same as using NanoClaw day to day.
- The Go kernel is pinned against and tested for behavioral parity with NanoClaw `v2.3.0`; an upstream-watch job flags new upstream releases for re-validation rather than tracking upstream continuously.
- This is a pre-beta / experiment, not a finished release. It's open for outside install-and-report testing before any broader claim is made; see [`docs/baseline.md`](docs/baseline.md) and the phase-closure docs under `docs/` for exact scope and what's been verified where (sandbox vs. real hardware). One real end-to-end lifecycle dry run (install → upgrade → rollback, real Telegram channel, real Mac) is done — see [`docs/rollback-runbook.md`](docs/rollback-runbook.md) — but the outside-tester pass itself (multiple people, multiple channels and machines) hasn't started yet; that's what actually moves this from pre-beta to beta.
- Known open gaps are named, not implied away — see [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md) for the current list.
- **Supported hosts: macOS and Linux.** Native Windows is not supported and isn't expected to work — the mount-security layer requires POSIX host paths by design (a faithful port of NanoClaw's own upstream behavior, which has never targeted native Windows hosts either). Windows users should run under WSL2, a real POSIX environment, the same way plain NanoClaw would require.

## Trying it out

- [`docs/quickstart.md`](docs/quickstart.md) — install `nanogo` and start the host.
- [`docs/beta-test-script.md`](docs/beta-test-script.md) — a ~20-40 minute walkthrough if you want to actually put it through its paces and report back.
- [`docs/rollback-runbook.md`](docs/rollback-runbook.md) — read before you install, not after something breaks.

If something doesn't work, `nanogo doctor`'s output is written to be handed to Claude Code (or any Claude session) for a first diagnosis before filing a bug — see the "If something doesn't work" section of the test script.

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

# Security Policy

Isthmus exists specifically to reduce the trusted computing base of a NanoClaw-based agent host, so vulnerability reports are taken seriously and reviewed promptly. NanoClaw itself does not currently publish a `SECURITY.md`; this document covers this repository only (the Go trust-kernel and any Isthmus-specific TypeScript changes). For a vulnerability in NanoClaw's own unmodified code, please also report it upstream at [nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw).

## Scope

In scope:
- `go-host/` — the Go trust-kernel (guard decisions, mount security, egress verification, session/lifecycle liveness logic, credential-broker prototype)
- Any TypeScript changes in this repository that diverge from upstream NanoClaw
- The compatibility/regression harness itself, if a gap in it would let a real behavioral divergence go undetected

Out of scope (report upstream instead):
- Vulnerabilities that exist identically in unmodified upstream NanoClaw code this project has not touched

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security report. Instead, use GitHub's private vulnerability reporting for this repository (Security tab → "Report a vulnerability").

Please include, where possible: the specific file/function affected, whether the issue is in the Go kernel or the TypeScript layer, a minimal reproduction, and your assessment of impact. Reports about the mount-security, egress, or guard boundaries are especially high-value given this project's scope — see [`docs/threat-model.md`](docs/threat-model.md) and [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md) for the current threat model and named open gaps, which is a good starting point before reporting something already tracked there.

## Response expectations

This is currently a small, single-maintainer project in pre-beta status — response times are best-effort, not SLA-backed. A genuine security report will be acknowledged as soon as it's seen, and a fix or mitigation timeline communicated once the report is understood. Coordinated disclosure is preferred: please allow a reasonable window to investigate and patch before any public disclosure.

## Known, disclosed gaps

This project maintains a public list of known security gaps rather than implying a stronger guarantee than what's actually verified — see [`docs/threat-model-addendum-p5.md`](docs/threat-model-addendum-p5.md). A report that matches something already listed there is still welcome (independent confirmation is useful), but won't be treated as a new finding.

## Supported versions

Pre-beta: only the current `main`/latest commit on the default branch is supported. There is no released-version support matrix yet.

# ADR-025: The Kernel Refuses to Start With Unenforceable Egress Lockdown

**Status**: Accepted, 2026-09-24.
**Depends on**: ADR-024 (`docs/ADR-024-egress-lockdown-network-wiring-gap.md`), which restored `-docker-network` computation on the one correct path (`kernel-supervisor/index.ts`). This ADR closes the gap that fix left open — recorded as finding #4 in the code review of ADR-024's own PR.

## Context

ADR-024 fixed egress lockdown by making `kernel-supervisor/index.ts` — the module that spawns `nanogo serve` — compute the correct `-docker-network` flag from `NANOCLAW_EGRESS_LOCKDOWN`. That fix is correct as far as it goes, but it has a structural property the code review named directly: `internal/kernel`'s own executor has no independent notion of egress lockdown at all. `-docker-network` is a plain, trusted string; the kernel does whatever it's told and nothing more.

This matters because `kernel-supervisor/index.ts` is not the only thing that starts `nanogo serve`. `scripts/ec06-live-smoke.sh` does too, directly, with no `-docker-network` flag at all — confirmed during the review, not a hypothetical. Anyone running that harness (or a future script shaped like it) with lockdown enabled gets open egress, silently, which is the exact bug ADR-024 fixed, reachable again through a second door.

The general lesson, stated plainly: a security property enforced only by one caller computing a flag correctly is validation, not enforcement — the same distinction `go-host/docs/ADR-008` (superseded numbering; see the P6-02 enforcement-boundary ADR) drew for mount/build/kill admission generally. This ADR applies that same principle to network topology specifically, which ADR-016 had deliberately left as caller-computed.

## Decision

`nanogo serve` now reads `NANOCLAW_EGRESS_LOCKDOWN` from its **own** process environment — not a new flag, not something a caller passes — and refuses to start if it's `true` but no `-docker-network` was given:

```
NANOCLAW_EGRESS_LOCKDOWN=true but no -docker-network was passed — refusing to
start with unenforceable egress lockdown rather than silently allowing open
egress.
```

Reading the environment directly, rather than adding another flag, is the point: environment variables are inherited by child processes by default, so this check fires for *any* spawner whose process tree has `NANOCLAW_EGRESS_LOCKDOWN` set — including one that never learned about `-docker-network` at all, like `ec06-live-smoke.sh`. A flag-based check would only re-close the door ADR-024 already closed for the one caller that remembers to pass it; this closes it for every caller, present or future, without needing each one to opt in.

This is deliberately **fatal**, not a warning — unlike the adjacent `-allowlist`-not-configured case in the same function, which warns and keeps running with a narrower guarantee. The difference: no-allowlist has a coherent "narrower but real" degraded mode (unconditional trust, same as the pre-hardening baseline). Lockdown-expected-but-unenforceable has no coherent degraded mode — it's either enforced or it's exactly the silent-open-egress bug this whole area exists to prevent. `ensureEgressNetwork()` on the TS side already treats this as fatal (`EgressLockdownError`, "throw rather than silently spawn... with open egress"); this makes the Go side match that contract instead of being more lenient than the very thing it's supposed to independently verify.

**Known, accepted gap**: `src/config.ts`'s `EGRESS_LOCKDOWN` also honors a value from a `.env` *file* (`src/env.ts`'s `readEnvFile`), which Node never copies into `process.env`. A lockdown enabled only that way — never exported as a real environment variable — is invisible to this check, the same as it would be to any other spawner's inherited environment. The correctly-computed `-docker-network` flag still reaches the kernel fine on the normal path in that case; only this specific backstop can't see it. Exporting `NANOCLAW_EGRESS_LOCKDOWN` as a real environment variable — the ordinary way to configure a long-running service via systemd/launchd unit config — avoids the gap entirely. Not fixed here: replicating `.env`-file parsing in Go for one boolean is more complexity than a defense-in-depth backstop warrants; the primary enforcement path doesn't depend on it.

## Consequences

- `nanogo serve`, started any way, by anything, refuses to run with lockdown expected but unenforced. `ec06-live-smoke.sh` and any future ad hoc spawner are covered without needing their own updates.
- `buildServeKernel` (the pure, testable assembly function) gained one new field (`serveFlags.egressLockdownExpected`) and one new error path, both covered by new tests (`TestBuildServeKernel_EgressLockdownExpectedButNoNetwork_Errors`, `_WithNetwork_Succeeds`, `_NotExpected_NoNetworkRequired`).
- No change to `kernel-supervisor/index.ts` or its own tests — the TS side already computes the right flag; this is a second, independent check, not a replacement for the first.
- The `.env`-file gap above is a known, documented limitation, not a silent one — worth revisiting if this project ever centralizes config loading between the TS host and the Go kernel, but not before.

## References

- `go-host/docs/ADR-024-egress-lockdown-network-wiring-gap.md` — the fix this closes the remaining gap in.
- `go-host/cmd/nanogo/serve.go` (`serveFlags.egressLockdownExpected`, `buildServeKernel`'s new check, `runServeCmd`'s `os.Getenv("NANOCLAW_EGRESS_LOCKDOWN")` read).
- `go-host/cmd/nanogo/serve_test.go` — the three new tests.
- `scripts/ec06-live-smoke.sh` — the concrete second spawner that motivated this.

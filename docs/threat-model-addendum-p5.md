# Threat Model Addendum: The Four Missing P1-04 Topics

**Status**: committed 2026-09-02, as pre-Phase-5 prep. Appends to `threat-model.md` (P1-04) rather than replacing it — that document's authority-surface enumeration stands unchanged and is not repeated here.

## Why this addendum exists

P1-04's own instruction was: *"List assets, trust boundaries, threat actors and misuse cases: host files, credentials, other sessions, Docker socket, network, malformed input and generated-code mistakes."* `threat-model.md` delivered an excellent, exhaustively-verified answer to one part of that brief — the authority-surface call-site enumeration and the "what would have to move behind Go" question. But a direct word-frequency check (part of the Opus pre-Phase-5 review, 2026-09-02) found it never addresses four of P5-01's six required test areas at all: **Docker socket** (as an asset, not the CLI's own Unix socket), **privileged/root execution**, **cross-session access**, and **secret/credential exposure**. `path traversal` and `symlink` also don't appear, though `session-manager.ts`'s attachment/outbox defenses (host-decomposition.md #3) already document the relevant pattern elsewhere.

P5-01's job is to convert `threat-model.md`'s invariants into executable tests. It cannot convert what was never written down. This addendum fills the four gaps, grounded in real, already-verified source (the pinned `go-host-experiment` checkout, `v2.3.0` / `54d9d9a5`) and in research this project already did but hadn't folded into the committed threat model (the OpenClaw CVE, the Mastra supply-chain compromise — both previously recorded only in the out-of-repo `assessment.md`).

## 1. Docker socket

**Asset**: `/var/run/docker.sock` (or the Windows/macOS Docker Desktop equivalent) — root-equivalent access to the whole host if mounted into any container.

**Trust boundary**: the socket must never appear as a mount target inside any agent (or auxiliary) container, under any mount class, regardless of composition path.

**Current state, verified by direct execution** (see `docs/mount-validation-fixtures-p5.md` for the full methodology and case table): `src/drivers/types.ts`'s `validateSpec`/`mountAllowed` on the pinned `v2.3.0` baseline does **not** block a mount targeting `/var/run/docker.sock` when it carries `class: 'allowlisted-extra'` — `mountAllowed`'s handling of that class is `return true` unconditionally, with no independent path check. This is the exact gap already found and fixed at the TypeScript layer in [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680) (not yet in this project's pinned baseline — see ADR-003 and the mount-security-hardening.patch note below). It is also the same failure class as OpenClaw's disclosed `CVE-2026-27002` / `GHSA-w235-x559-36mg` ("Docker container escape via unvalidated bind mount config injection," fixed in `2026.2.15+`) — direct, real-world precedent for exactly this bug shape in a sibling project.

**Misuse case**: a compromised transitive dependency with host-process code execution (the Mastra-compromise attack shape — see §4 below) constructs a `SessionSpec` directly, bypassing `buildMounts()`'s own allowlist check, and hands it to `driver.prepare()` with `/var/run/docker.sock` labeled `allowlisted-extra`. `validateSpec` — the one unconditional chokepoint every spec passes through — lets it through today.

**Testable invariant for P5-01**: *no `SessionSpec`, however composed, may reach a driver's `prepare()` with `/var/run/docker.sock` (or any path resolving to the Docker socket via symlink) in its mount list — regardless of declared mount class.*

## 2. Privileged / root execution

**Asset**: the agent container's effective UID/GID and Linux capability set.

**Trust boundary**: an agent container must run as a non-root, non-privileged user with no elevated capabilities, by default and without an explicit, audited opt-in.

**Current state**: `SessionSpec.runAs?: { uid: number; gid: number }` (`drivers/types.ts`) is optional — its doc comment says explicitly this exists because "not every realization has such a default, so the identity that must read 0600 material has to be explicit in the spec rather than inherited from the image." `validateSpec` does **not** reject an omitted `runAs`, nor does it check for `uid: 0`/`gid: 0` if one is supplied. Whether the Docker driver itself defaults to a safe non-root user when `runAs` is absent was not verified this pass (would require reading `docker-driver.ts`'s `prepare()` in full, not done here) — that is a concrete follow-up for P5-03, whose own scope ("enforce safe container defaults... reject unsafe requested settings") already targets exactly this gap.

**Misuse case**: a `SessionSpec` composed with `runAs: { uid: 0, gid: 0 }` (or no `runAs` at all, if the driver's own default turns out to be root) grants the agent — and by extension a successful prompt-injection payload running inside it — root inside its own container namespace, widening the blast radius of any container-escape primitive found elsewhere (e.g. a mount misconfiguration per §1).

**Testable invariant for P5-01**: *`validateSpec` (or a Go-side equivalent) rejects any `SessionSpec` whose `runAs.uid`/`gid` is `0`, and separately, `docker-driver.ts`'s realization must be confirmed to apply a non-root default when `runAs` is omitted — recorded as a pass/fail finding, not assumed.*

## 3. Cross-session access

**Asset**: one session's `v2-sessions/<agentGroupId>/<sessionId>/` directory tree, and its `inbound.db`/`outbound.db` files specifically.

**Trust boundary**: a session must never be able to read or write another session's — or another agent group's — mailbox files or workspace directory, even via a crafted or forged session/group identifier.

**Current state, verified by direct execution**: `mountAllowed`'s `group-state` case (`drivers/types.ts`) checks `mount.groupScope !== spec.key.agentGroupId` and, for the shared `groupsRoot`, re-derives the target subtree from `GROUP_FOLDER_LABEL` rather than trusting `groupScope` alone (its own comment: *"`groupScope` cannot arbitrate, being stamped by the same composer whose mounts are being judged... the folder label can"*). This defense-in-depth reasoning is sound and, per this addendum's fixture capture, holds against three direct forgery attempts (mismatched `groupScope`, no folder label at all, wrong folder label). This is a **genuine strength**, not a gap — worth stating plainly rather than only hunting for problems.

**What remains unverified**: whether an equivalent check exists at the mailbox layer itself (`internal/mailbox`/`session-manager.ts`) for a forged `sessionId` reaching `Path(dataDir, agentGroupID, sessionID)` — i.e., does anything stop a caller from constructing a path string that walks up out of `v2-sessions/<agentGroupId>/` using a crafted `sessionID` containing `../` segments, independent of the mount-validation layer entirely (which governs what's mounted INTO a container, not what a host-side path-join operation resolves to before mounting)? Not traced this pass.

**Testable invariant for P5-01**: *(already covered)* re-run the three group-state forgery cases from `docs/mount-validation-fixtures-p5.md` as the first P5-04 (session/mailbox ownership) regression tests — they already pass on the TS baseline, so this establishes the LAW-08 floor P5-04 must not fall below. *(new)* add a negative test constructing a `sessionID`/`agentGroupID` containing `../` or absolute-path segments and confirm the resulting mailbox path is rejected or canonicalized before any file I/O, both in the existing TS `session-manager.ts`/`mailbox/sqlite` code and in the ported Go `internal/mailbox`/`internal/session` packages.

## 4. Secret / credential exposure

**Asset**: the OneCLI gateway's injected auth token (`contributedEnv`, per `drivers/types.ts`'s doc comment: "a provider registering `ANTHROPIC_AUTH_TOKEN=placeholder` for the proxy to overwrite"), and any other credential value that could end up in a container's environment, mount, or logs.

**Trust boundary**: no credential *value* — regardless of the env-var name it rides under — may cross into an agent container's environment; credentials that must be reachable ride by reference (a mounted, read-only, `identity-material`-classed file) never by value.

**Current state, verified by direct execution**: `validateSpec`'s `isSecretShaped`/`looksLikeCredential` checks (`drivers/types.ts`) are real and were confirmed, via the fixture capture, to catch (a) a credential-shaped key name (`ANTHROPIC_API_KEY`) in plain `env`, (b) a credential-*shaped value* under an innocuous key name (`GW_CRED`) — the check measures both sides, not just key naming — and (c) a credential value smuggled into `contributedEnv`, the one lane whose key-name check is deliberately exempted for legitimate placeholder injection. A path value under a credential-shaped key name in `contributedEnv` (the legitimate `PROXY_CLIENT_KEY=/run/session/session-key.pem` pattern) correctly passes. This is real, tested, working defense.

**Real-world grounding for why this matters beyond this codebase**: in June 2026, the Sapphire Sleet actor (North Korea-attributed) compromised a legitimate npm maintainer account and injected malicious code into 140+ packages in the Mastra ecosystem — an AI-agent framework, the same software category as NanoClaw — via a `postinstall` hook, targeting developer credentials and crypto wallets (Microsoft Security blog, 2026-06-17). This is current, same-category, nation-state-attributed precedent for exactly the "a compromised dependency with host-process code execution" actor this section (and §1's Docker-socket misuse case) assumes. NanoClaw's own `pnpm-workspace.yaml` `onlyBuiltDependencies`/`minimumReleaseAge` gates (verified live, not just documented) would have blocked that specific attack's install-time execution vector — a genuine, already-present layer of defense worth naming, separate from what Phase 5's Go validation adds for the *runtime* `require()`-and-call surface.

**What remains unverified**: whether the identity-material mount class's `ro`-only, never-into-agent invariant (confirmed enforced by the fixture capture) is the *only* place a leased credential can reach a container, or whether `contributedEnv`'s provider-contribution lane has any other injection point not covered by `looksLikeCredential`'s prefix list (which is explicitly a floor, not a guarantee, per its own doc comment). Not traced this pass — a reasonable P5-05 (credential isolation) starting point given that task's own instruction to "trace current credential flow first."

**Testable invariant for P5-01**: *(already covered)* the four `contributedEnv`/`env` fixtures from the capture become P5-05's baseline regression set. *(new)* P5-05 should explicitly trace whether any code path writes a raw credential value to a log line, an error message, or a file outside the `identity-material` mount discipline — none of the paths above were checked for this.

## What this addendum does not do

It does not re-run or re-verify `threat-model.md`'s own authority-surface enumeration (unchanged, still accurate as of this addendum). It does not attempt path-traversal/symlink coverage beyond what §1 and §3 already note. `session-manager.ts`'s `extractAttachmentFiles`/`readOutboxFiles` lstat-then-realpath-then-wx sequence (host-decomposition.md #3) is the authoritative existing treatment of that topic and should be assigned explicitly to a P5 task (P5-02 or P5-04 — see the Opus review) rather than re-derived here.

## References

- `threat-model.md` (P1-04) — the document this addendum extends.
- `docs/mount-validation-fixtures-p5.md` — the executable fixture capture backing every "verified by direct execution" claim above.
- `src/drivers/types.ts` (pinned `v2.3.0` / `54d9d9a5`) — `validateSpec`, `mountAllowed`, `isSecretShaped`, `looksLikeCredential`.
- `mount-security-hardening.patch` / [nanocoai/nanoclaw#3680](https://github.com/nanocoai/nanoclaw/pull/3680) — the shipped, not-yet-baseline fix for the `allowlisted-extra` gap in §1.
- OpenClaw `CVE-2026-27002` / `GHSA-w235-x559-36mg`.
- Microsoft Security blog, 2026-06-17, "Postinstall payload inside Mastra npm supply-chain compromise."
- ADR-003 — the Phase 5 enforcement-architecture decision this addendum's findings feed into.

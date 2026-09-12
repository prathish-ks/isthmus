# Host Decomposition Map (P1-01)

Read-only classification of NanoClaw's host-side (`src/`) components against the Go-kernel rebuild. No code was changed to produce this document — it is a map, not a patch.

Legend:
- **GO KERNEL** — small, security/liveness-critical, behavior is a closed contract (input → deterministic decision/action). Good rewrite candidate.
- **KEEP TYPESCRIPT** — customization surface, frequently-touched, or tightly coupled to the Node/Bun ecosystem (channel SDKs, provider SDKs). Must stay TS per LAW-01/LAW-02.
- **BOUNDARY** — the seam itself: a narrow interface a Go kernel would have to implement or call across. Getting the contract right here matters more than the classification.
- **UNDECIDED** — real complexity or coupling that needs a spike before committing either way.

Scope: `src/` (the host process). `container/agent-runner/` (Bun + Claude Agent SDK) is treated as a single boundary component at the bottom — Design Law already places it outside the kernel, and confirming that only needed the mount/wiring evidence already gathered in `container-runner.ts`, not a line-by-line read of its internals.

---

## 1. Entry point

**`src/index.ts`** — process bootstrap: wires channel adapters, starts the router, delivery polls, host sweep, egress network.
- Classification: **KEEP TYPESCRIPT**
- Rationale: pure composition root, no logic of its own worth porting; it exists to wire modules together, and those modules are themselves split below.
- Risk: low either way — it's glue.

## 2. Router — `src/router.ts`

Inbound message → messaging group resolution → engage-mode evaluation → access gate → session resolution → mailbox write → container wake.
- Classification: **BOUNDARY**, leaning **KEEP TYPESCRIPT** for now
- Rationale: this is the busiest, most frequently-edited file in the codebase (hooks for sender resolution, access gates, sender-scope gates, channel-request gates, session-created hooks, message interceptors — six extension seams). Every one of those hooks is how the *customization* ecosystem (permissions module, cross-session-context module, scheduling, agent-to-agent) plugs in. Rewriting this in Go would either (a) force those modules into Go too, breaking LAW-01, or (b) require a Go↔TS RPC boundary on the hottest path in the system for every inbound message.
- What's actually Go-shaped inside it: the *mechanical* pieces — parsing an inbound event, the due-message/engage-mode decision, writing to SQLite — are simple enough to port. What's not Go-shaped is the six hook seams, which are why this stays TS.
- Risk: high if rewritten — this is where a subtle regression (e.g. mis-ordered interceptor, wrong thread-policy resolution) silently drops or misroutes user messages. Any Go migration of adjacent code must not touch this file's hook contracts.

## 3. Session manager — `src/session-manager.ts`

Session lifecycle (create/resolve), mailbox writes, attachment extraction with symlink/traversal defenses, outbox reads with matching defenses.
- Classification: **BOUNDARY** (attachment/outbox path-safety) + **KEEP TYPESCRIPT** (session resolution logic)
- Rationale: `extractAttachmentFiles`/`readOutboxFiles`/`clearOutbox` are genuinely security-critical (untrusted `messageId`/filename from platform adapters, defended via basename checks + `lstat`-before-realpath + `wx`-exclusive writes) and are a closed, well-specified contract: given untrusted strings, either write inside a sandboxed dir or refuse. That's exactly the shape of a Go-kernel candidate — small, adversarial-input-in/boolean-or-file-out, no external SDK dependency.
- Session resolution (`resolveSession`, session-mode branching, the per-key creation lock) is more entangled with the mailbox abstraction and session-created hooks — safer to leave with the router side for now.
- Risk: **high** for the attachment/outbox functions specifically — this is the one place host code writes to disk based on adversarial input from a channel adapter (WhatsApp message IDs are peer-controlled). A Go port must reproduce the lstat-then-realpath-then-wx sequence exactly, in that order — any reordering reopens the symlink race the comments describe.

## 4. Container runner — `src/container-runner.ts`

Composes `SessionSpec` (mounts, env, resource limits) per session, hands it to a `SessionDriver`, tracks active containers, lifecycle (spawn/adopt/kill/finish), builds per-group images.
- Classification: **UNDECIDED**, leaning **GO KERNEL** for the composition/validation logic, **KEEP TYPESCRIPT** for `buildAgentGroupImage`
- Rationale for GO KERNEL lean: `composeSessionSpec`, `buildMounts`, `mergeMounts`, `parseMemoryMb`/`parsePidsLimit`, and the mount-class system (`group-state` / `install-surface` / `allowlisted-extra`) are the actual trust boundary of the whole system — this is where the guarantee "an agent container cannot read `~/.ssh`" gets enforced. That's precisely the kind of security-critical, well-specified logic a hardened Go kernel exists to own, and it does not depend on any Node-only library (no channel SDKs, no Agent SDK).
- Rationale against GO KERNEL (why UNDECIDED not settled): it's the single largest, most cross-cutting file in `src/` (958 lines), threading together config, provider contribution, gateway contribution, mount security, group filesystem init, and driver abstraction. A full port is a multi-week endeavor on its own — a "Phase 3+" target, not a "start here."
- `buildAgentGroupImage` (shells out to `docker build` with a hand-assembled Dockerfile) is a genuine KEEP TYPESCRIPT: it is not on any runtime hot path, mutates via `execAsync`, and its value is developer convenience, not security posture.
- Risk: **very high** if attempted early — `labelValueLegal`/`GROUP_FOLDER_LABEL` and the mount-class enforcement are exactly the code that keeps one agent group from touching another's files or the host's credentials. Any gap introduced during a port is a sandbox escape, not a bug.

## 5. Delivery — `src/delivery.ts`

Polls outbound mailboxes (1s active / 60s sweep), delivers via channel adapters, handles `system` actions (a pluggable action registry, some guard-wrapped), retry/backoff, permission checks on cross-channel sends.
- Classification: **KEEP TYPESCRIPT**
- Rationale: the delivery-action registry (`registerDeliveryAction`) is a first-class extension point used by essentially every module (approvals, agent-to-agent, scheduling) — same argument as the router's hooks. The actual polling loop is simple enough to port, but it's inseparable in this file from the action dispatch, which is not.
- One sub-piece worth flagging as **BOUNDARY**: the cross-channel delivery permission check (origin-chat-or-explicit-destination-row) is a real guard decision, structurally similar to `guard.ts` below, and could be extracted and ported alongside it later.
- Risk: medium — delivery bugs are visible fast (message not delivered / delivered twice), which makes them safer to iterate on than router or mount-security bugs.

## 6. Host sweep — `src/host-sweep.ts`

Periodic maintenance: stuck/idle container detection (`decideStuckAction`), stale processing-row reset with backoff, task-session closing, egress network re-heal.
- Classification: **GO KERNEL** (the decision function) / **KEEP TYPESCRIPT** (the orchestration around it)
- Rationale: `decideStuckAction` is explicitly written as a **pure function** — deterministic inputs (now, heartbeat mtime, container start time, container state, claims) → one of three decisions. That's about as clean a Go-kernel candidate as exists in this codebase: no I/O, no hooks, already unit-testable in isolation (the file even exports a `_resetStuckProcessingRowsForTesting` shim). This is a strong candidate for an *early* Go slice — small, isolated, already has the shape of a pure decision function the way `guard()` does.
- The orchestration (`sweepSession`, `maintainSessionMailbox`) stays TS because it calls into module hooks (`scheduling/recurrence`, `cross-session-context`) via dynamic `import()` — another customization seam.
- Risk: low to port (it's pure and testable) but medium in consequence if wrong — a wrong stuck-decision either kills a live container mid-turn or lets a truly stuck one run forever.

## 7. Guard — `src/guard/guard.ts`, `src/guard/index.ts`

The single privileged-action decision function every guarded action consults: fail-closed, compile-time-safe action catalog (branded `GuardedAction`, never a string lookup), grant/hold/deny semantics, live re-evaluation on replay.
- Classification: **GO KERNEL** — strongest candidate in the entire codebase
- Rationale: this is *exactly* the profile a trust-kernel rewrite targets. It's small (73 lines), it is the one mandatory choke point for every privileged action in the system, its contract is already documented as fail-closed with no fail-open path, and its only dependency is a single DB read (`getPendingApproval`) to validate a grant. Domain-specific `decide` functions live at the module edges (deliberately out of scope here) — the kernel only needs to own the invariants: unknown action → deny, throwing decide → deny, grant satisfies hold but never overrides a live deny, grant must match a still-live DB row.
- Caveat: the *decide* functions themselves (defined per-action in `permissions/guard.ts`, `agent-to-agent`, etc.) are policy, not kernel — they stay in TypeScript modules and get *invoked through* the guard. Only the choke point itself is a kernel candidate.
- Risk: this is the highest-value AND highest-risk single file to port. Get it right and you have a real trust kernel. Get the grant-liveness check or the fail-closed-on-throw behavior subtly wrong and every privileged action in the system (create_agent, install_packages, add_mcp_server, channel registration, sender approval) inherits the bug.

## 8. Egress lockdown — `src/egress-lockdown.ts`

Ensures the OneCLI gateway is attached to a Docker `--internal` network before any agent spawns; fails closed (throws) if it can't be established.
- Classification: **GO KERNEL**
- Rationale: small (94 lines), security-critical, its entire job is "shell out to Docker, verify network topology, fail loudly if it can't be verified" — no customization surface, no hook, no Node-specific dependency beyond `child_process.execFileSync` (which Go's `os/exec` replaces directly). This is a very clean, very self-contained port.
- Risk: low complexity, high consequence — a bug here means agents get open internet egress silently instead of routing through the credential-injecting gateway. Straightforward to test in isolation (mock the two `docker` calls) both before and after a port, which makes this a good *second or third* Go slice after `guard.ts` and `decideStuckAction`.

## 9. Config — `src/config.ts`

Central `.env`/`process.env` loader, path constants, egress/timezone/resource-limit resolution.
- Classification: **KEEP TYPESCRIPT** (for now) / candidate **BOUNDARY** later
- Rationale: it's not complex, but *everything* reads from it — a Go kernel that owns spawn/guard/egress-lockdown will need equivalent config resolution, which means this eventually needs a parallel Go implementation or a shared config format (e.g. both processes reading the same `.env` independently). Not worth tackling until there's an actual Go process that needs to read it — premature to classify further today.
- Risk: low technically, but this is the file most likely to cause "worked on my machine" drift between the TS and Go readers of the same `.env` if the two implementations of `readEnvFile`/`resolveConfigTimezone` ever diverge in behavior (e.g. IANA timezone validation edge cases). Whichever phase introduces the Go side of this should write a compatibility test that runs both parsers against the same fixture `.env` files.

## 10. Mount security — `src/modules/mount-security/index.ts`

Validates `additionalMounts` against an allowlist stored outside the project root (`~/.config/nanoclaw/mount-allowlist.json`), with blocked-pattern matching, realpath resolution, container-path traversal checks.
- Classification: **GO KERNEL**
- Rationale: same profile as `guard.ts` and `egress-lockdown.ts` — small, security-critical, deterministic (path in → allow/deny + resolved real path out), no hooks, no customization surface (the *allowlist* is user-editable config, but the *validator* is not). The module's own doc comment is explicit about the check's scope (root-only, doesn't descend) — that's a property a Go port must preserve exactly, not "improve" unilaterally, since callers may depend on the documented limitation.
- Risk: medium-high — this is literally the code deciding whether a container gets read-write access to a host path. The blocked-pattern list (`.ssh`, `.aws`, `.config/nanoclaw`, `.local/bin`, credential filenames) must port verbatim; missing even one entry reopens a credential-exfiltration path.

## 11. Permissions module — `src/modules/permissions/index.ts`

Sender resolution (upserts `users` rows), access gate (unknown-sender policy enforcement: strict/request_approval/decline_notify/public), sender-scope gate, channel-registration approval flow (cards, free-text agent naming), response handlers.
- Classification: **KEEP TYPESCRIPT**
- Rationale: this is a *domain module*, not kernel — it's 675 lines of business logic (card flows, free-text interceptors, agent creation, DM resolution) built entirely on top of the router's hook seams and the guard's decision seam. It's the clearest example in the codebase of "ordinary customization" that Design Law says must never require Go. If anything, this module is evidence *for* the router/guard split above: the policy decisions here (`sendersAdmit`, `channelsRegister` in its sibling `guard.ts`) are consulted *through* `guard()`, but defined here in TS, exactly as intended.
- Risk: low from a kernel-safety perspective (a bug here is a UX/workflow bug, not a sandbox escape) — but high in scope if anyone proposed porting it; don't.

## 12. Mailbox — `src/mailbox/model.ts`, `src/mailbox/sqlite/index.ts`, `src/mailbox/index.ts`

`model.ts`: the canonical, strictly-validated wire format for every mailbox record (inbound/outbound/processing-ack/delivery/destination/routing/state/container), with a parser that rejects unknown fields and nested objects. Explicitly dual-implemented — the comment says the Bun container keeps its own checked-in copy because host and container are packaged independently and share no runtime module.
`sqlite/index.ts`: the concrete SQLite-backed implementation (`SqliteAgentMailbox`) of the abstract mailbox interface, using `better-sqlite3`.
- Classification: **BOUNDARY** (model.ts) / **KEEP TYPESCRIPT** (sqlite implementation, for now)
- Rationale: `model.ts` is *the* artifact that most directly matters for LAW-06 (contracts before rewrites) and LAW-09 (upstream must be able to move independently) — it is already written as a implementation-independent schema with a from-scratch strict parser, already duplicated once (host↔container) by design. A Go kernel that wanted to read/write mailbox state directly (rather than shelling out or RPC-ing to the TS host) would need a Go transcription of exactly this file — same validation rules, same field-by-field parsing — which is a well-scoped, mechanical (if tedious) port.
- The SQLite implementation itself (`SqliteAgentMailbox`, `wrapSqliteInbound`/`wrapSqliteOutbound`) is more of an implementation detail behind the `AgentMailbox` interface (see `mailbox/index.ts`'s factory). The codebase already treats swapping this out as a supported extension point — the file header of `container-runner.ts` says "other implementations preserve that ownership" — which argues for leaving it in TS until there's a concrete reason (e.g. a Go host wanting direct DB access without an RPC hop) to duplicate it.
- Risk: low to port `model.ts` (it's pure validation, easy to differentially test against the TS version with the same fixtures); medium to touch the SQLite implementation, since `better-sqlite3` is a native Node binding with its own build-script quirks already seen in this project's own setup (P0-09 baseline).

## 13. Channel adapter interface — `src/channels/adapter.ts`

Pure TypeScript interfaces (`ChannelAdapter`, `InboundEvent`, `ChannelDefaults`, etc.) — no runtime logic, just the contract every channel module implements.
- Classification: **KEEP TYPESCRIPT**
- Rationale: this is the single clearest LAW-01 boundary in the codebase — it's the seam through which WhatsApp, Telegram, Slack, Discord, CLI etc. all plug into the router. It has zero business writing itself in Go: doing so would mean every channel adapter (an ordinary-customization surface if anything is) would need to cross a language boundary to talk to the host.
- Risk: none from a kernel-safety view; this file *is* the boundary contract other boundaries should be modeled after (compare its explicitness with `guard`'s branded-type pattern).

## 14. Central DB types — `src/types.ts`, `src/db/schema.ts`

`types.ts`: TypeScript interfaces for every central-DB entity (AgentGroup, MessagingGroup, User, Session, PendingApproval, etc.), heavily annotated with migration history and optionality rationale.
`db/schema.ts`: reference SQL schema, explicitly **not used at runtime** (migrations are the source of truth; this is documentation).
- Classification: **BOUNDARY**
- Rationale: same category as `mailbox/model.ts` — this is the shape of the shared state a Go kernel would need to read (at minimum: `sessions`, `pending_approvals`, `agent_groups` for `guard.ts`'s `getPendingApproval` and `container-runner.ts`'s config resolution). Any Go component reading this DB needs a Go transcription of these types, kept in sync with the same migration history. Not urgent today (nothing Go-side reads the DB yet), but worth flagging now so a future phase doesn't rediscover the same optionality footguns documented inline here (`denied_at`, `detached_at`, `threads` — all optional on the TS type specifically so pre-migration fixtures don't break).
- Risk: low today (no Go reader exists); the risk surfaces later, as schema drift between a hand-maintained Go struct set and the TS types if this isn't treated as a generated-or-verified contract from the start.

## 15. Container / agent-runner boundary

Not deep-read this pass (see note above) — classified from the mount/spawn evidence already gathered:
- The agent-runner (Bun + Claude Agent SDK, `container/agent-runner/src/`) is mounted **read-only** into every container at `/app/src` (`container-runner.ts`'s `buildMounts`); it never has a code-execution path back into the host's filesystem.
- It communicates with the host exclusively through the mailbox SQLite files (`/workspace` mount) and the materialized `container.json` / `CLAUDE.md` — i.e., entirely through the boundaries already classified above (mailbox model, mount security), not through any direct RPC.
- Classification: **KEEP TYPESCRIPT** (well, Bun/TS) — Design Law already settles this (LAW-01/LAW-02: ordinary customization, which includes almost everything agent-facing, must never require Go), and nothing observed in the host code this pass suggests otherwise. No further host-side investigation needed to confirm this; a *container-side* audit (Dockerfile, entrypoint.sh, MCP tool surface) is P1-03/P1-04 territory (compatibility contract, threat model), not P1-01.

---

## Summary table

| # | Component | Classification |
|---|---|---|
| 1 | `index.ts` (entry point) | KEEP TYPESCRIPT |
| 2 | `router.ts` | BOUNDARY → KEEP TYPESCRIPT |
| 3 | `session-manager.ts` (attachment/outbox I/O) | BOUNDARY (security-critical) |
| 3b | `session-manager.ts` (session resolution) | KEEP TYPESCRIPT |
| 4 | `container-runner.ts` (spec composition, mounts) | UNDECIDED → GO KERNEL lean |
| 4b | `container-runner.ts` (`buildAgentGroupImage`) | KEEP TYPESCRIPT |
| 5 | `delivery.ts` | KEEP TYPESCRIPT |
| 6 | `host-sweep.ts` (`decideStuckAction`) | GO KERNEL |
| 6b | `host-sweep.ts` (orchestration) | KEEP TYPESCRIPT |
| 7 | `guard/guard.ts` | **GO KERNEL (top priority)** |
| 8 | `egress-lockdown.ts` | GO KERNEL |
| 9 | `config.ts` | KEEP TYPESCRIPT (for now) |
| 10 | `modules/mount-security/index.ts` | GO KERNEL |
| 11 | `modules/permissions/index.ts` | KEEP TYPESCRIPT |
| 12 | `mailbox/model.ts` | BOUNDARY |
| 12b | `mailbox/sqlite/index.ts` | KEEP TYPESCRIPT (for now) |
| 13 | `channels/adapter.ts` | KEEP TYPESCRIPT (boundary contract) |
| 14 | `types.ts` / `db/schema.ts` | BOUNDARY |
| 15 | `container/agent-runner/` | KEEP TYPESCRIPT (Bun) |

## Suggested Go-kernel ordering (informed by this map, not a commitment)

1. `guard.ts` — smallest, most self-contained, highest conceptual payoff ("we have a real trust kernel").
2. `decideStuckAction` (from `host-sweep.ts`) — already a pure function, already testable.
3. `egress-lockdown.ts` — small, self-contained, one external dependency (`docker` CLI via subprocess).
4. `mount-security/index.ts` — small, self-contained, but higher stakes (get the blocked-pattern list exactly right).
5. `mailbox/model.ts` as a shared contract (Go transcription + differential tests against the TS parser) — needed before any of the above can be *called* from a real Go process instead of just unit-tested in isolation.
6. `container-runner.ts`'s spec composition — largest, most valuable, most dangerous; not a "first slice."

This ordering is a hypothesis for Phase 3 ("Minimal Go Host"), not a decision — Phase 2 (Compatibility Harness) should validate the mailbox contract and the guard contract with real fixtures before any Go code is written against them.

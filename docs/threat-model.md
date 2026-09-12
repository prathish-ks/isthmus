# P1-04 — Threat Model Baseline

Status: done, 2026-08-30. Verified directly against `nanocoai/nanoclaw` at the exact
pinned commit (`54d9d9a5`, tag `v2.3.0`) via a local clone and exhaustive text search
— not inferred from memory of earlier reads. Covers: an exhaustive enumeration of
every call site reaching `container-runner.ts`'s three Docker-facing functions (the
scope addition from P1-03), the kernel-invariant tests already in the codebase, the
two speculative checklist items carried over from the unverified second-opinion
update, and a direct answer to "what would have to move behind Go to prevent
bypass."

## Trust boundary map

Four actor kinds recur throughout the codebase (mirrors `GuardActor` in
`src/guard/types.ts`):

- **`host`** — the TypeScript process itself, or a caller through the local Unix
  socket (0600 permissions; per `cli/guard.ts`'s own comment, "the 0600 socket is
  the auth story — in code, unremovable by data"). Fully trusted.
- **`human`** — an admin/owner clicking an approval card or resolving a channel
  registration. Trusted once their identity is confirmed against a role table.
- **`agent`** — code running inside a container, on behalf of an agent group. Only
  *partially* trusted: it can be prompt-injected, and its container is confined by
  `mount-security`, but it can still write anything into `outbound.db` (nothing on
  the container side stops it).
- **`system`** — internal host processes (the sweep, container-restart) acting on
  their own timers/heuristics, not on behalf of any external request.

## The Docker-facing authority surface, exhaustively enumerated

`container-runner.ts` exports exactly three functions that touch Docker directly:
`wakeContainer` (spawn), `buildAgentGroupImage` (image rebuild), `killContainer`
(stop). Every call site in the codebase, found by text search across the full
source tree:

| Function | Caller | Actor | Gated by `guard()`? |
|---|---|---|---|
| `wakeContainer` | `router.ts` (ordinary message arrives) | any inbound message — **the least trusted, highest-volume case** | **No** |
| `wakeContainer` | `host-sweep.ts` (session has due messages) | `system` (periodic sweep) | No — but this is the *same* ordinary-message class as above, just via the sweep instead of the active poller |
| `wakeContainer` | `container-restart.ts` (restart-with-message helper) | `system` (host-invoked restart logic) | No |
| `wakeContainer` | `cli/resources/groups.ts` (`ncl groups restart`, no-message branch) | `host` or `agent`, via the CLI command catalog | **Yes — see below** |
| `wakeContainer` | `modules/approvals/primitive.ts`, `finalize.ts`, `response-handler.ts` ×2 | `system`, notifying an agent after a decision already made | N/A — downstream of a decision already gated |
| `wakeContainer` | `modules/agent-to-agent/agent-route.ts`, `create-agent.ts` | `system`, delivering an already-authorized message/creation | N/A — downstream of `a2a.send`/`agents.create`, already gated |
| `wakeContainer` | `modules/self-mod/apply.ts` (`wakeSessionById`, used as the kill callback) | `system`, respawning after an approved change | N/A — downstream of `self_mod.*`, already gated |
| `wakeContainer` | `modules/interactive/index.ts` (question-response delivery) | `system`, delivering an already-recorded answer | N/A |
| `buildAgentGroupImage` | `cli/resources/groups.ts` (`ncl groups restart --rebuild`) | `host` or `agent`, via the CLI command catalog | **Yes — see below** |
| `buildAgentGroupImage` | `modules/self-mod/apply.ts` (`install_packages` approved) | `agent`, only after human approval | **Yes — `self_mod.install_packages`** |
| `killContainer` | `host-sweep.ts` ×2 (absolute-ceiling timeout, claim-stuck timeout) | `system` (`decideStuckAction`) | No — host's own liveness heuristic, not an external request |
| `killContainer` | `container-restart.ts` | `system` | No — host-invoked restart |
| `killContainer` | `cli/resources/groups.ts` (`ncl groups restart`) | `host` or `agent` | **Yes — see below** |
| `killContainer` | `modules/self-mod/apply.ts` ×2 (`install_packages`, `add_mcp_server` approved) | `agent`, only after human approval | **Yes — `self_mod.*`** |

### The finding this table actually supports

This is more reassuring than P1-02/P1-03 alone suggested, and for a more precise
reason. It is **not** true that `container-runner.ts`'s Docker-facing functions are
a sprawling, mostly-unguarded surface. Enumerated exhaustively, there is exactly
**one deliberate, coherent gap**: the ordinary-message wake path (`router.ts` and
its sweep-driven twin in `host-sweep.ts`). Every other externally-reachable path —
self-mod's two actions, and (a discovery this task made, detailed below) every
`ncl` CLI command an agent can invoke — already goes through `guard()`. The
remaining callers are the host's own trusted internal maintenance (sweep timeouts,
crash-restart) or are downstream of a decision already made elsewhere.

That one gap is not an oversight, either: it is precisely the path that must stay
frictionless for the product to work at all — "a message arrived, wake the session
to answer it" is the core, highest-volume, every-message operation, and LAW-01/
LAW-04 are explicit that ordinary use must never carry security friction. So the
threat model's honest conclusion is: **the codebase already guards every
Docker-facing action an agent can deliberately reach except the one action that,
by design, must remain unconditional.** That sharpens, again, exactly what
Phase 3's first Go-kernel milestone is for: not "add missing decisions" (there
mostly aren't any missing), but "make session/runtime admission on the ordinary
path the one deliberately-ungated case it's supposed to be, safely". This means
bounded invariants — allowed mounts, resource caps, rate limits — rather than a
human approval step, consistent with the "Value check" discussion already on
record.

## A fifth grant-binding shape, missed by P1-03's audit: CLI-command-derived guards

Reading `cli/resources/groups.ts`'s `restart` command (the `ncl groups restart
[--rebuild] [--message]` command, which is the CLI path to all three Docker-facing
functions) led to `src/cli/guard.ts` — a mechanism P1-03's audit did not cover,
because it isn't a hand-written `defineGuardedAction` call at a module edge like
the six actions P1-03 audited. Instead, **every `ncl` command derives its own guard
catalog entry automatically** from its `CommandDef` (`commandGuardSpec` in
`cli/guard.ts`):

- `actor.kind === 'host'` (the local socket) → always `ALLOW` — the socket's file
  permissions are the entire authorization story for a local operator.
- An `agent` actor is checked against the agent group's `cli_scope`: `disabled`
  denies everything; `group` restricts the command to an allowlist of resources,
  forbids touching another group's ID in any argument, and explicitly denies an
  agent ever changing its own `cli_scope` (blocking the obvious privilege-escalation
  move).
- `cmd.hostOnly` commands (mount management, named explicitly in the code as the
  boundary `cli_scope` itself lives inside) are **denied to every container caller,
  unconditionally — even a `global`-scope, even with admin approval.** This is the
  one place in the whole codebase where the code refuses to let *any* approval
  override a structural boundary.
- Otherwise, `cmd.access === 'approval'` (which `groups restart` sets) holds for
  the group's admin chain — exactly the same `HOLD`/grant/replay machinery as
  self-mod, reusing the same `guard()`.

Its `grantCoversRequest` binds a `cli_command` grant only to the **command name**
(`payload.frame.command === cmd.name`), not to the specific arguments — coarser
than `a2a.send`'s per-target binding. In isolation this would mean one approved
`groups-restart` grant could in principle satisfy a hold for a *different*
`groups-restart` request (say, a different `--rebuild`/`--message` combination) —
but it doesn't actually widen the blast radius here, because `cli_scope`'s
structural checks re-run live on every consult regardless of the grant (an agent
can never target another group's ID, approved or not). So this is a sixth pattern,
distinct from all four already documented in `compatibility-contract.md`: **command-
name-level binding, backed by scope checks that are re-verified independently of
the grant** — safe in practice today, but worth naming precisely rather than
assuming it matches one of the other four shapes.

## Existing kernel-invariant tests — already real, not hypothetical

`src/guard/conformance.test.ts` (read in full) already
locks in four of the exact invariants this project would want preserved by any Go
port:

1. **No dangling holds**: every guarded action with a `grantActionName` has a
   registered approval handler (`registerApprovalHandler`) — a hold nobody can ever
   resolve is a bug this test catches today.
2. **Every mutating `ncl` command derives a `cli_command` hold**: directly tests
   the mechanism above — every `access: 'approval'` command's guard entry names
   `cli_command` as its grant action, confirming the CLI catalog derivation is
   wired correctly, not just "usually."
3. **The full domain catalog is present**: asserts all six hand-written guarded
   actions exist (`agents.create`, `a2a.send`, `self_mod.install_packages`,
   `self_mod.add_mcp_server`, `senders.admit`, `channels.register`) — confirming
   P1-03's audit found the complete catalog, not a subset.
4. **Duplicate action names throw**: the catalog's name-uniqueness guarantee is
   itself tested, not just asserted in a comment.

Two more test files carry the security-relevant liveness/mount logic:
`host-sweep.test.ts` / `host-sweep-grace.test.ts` (the `decideStuckAction` timing
and grace-period rules that decide when the host kills a container for being
stuck) and `modules/mount-security/index.test.ts` (the mount blocklist, per P1-01).

**Recommendation for later phases, not acted on now**: when a Go component takes
over any of this, `guard/conformance.test.ts`'s four assertions are the natural
first differential-test fixtures — they already define, precisely and in
executable form, what "the catalog is complete and self-consistent" means. Porting
the *tests'* intent (not necessarily their exact code) alongside the mechanism
would satisfy LAW-08 ("no weaker security than upstream") by construction rather
than by inspection.

## The two speculative items carried from the unverified second-opinion update

Recorded here as open questions for later design, not as findings — per the
project doc's note, these are kept because the underlying ideas are reasonable
threat-modeling hygiene, independent of the unverified incident reports that
originally raised them:

- **Host-local network endpoints vs. general egress.** Nothing surveyed this pass
  contradicts or confirms this as a live gap — `egress-lockdown.ts` was classified
  GO KERNEL in P1-01 for a different reason (it's small and self-contained), and
  this task didn't re-open it to check whether it already distinguishes
  `host.docker.internal`/`localhost` from internet destinations. Worth a specific
  read when `egress-lockdown.ts` actually gets ported, not before.
- **Reachable-human-principal check for a privileged role.** Nothing in the guard
  or approvals code read this session validates that `approver_user_id` or an
  agent group's admin role resolves to a channel identity distinct from the bot's
  own. Not confirmed as a gap (channel-identity resolution wasn't traced this
  pass) — just confirmed as *unaddressed*, which is different from confirmed-broken.

Neither is scheduled work. Both are candidate line items for whichever later task
first touches egress or identity resolution in earnest.

## Direct answer: what would have to move behind Go to prevent bypass?

This is the second-opinion review's original question, and P1-02/P1-03/P1-04
together now have a complete, evidenced answer — and it's sharper than "port
guard.ts" or even "gate container spawn."

**The decisions are mostly already there.** Of the two things a Go kernel could
supply — decisions and exclusive execution — this task confirms the *decision*
layer is in good shape. Five of six hand-written actions plus the entire `ncl`
command surface already consult `guard()`, with only the one deliberately-open
ordinary-message path as an exception.

**The gap is that every decision is advisory, not physically enforced.**
`wakeContainer`, `buildAgentGroupImage`, and `killContainer` are ordinary exported
TypeScript functions, callable from anywhere in the same process. `guard()`
returning `ALLOW` or `DENY` is a convention every *current* call site happens to
respect: self-mod calls the guarded wrapper, the CLI dispatcher calls the guarded
wrapper. But nothing stops a new module, a future refactor, or a compromised
dependency anywhere in that same Node process from importing
`container-runner.js` directly and calling `buildAgentGroupImage` without ever
touching `guard()`. This is the concrete, mechanical shape of "exclusive
enforcement": today, enforcement is exclusive only by the discipline of everyone
who writes code in this process remembering to call the guarded entry point
instead of the raw function. A Go kernel earns the word "exclusive" the moment
these three functions (or whatever narrow set Phase 3 scopes them to) physically
cannot be called except through a boundary that itself consults the equivalent of
`guard()` — i.e., when calling them from the TypeScript side requires crossing a
process boundary the kernel controls, not just calling a function the kernel
happens to also be able to call.

This reframes the Phase 3 target precisely: it is not "replace `guard()`" (leave
it — it's well-designed) and not "gate every code path individually" (most already
are). It is "move the three Docker-facing functions themselves behind a boundary
that TypeScript can request through but not call around" — which is a small,
concrete, and now well-evidenced target rather than an open-ended one.

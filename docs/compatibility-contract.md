# P1-03 — Host/Container Compatibility Contract

Status: done, 2026-08-30. Covers the base task (what host and container must agree on
to stay compatible) plus the two scope additions from the ChatGPT second-opinion
review: the `grantCoversRequest` grant-binding audit, and a full trace of one
privileged/guarded action end to end (complementing `docs/message-flow.md`'s
ordinary-message trace).

## Part A — the wire contract between host and container

### A1. The mailbox record contract is already single-sourced and generated — correcting P1-02

`docs/message-flow.md` described `mailbox/model.ts`'s parser as "independently
duplicated (host copy + container copy) by design, since the two processes share no
runtime module." Having now read `src/mailbox/model.ts`'s own header comment and
confirmed the container-side file directly, that phrasing overstates the risk.
**Correction:**

- The canonical file is `src/mailbox/model.ts` (host side). Its own header says:
  *"Edit `src/mailbox/model.ts` only, then run `pnpm mailbox-model:generate`. The
  runner copy is checked in because the Node host and Bun container are packaged
  independently and deliberately share no runtime module."*
- The container-side file is literally named `container/agent-runner/src/mailbox/model.generated.ts`
  — confirmed byte-for-byte identical to the host file, including the same header
  comment. It is a generated artifact, not a hand-maintained parallel implementation.
- So there is exactly **one** hand-edited source of truth for the record shapes and
  parsers; the container's copy is mechanically produced from it and checked in only
  because the two packages build and ship independently (Node host vs. Bun
  container image). A developer cannot accidentally let the two drift by editing
  the wrong file and forgetting the other — there's a single `generate` step to run.
- This is good news for a future Go component: the "BOUNDARY" contract flagged in
  P1-01 already has a working single-source-of-truth precedent in this codebase. A
  Go implementation would most plausibly hand-port `model.ts`'s parsing rules once
  (Go can't run the TS generator), then be verified against the same fixtures /
  differential tests the TS↔TS generation implicitly trusts today. That hand-port,
  once done, becomes the thing that must be kept honest — exactly the kind of
  contract a differential test suite (mentioned in P1-01) is for.

### A2. Record shapes and validation strictness (from `src/mailbox/model.ts`)

Eight record kinds share one discriminated union (`MailboxRecordKind`): `inbound`,
`outbound`, `processingAck`, `delivery`, `destination`, `sessionRouting`, `state`,
`container`. Every parser (`parseInboundRecord`, `parseOutboundRecord`, etc.) runs
through `strictRecord()`, which rejects unknown fields and any nested object outright
— a message with an extra key or an object-shaped value where a primitive is
expected throws before the record is ever used. Notable specifics:

- `InboundKind` is a closed enum: `'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'`
  — the same five values seen directly in the P1-02 trace's ordinary "hi" message
  (`chat`) and in this task's traced privileged action (`system`).
- Timestamps are validated as exact `Date.prototype.toISOString()` round-trips
  (`parseIsoTimestamp`), not just "parses as a date" — a timestamp with a different
  string representation of the same instant is rejected.
- `OutboundWrite`/`OutboundRecord`'s `kind` field is a **plain `string`**, not a
  closed enum like inbound's — this is deliberate: outbound kinds include
  `chat`, `system`, `task_log`, and whatever else a module registers, and the model
  layer doesn't try to enumerate every possible outbound kind up front. The
  strictness lives one layer down instead (see A3).

### A3. A second, looser contract layer sits inside `content` for `kind: 'system'`

`mailbox/model.ts`'s strict parsing covers the outer envelope (id, kind, timestamp,
routing fields, and that `content` is a string) — it does **not** look inside
`content`. For `kind: 'system'` outbound messages specifically, `content` is
expected to be a JSON object with an `action` field (`{action: 'install_packages', apt, npm, reason}`,
confirmed directly in this task's trace), and `delivery.ts`'s `handleSystemAction`
dispatches purely on that string via the delivery-action registry
(`getDeliveryAction(action)`). Nothing in the mailbox model validates what fields a
given `action` requires — that validation is ad hoc, per module (e.g., self-mod's
`validateInstallPackages`/`validateAddMcpServer`). So the real host/container
contract has two strictness levels: **tight and centrally enforced** at the
envelope (mailbox/model.ts), **loose and per-action** inside a system message's
payload. A Go kernel that ever wants to validate system actions itself would need
to either re-implement each action's payload contract individually, or accept that
this layer stays TypeScript's job (consistent with LAW-01/LAW-02 — these are
exactly the kind of extensible, module-defined action shapes that shouldn't be
frozen into a compiled kernel).

### A4. The session-context handoff (host → container, out-of-band from both DBs)

`container/agent-runner/src/mailbox/index.ts`'s `readMailboxContext()` reads
`/app/.nanoclaw-session.json`, a file the host materializes for the container (not
one of the two SQLite files). Its contract: if the file is missing or unreadable,
the container logs and treats itself as talking to a "pre-seam host" (graceful
degradation, not a crash) — but if the file **exists and parses**, it must have a
non-empty string `agentGroupId`, a non-empty string `sessionId`, and a `mailbox` key
present, or the container throws `Invalid NanoClaw session context` and presumably
fails to start cleanly. This is a small, sharply-typed contract worth keeping in
mind for Phase 3: it's currently the one piece of host→container configuration
transfer that isn't mediated by either mailbox database.

## Part B — the guard/approval authorization contract

### B1. What `guard()` actually enforces, and what it delegates

Recapping the mechanism read directly from `src/guard/guard.ts` and
`src/guard/guard-actions.ts` (see the "key purpose of guard()" discussion for the
full walkthrough): `guard()` enforces three things itself, universally, for every
consult — (1) only a value minted by `defineGuardedAction` can be consulted at all
(compile-time wiring, runtime brand check as backstop); (2) a `decide()` that
throws denies rather than crashing or defaulting to allow; (3) on a `hold` decision
with a `grant` attached, the grant only succeeds if `grant.action` matches the
action's declared `grantActionName` **and** a live `pending_approvals` row still
exists for that grant (resolution deletes the row, so a grant executes at most
once). Everything else — whether the *specific* payload being executed now is the
*specific* thing that was approved — is left to an optional, per-action
`grantCoversRequest(grant, input)` function. This is the exact question the
second-opinion review's "Verified Action Envelope" idea was pointing at, and the
one flagged in the project doc as needing an audit. Having now read every
`grantCoversRequest` implementation in the codebase (`agent-to-agent/guard.ts`,
`permissions/guard.ts`) alongside the two that deliberately omit it
(`self-mod/guard.ts`), the picture is more nuanced — and more reassuring — than "some
actions check, some don't."

### B2. Four distinct binding shapes exist in the current catalog

**1. Structural binding only — no `grantCoversRequest` (self-mod: `install_packages`, `add_mcp_server`).**
Traced directly (see Part C): the delivery-action registry
(`registerDeliveryAction` + `reenterGuardedDeliveryAction` in `src/delivery.ts`)
guarantees that the payload replayed into `guard()` and into the handler on an
approved continuation is *always* `JSON.parse(approval.payload)` — literally the
JSON blob written into the `pending_approvals` row at request time, the same blob
the admin's card was rendered from. The admin's click itself carries no free-form
data (`payload.value` is one of `approve` / `reject` / `reject_with_reason`,
`payload.questionId` is the approval's own ID) — there is no field an admin's
response could use to substitute a different payload while reusing the same
approval row. So the binding here is enforced by *construction of the call graph*,
not by an explicit equality check: there is exactly one code path from "admin
clicks Approve" to "handler runs," and every step of it is keyed off the same
database row. This is tight, but it is an implicit property of the registry
pattern, not something `guard()` verifies on its own.

**2. Structural binding plus an explicit field check (`agents.create` / `create_agent`).**
`create_agent` is registered through the *exact same* `registerDeliveryAction` /
`reenterGuardedDeliveryAction` pattern as self-mod (confirmed in
`agent-to-agent/index.ts`) — so it already has the same structural guarantee as
case 1. Yet its guard entry *also* defines
`grantCoversRequest: (grant, input) => JSON.parse(grant.payload).name === input.payload.name`.
Given the structural guarantee already rules out payload substitution on this
path, this check is currently redundant — genuinely useful defense-in-depth (it
would catch a future bug that let a different payload reach this consult without
going through the registry), but not load-bearing today. Worth naming as an
inconsistency: two actions with identical replay mechanics, one field-checked and
one not.

**3. Structural binding plus a field check that *is* load-bearing (`a2a.send`).**
Unlike `create_agent`, the held `a2a.send` action is **not** registered via
`registerDeliveryAction` — its approval handler is a bespoke function
(`applyA2aMessageGate` in `message-gate.ts`), registered directly with
`registerApprovalHandler(A2A_MESSAGE_GATE_ACTION, applyA2aMessageGate)`. It
reconstructs a `RoutableAgentMessage` from the stored `payload` and calls
`routeAgentMessage(msg, session, { grant: approval })` itself, which is what
ultimately calls `guard(a2aSend, { resource: { to: platform_id }, grant, ... })`.
The payload is *still* sourced from the stored approval row on this path (so, in
practice, no live bug lets a mismatched message through today) — but the safety
property here rests on "no caller ever passes a *different* live approval object
into a fresh `a2a.send` consult," which is an invariant of how the code happens to
be written, not something the registry enforces the way case 1's does. Every held
`a2a.send` shares one `grantActionName` (`a2a_message_gate`) regardless of sender
or target — so without `grantCoversRequest`'s explicit
`grant.payload.platform_id === input.resource.to` check, *any* live
`a2a_message_gate` row would satisfy the action-name-and-liveness test for *any*
other a2a message currently being held, if it were ever handed that grant. That
never happens today because only `applyA2aMessageGate`'s own replay ever attaches a
grant — but `grantCoversRequest` is the actual thing standing between "that
invariant holds today" and "that invariant must hold forever, in every future code
path." This is the clearest example in the codebase of `grantCoversRequest` doing
real, necessary work rather than redundant defense-in-depth.

**4. No grant concept at all — approval mutates state, then replays the ordinary flow (`senders.admit`).**
Documented directly in the code's own comment: *"the hold is executed by the caller
through the module's own pending_sender_approvals flow... not the approvals
primitive — so this entry has no grantActionName: the approve continuation adds the
member and replays routeInbound, which then passes the gate structurally via
membership, no grant needed."* There is no token to bind at all here; approval
durably changes the world (adds a member) and the *next* ordinary pass through the
decision naturally allows, because the actor is now a member. Nothing to audit for
tightness because there's no replay-with-a-grant step in this shape.

**5. No hold/grant lifecycle at all — live click authorization (`channels.register`).**
Consulted synchronously, inline, by the card-click response handler itself, using
the clicking user's live identity against the pending row's named approver or
agent-group admin role. There is no "approved, now replay later" step to bind —
the decision and the authorization check are the same event.

### B3. Direct answer to the audit question

*How tight is the grant-to-request binding, where it exists?* Shallow but
proportionate: every real `grantCoversRequest` implementation is a single-field
equality check (`name`, or `platform_id`) between the stored grant's JSON payload
and the field of the live request that actually matters for that action's replay
risk — not a full-payload hash or deep-equality comparison (the "Verified Action
Envelope" idea, taken literally, would hash/compare the *entire* approved action).
In practice this is fine for the two cases that use it: `create_agent`'s only
attacker-relevant field is the name being created, and `a2a.send`'s only
attacker-relevant field is the destination. But it is a deliberately narrow,
per-action judgment call each time, not a generic mechanism. A future guarded
action with more than one attacker-relevant field in its payload would need its own
`grantCoversRequest` to think through which fields actually need binding, and
nothing in `guard-actions.ts` forces that thinking to happen. There's no lint or
type-level requirement that a `grantActionName`-bearing action also define
`grantCoversRequest`; case 1 above shows an action can validly and safely omit it,
so its absence elsewhere can't be treated as a code smell by itself. It has to be
reasoned about per action, the way this audit just did for five of them.

## Part C — one privileged action traced end to end: `install_packages`

Mirrors `docs/message-flow.md`'s format: numbered steps, each annotated with which
process holds real-world authority at that step. Self-mod's `install_packages` was
chosen because it ends in two genuinely irreversible, costly OS-level effects
(rebuilding a Docker image, killing a live container) gated behind a human
approval — the sharpest possible contrast with P1-02's zero-checkpoint ordinary
path.

1. **[Container, untrusted]** The agent calls the `install_packages` MCP tool
   (container-side tool source not re-read this pass — out of scope, see below;
   behavior per the module's own docs). The tool writes an outbound `kind: 'system'`
   message with `content: {action: 'install_packages', apt, npm, reason}` into
   `outbound.db`. No real effect yet — this is exactly as unprivileged as any other
   container write.
2. **[Host, TypeScript, no effect]** `delivery.ts`'s poll loop reads the row,
   `deliverMessage()` sees `kind === 'system'`, calls `handleSystemAction`, which
   resolves `install_packages` via the delivery-action registry to the guard-wrapped
   entry point.
3. **[Host, TypeScript, decision only]** `runGuarded` runs the precheck
   (`validateInstallPackages` — package name/count/regex validation; a malformed
   request is answered and stops here, no card ever created) and then consults
   `guard(selfModInstallPackages, { actor: {kind:'agent', ...}, payload: content, grant: null })`.
4. **[Host, TypeScript, decision only]** `selfModInstallPackages.decide()` checks
   the session driver's `imageBuild` capability first (a runtime that can't rebuild
   images is denied outright, before any human is ever asked) and otherwise returns
   an unconditional `HOLD` — every container-originated install request holds for
   admin approval, with no allow-without-approval path from this actor kind.
5. **[Host, TypeScript, real effect: a human is asked]** The hold routes to
   `requestInstallPackagesHold` → `approvals.requestApproval()`, which picks an
   eligible approver (agent-group admin → global admin → owner), delivers an
   interactive card to their DM, and writes the `pending_approvals` row with
   `payload = JSON.stringify({apt, npm, reason})` — verbatim what the agent sent in
   step 1.
6. **[Human admin, real authority]** The admin reviews the rendered card (built
   directly from that same payload) and clicks Approve, Reject, or "Reject with
   reason."
7. **[Host, TypeScript, authorization check]** `isAuthorizedApprovalClick` verifies
   the clicking identity is actually entitled to resolve *this* row (a named
   approver, or an admin/global-admin/owner for its agent group) — an unauthorized
   click is logged and dropped, never reaching the handler.
8. **[Host, TypeScript, real effect: DB state change]** On Approve,
   `transitionPendingApprovalStatus('pending' → 'approved')` flips the row, and the
   payload the handler will use is read back with `JSON.parse(approval.payload)` —
   from the DB row, never from anything the click carried.
9. **[Host, TypeScript, decision replay]** The registered approval handler
   (`reenterGuardedDeliveryAction('install_packages')`) re-enters `runGuarded` with
   that payload and `grant = approval`. `guard()` re-runs `decide()` fresh (capability
   check, then hold again) and then checks the grant: action name matches, the row
   is still live (status is `approved`, not yet deleted), and — per the B2 audit —
   there is **no** `grantCoversRequest` for this action, so no further field-level
   check runs. The grant satisfies the hold; `guard()` returns `ALLOW`.
10. **[Host, TypeScript, real OS-level effect #1]** `runGuarded` calls
    `applyInstallPackages`: updates the `container_configs` DB row, then calls
    `buildAgentGroupImage(session.agent_group_id)` — an actual container image
    rebuild. This is a plain function call with no gate of its own; by the time
    execution reaches here, the *only* thing that stood between "agent asked" and
    "image rebuilds" was steps 4-9 above.
11. **[Host, TypeScript, real OS-level effect #2]** On success, `killContainer`
    stops the running container, and its completion callback calls `wakeContainer`
    on the next message — **the identical unchecked container-spawn call
    identified in P1-02**, now reached from a second, independent entry point.
12. **[Host, TypeScript, real effect: message queued]** A follow-up chat message
    is queued (`onWake: true`) telling the freshly-restarted agent to verify the
    install and report back to the user.
13. **Cleanup.** `deletePendingApproval` removes the row (this exact approval can
    never be replayed again — one-shot, per the guard's own contract),
    `notifyApprovalResolved` fires any registered observers, and the container
    wakes to continue the conversation.

**Deliberately out of scope for this pass** (consistent with P1-02's practice of
naming gaps rather than silently skipping them): the container-side `install_packages`
MCP tool's own source; `buildAgentGroupImage`'s internals (the actual Docker build
invocation); the host-sweep ghost-finalization path for "Reject with reason" holds
that never get a follow-up reply.

### What this trace confirms, beyond P1-02

The headline finding is genuinely reassuring: every consequential effect in this
whole flow — carding a human, rebuilding an image, killing and respawning a
container — happens strictly *after* a human's authorized click, unlike the
ordinary chat path's unconditional container spawn. Self-mod is exactly the kind of
control LAW-04 ("every security control needs low-friction UX") and LAW-07 want:
friction exists, but only where the risk actually is.

But steps 10-11 also sharpen the P1-02 / second-opinion finding rather than
resolving it: once a request is `ALLOW`ed, the code that executes the effect
(`buildAgentGroupImage`, `killContainer`, `wakeContainer`) is the *same* plain,
ungated TypeScript function call P1-02 already flagged for the ordinary path. The
human-approval gate here is entirely a property of *who calls* `applyInstallPackages`
today (only the registered approval handler does) — nothing stops a future module,
or a bug in an unrelated one, from importing `buildAgentGroupImage` or
`killContainer` directly and calling it without ever touching `guard()`. In other
words: `guard()` and the approvals primitive make the *decision* layer excellent —
but the *execution* layer (the actual Docker-facing functions in
`container-runner.ts`) still has no boundary of its own. This is a
second, independent concrete example of exactly the "decision vs. execution
authority" gap the second-opinion review raised and P1-02 first evidenced at the
container-spawn site — now shown to apply to image-build and container-kill as
well, all of which live behind the same unguarded `container-runner.ts` surface.

## What this means for Phase 3 (non-committal, for P1-04/design later)

The "must move behind Go to be exclusively enforced" boundary is broader than P1-02
alone suggested. It isn't just "container spawn on the ordinary path." It's every
call site that can reach `container-runner.ts`'s Docker-facing functions
(`wakeContainer`, `buildAgentGroupImage`, `killContainer`), of which this task found
at least two independent ones (ordinary wake, self-mod's approved-install path), with
more likely elsewhere. That wasn't surveyed this pass — a good candidate for P1-04's
threat model to enumerate exhaustively. A Go kernel that took over only the ordinary
spawn path would leave the self-mod path's image-build/kill calls just as
unguarded as they are today. This doesn't change the conclusion that session/runtime
admission is the right *first* milestone — it just means "session/runtime admission"
should be scoped as "every path to the Docker-facing surface," not "the one path P1-02
happened to trace."

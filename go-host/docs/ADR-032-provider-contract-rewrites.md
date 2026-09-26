# ADR-032: Provider host-contract and runtime-contract rewrites

Status: host-side (C14) decided and implemented 2026-09-26, by the
`docs/promotion-v2.4.0.md` scope-policy decision ("the scope bar is
'genuinely part of v2.4.0,' not 'small enough to be convenient'").
Container-side (C15) decided 2026-09-26, by direct founder direction;
mechanism implemented and committed 2026-09-26 (`7af29867`), deliberately
narrower than upstream's full diff — see the C15 decision below. Adds
Workstream C tasks C14/C15.

## Background

Workstream B's `container-runner.ts` seam-audit pass found upstream v2.4.0
replaced the old `providerProvidesAgentSurfaces`/`ProviderContainerContribution
.mounts` callback pattern with a declarative, data-only `ProviderHostContract`
— every provider's mount/file surface (state volumes, skill-backing
directories, prepared settings files, the composed project document)
declared as data instead of built imperatively per provider. This was
initially treated as out of scope, on the reasoning that it was large and
orthogonal to the gateway/Iron-Proxy work this promotion was already
scoped around.

That reasoning was corrected by the scope-policy decision recorded in
`docs/promotion-v2.4.0.md`'s Non-goals section: size and complexity govern
*how carefully* a piece is ported, not whether a genuinely-shipped v2.4.0
feature gets left out. A dedicated deep-scope pass then found the rewrite
is real but tractable — confirmed directly against `drivers/types.ts` that
it reopens **zero** Go-kernel work, since the contract only changes *how*
the `VolumeMount[]`/`MountSpec[]` array is built, never what `mountClass`
values it can carry.

A second, textually similar abstraction was found later in the same pass:
`container/agent-runner/src/provider-contracts/` — a Bun-side
`ProviderRuntimeContract` covering execution policy, inference-tier
mapping, memory-hook registration, and command text-formatting. This is a
**genuinely separate mechanism** from the host-side one — different file
tree, different runtime (Bun vs. Node), different purpose (runtime
behavior vs. mount/file composition) — sharing only a directory-naming
convention and a "declare instead of imperative" philosophy. The founder
confirmed direct adoption of this piece too, after independently verifying
the premise that made it low-risk: every current Isthmus file under
`container/agent-runner/src/providers/` is byte-identical to the pinned
`v2.3.0` baseline, so there is no Isthmus-specific behavior a port would
overwrite — unlike the host side, where real divergence (the `PreCompact`
hook) had to be preserved deliberately.

## Why this is in scope for this promotion specifically

Same reasoning as ADR-031: this plan's Goal section commits to adopting
new upstream features, not just absorbing them passively, and both
rewrites are real, shipped, tested parts of nanocoai/nanoclaw's own
v2.4.0 — not speculative scope invented for this promotion.

## Checked against the nine design laws

- **LAW-01/LAW-02** (no Go for ordinary customization) — fully compliant
  for both halves. Confirmed directly against `drivers/types.ts`: the
  host-side contract's mount classes are byte-identical to the pre-
  existing `'group-state' | 'install-surface' | 'identity-material' |
  'gateway-trust' | 'allowlisted-extra'` union — no new kernel-admitted
  shape, no new privileged surface. The container-side contract touches
  nothing kernel-adjacent at all; it is pure Bun-process configuration
  and formatting logic.
- **LAW-03** (compatibility before feature growth) — passes: this is
  upstream's own already-built, already-tested v2.4.0 mechanism, the same
  posture as every other Workstream C adoption in this promotion.
- **LAW-05** (every component must justify itself) — real cost, named
  rather than minimized: the host-side rewrite touched the single
  highest-blast-radius file in this promotion (`buildMounts`, which
  composes every live container's mount set); the container-side one
  touches the live conversation/inference loop (`poll-loop.ts`). Justified
  by the same reasoning as LAW-03 — this is upstream's actual v2.4.0
  design, not invented complexity, and declining it would mean Isthmus's
  provider-composition model silently diverges from upstream's own going
  forward.
- **LAW-06** (contracts before rewrites) — the concrete engineering
  discipline both halves were held to. Host side: every existing
  `buildMounts('claude', ...)` test (63 across five files) was run before
  and after the rewrite and required to pass byte-for-byte unmodified,
  proving Claude's composed mount set is unaffected until its contract
  is deliberately given a real mount surface. Container side: not yet
  executed, but the same discipline is the explicit plan — characterize
  `claude.ts`'s current externally-observable behavior with tests before
  applying upstream's diff, the same as every other rewrite this
  promotion has done.
- **LAW-07** (mechanism in Go; experience in flexible layer) — both stay
  entirely in the flexible layer. Neither contract composes or resolves
  anything the Go kernel wasn't already going to see in the same shape.
- **LAW-08** (no weaker security than upstream) — the specific obligation
  this rewrite created, and the reason it was not treated as a
  mechanical port: Isthmus's shipped C8 registration
  (`provider-contracts/claude.ts`, host side) declares only model-domain
  data, no mount surface — using upstream's own truthy-`contract` check
  as the switch between legacy and contract-driven mount composition
  would have routed Claude through the new path with an *empty* surface
  the moment the widened registry landed, silently dropping its
  `.claude` home-directory mount, composed `CLAUDE.md`, and skill
  symlinks, before Claude's own real contract even existed. Closed by
  gating every such branch on `hasProviderMountSurface(provider)`
  (`projectDocument !== undefined`) instead of contract presence —
  documented in `provider-contracts/registry.ts`'s own header as a
  deliberate divergence from upstream, not an oversight. A second,
  narrower LAW-08-shaped finding on the container side: upstream's own
  container-side Claude contract categorizes `/remote-control` as an
  admin command, while Isthmus's `formatter.ts` and the host-side
  contract both categorize it as filtered — `formatter.commandLists
  .test.ts`'s own header names this exact command as one that had
  already silently diverged in this fork's history. The field is
  currently inert (nothing reads `contract.commands` for real behavior
  yet, on either side), so this is not a live bug, but a verbatim port
  would plant a self-contradictory value; the recommendation when C15
  is implemented is to correct it to match Isthmus's already-tested
  categorization, not adopt upstream's value blind.
- **LAW-09** (upstream moves independently) — favors adoption for the same
  reason as ADR-031: porting upstream's actual mechanism keeps the two
  lineages aligned, rather than Isthmus inventing or maintaining a
  parallel provider-composition model.

No law is violated by adopting either half. LAW-05's cost is real and
named; LAW-06 and LAW-08 name concrete obligations the implementation
work itself must satisfy — satisfied in full for the host side (C14,
done), still owed for the container side (C15, scoped).

## Decision

Adopt both rewrites, as two Workstream C tasks:

**C14 (done) — Host-side provider-host-contract mount-composition
rewrite.** Widen `provider-contracts/registry.ts` from Workstream C8's
narrow model-domain-only slice to the full `ProviderHostContract` shape
(with the `hasProviderMountSurface()` divergence above); add
`file-transformers.ts`/`realize.ts`; extend `project-doc-compose.ts` with
the provider-instruction-facts layer; rewrite `container-runner.ts`'s
`buildMounts`/`resolveProviderContribution` to consume a declared
contract; register Claude's real contract (preserving Isthmus's own
`DEFAULT_SETTINGS_JSON` content, not upstream's `CLAUDE_DEFAULT_SETTINGS`
— a second deliberate divergence, since upstream's default settings lack
the `PreCompact` hook and auto-memory/directories env vars this fork
already depends on); reconcile `group-init.ts`/`command-gate.ts`. All six
steps implemented, tested (176 tests spanning mount composition, group
provisioning, and command gating, run against Claude's real contract
doing the actual work — not a separate parity harness), and committed in
`feat/gateway-provider-seam` (commits `defa4d29`, `03e884a9`, `56e60edc`,
`26b0ae30`, `a5bcbcff`).

**C15 (mechanism implemented, `poll-loop.ts` deliberately excluded) —
Container-side provider-runtime-contract port.** Ported
`container/agent-runner/src/provider-contracts/*` (new directory:
`registry.ts`, `realize.ts`, `claude.ts`, `mock.ts`, `names.ts`,
`verifier.ts`, `index.ts`) and reconciled
`container/agent-runner/src/providers/{claude,provider-registry,types,
factory,mock}.ts` against it, plus two new files (`claude-history.ts`,
`claude-config.ts`) extracted from the old monolithic `claude.ts`.
Committed `feat/gateway-provider-seam` @ `7af29867` (23 files,
+1505/−403). Full container-side suite: 343 pass, 1 skip, 0 fail; clean
`bun run typecheck`; clean `eslint`.

Scoping found the honest blast radius included `poll-loop.ts` (the actual
message-processing core loop reads
`AgentProvider.supportsNativeSlashCommands`/`.emitsMidTurnText` in 10+
call sites) and `index.ts`. `index.ts` was reconciled (barrel import,
`requireProviderName`, `registerProviderMemorySessionHook`).
**`poll-loop.ts` was deliberately excluded from this pass**: its real
v2.3.0→v2.4.0 diff (327 changed lines, confirmed via `git diff v2.3.0..v2.4.0`
against the actual tags, not assumed) bundles the
`supportsNativeSlashCommands`/`emitsMidTurnText`→contract migration
together with an unrelated, substantial multi-turn reply-routing rewrite
(new `queuedTurns`/`adoptTurn`/`pushRetry` mechanism, `setCurrentInReplyTo`
→`setCurrentReplyRoute` rename, `AbortSignal` cancellation,
`db/session-routing.ts` +44 lines, `db/session-state.ts` +71 lines) — the
same bundled-concerns pattern Workstream B already found in
`container-runner.ts` (gateway-session-lifecycle + durable-host-shadow-
writes + provider-host-contract mixed in one diff). Separating a genuine
feature rewrite from a mechanical contract-adoption diff under time
pressure risks either a rushed, under-tested surgical split or silently
absorbing unrelated scope creep; neither serves LAW-06. **Resolution**:
`AgentProvider.supportsNativeSlashCommands`/`.emitsMidTurnText` stay
instance fields on `providers/types.ts`, diverging from upstream's
migration. `poll-loop.ts` needs zero changes as a result. The contract
still declares `commands.formatting`/`textDelivery` (verifier-checked for
correct shape) but nothing consumes them yet — the same "declared but
unconsumed" staging this promotion already used for host-side `inference`
ahead of C14 Step 5. The reply-routing rewrite itself is **not** adopted
and **not** dropped — tracked as its own separate, not-yet-scoped
follow-on item in `docs/promotion-v2.4.0.md`.

Also confirmed and applied during the port, both verified against the
real tags directly (LAW-01/LAW-06, not assumed): `providers/claude-config.ts`
keeps `'TaskOutput'` in `TOOL_ALLOWLIST` (upstream's v2.4.0 drops it with
zero occurrences anywhere in the v2.4.0 container tree and no evidence of
a deliberate removal, while it's been present since this fork's first
commit); `provider-contracts/claude.ts` corrects `/remote-control` to
`nativeFiltered`, matching Isthmus's own already-tested categorization
instead of upstream's `nativeAdmin` (the recommendation from this ADR's
original scoping pass, now applied). Both fields are currently inert on
the container side (nothing consumes `contract.commands` for real
behavior yet), so this is a correctness-of-declared-value fix, not a
behavior change today.

One further deliberate deferral, not part of the mechanism port itself:
upstream's v2.4.0 also fixes a real bug in `claude.ts`'s `systemPrompt`
construction (`snapshot: false` on the preset option — without it, a
resumed session keeps a stale system-prompt append, old agent name and
destinations, until compaction). Applying it requires bumping
`@anthropic-ai/claude-agent-sdk` from Isthmus's current `^0.3.238`
(matching the v2.3.0-era pin) to upstream's `^0.3.280` — a supply-chain
decision CLAUDE.md's "Container Runtime (Bun)" section reserves for its
own deliberate pass (check the npm release date, pin deliberately, never
`bun update` blindly), not folded into this rewrite. The bug remains
present; the fix is deferred, not declined, and tracked as its own
follow-on item.

## Consequences

- `docs/promotion-v2.4.0.md` Workstream C: C14's row marked done with full
  step-by-step evidence; C15's row marked done for the mechanism port
  (commit `7af29867`), with the `poll-loop.ts` reply-routing rewrite and
  the SDK version bump both carried forward as their own explicit,
  not-yet-scoped follow-on items rather than being silently absorbed or
  dropped.
- Workstream B's own `container-runner.ts` row (which originally flagged
  this exact rewrite as needing its own architectural decision) is
  resolved by C14; its other named concern, gateway-session-lifecycle
  wrapping, remains a genuinely separate, still-open item.
- Workstream D's file inventory: rows under `src/provider-contracts/`,
  `container/agent-runner/src/provider-contracts/`, and every touched
  provider file need reclassification once C15 lands, the same pattern
  ADR-031's C10/C11 produced for `src/community-portal/`.
- A real regression was found and fixed as a direct consequence of C14
  landing: `container/agent-runner/src/formatter.commandLists.test.ts`'s
  drift guard parsed `command-gate.ts`'s source text expecting one
  literal `Set([...])` per constant; C14 step 6 made those sets
  contract-derived, breaking the guard's regex. Fixed in commit
  `52cfcc31` by teaching the guard to reconstruct the expected sets from
  both `command-gate.ts`'s remaining literals and each registered
  provider contract's own declaration — verified via the full
  container-side suite (343 pass, 1 skip, 0 fail) and a mutation test.
  This is exactly the kind of dual-runtime drift this promotion's own
  "what 'green' means" testing policy exists to catch, and closing it
  required actually running the Bun suite rather than trusting the
  Node-side green alone.

## What would change this

For C15 specifically: if a future audit finds the container-side
`providers/claude.ts` has in fact diverged from the `v2.3.0` baseline
since this ADR's background section was written (i.e., some other change
landed on top of it before C15 is implemented), the "nothing Isthmus-
specific to reconcile" premise would need rechecking — the plan above
assumes byte-identical-to-baseline, verified at the time of this ADR, not
a standing invariant.

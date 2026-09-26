# ADR-032: Provider host-contract and runtime-contract rewrites

Status: host-side (C14) decided and implemented 2026-09-26, by the
`docs/promotion-v2.4.0.md` scope-policy decision ("the scope bar is
'genuinely part of v2.4.0,' not 'small enough to be convenient'").
Container-side (C15) decided 2026-09-26, by direct founder direction;
scoped, not yet implemented. Adds Workstream C tasks C14/C15.

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

**C15 (scoped, not implemented) — Container-side provider-runtime-contract
port.** Port `container/agent-runner/src/provider-contracts/*` (a new
directory: `registry.ts`, `realize.ts`, `claude.ts`, `mock.ts`, `names.ts`,
`verifier.ts`, `index.ts`) and reconcile
`container/agent-runner/src/providers/{claude,provider-registry,types,
factory}.ts` against it, plus two new files (`claude-history.ts`,
`claude-config.ts`) and, found during scoping — not part of the original
estimate — `poll-loop.ts` and `index.ts`, which read the
`AgentProvider.supportsNativeSlashCommands`/`.emitsMidTurnText` instance
booleans this rewrite replaces with contract fields
(`commands.formatting`/`textDelivery`). Sequenced to follow C14 rather
than run concurrently, since both touch provider-registration surfaces.
Plan: characterize `claude.ts`'s (currently 691 lines) externally-
observable behavior with tests first (LAW-06 — this is the file that runs
every live Claude conversation turn), confirmed testable in this sandbox
(`bun install && bun run typecheck && bun test` all work), then apply
upstream's diff, correcting the `/remote-control` categorization along the
way, then verify byte-for-byte behavioral parity before calling it done.

## Consequences

- `docs/promotion-v2.4.0.md` Workstream C: C14's row marked done with full
  step-by-step evidence; C15's row carries the deep-scope findings above
  and is the current recommended next resumption point for this
  promotion's remaining implementation work.
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

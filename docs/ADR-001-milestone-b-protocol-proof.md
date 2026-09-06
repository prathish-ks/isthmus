# ADR-001: Milestone B (Protocol Proof) — Continue

**Status**: Accepted, 2026-09-01
**Task**: P3-07 (closes Phase 3 — Minimal Go Host, Milestone B)
**Depends on**: P3-01 through P3-06

## Context

The workbook's own framing for Milestone B is explicit: test architecture viability within ~40-50 hours, before the expensive rewrite work (Phase 4 onward) accumulates sunk cost. Concretely, the question this ADR answers is whether an independent Go process can speak NanoClaw's real host↔container protocol well enough — without modifying, forking, or special-casing the agent-runner — to justify continuing to build a Go kernel on top of that seam.

P3-01 through P3-06 delivered that proof incrementally: an isolated Go module (P3-01), a minimal one-user config loader (P3-02), an inbound mailbox writer hand-ported from the real schema and validation rules (P3-03), a real launch of the unmodified agent-runner container against a Go-written session (P3-04), an outbound mailbox reader completing the round trip (P3-05), and a fully automated, repeated, deterministic end-to-end proof with a substituted fake provider (P3-06). This ADR reviews that body of work against the project's own governing documents — `docs/design-laws.md` and `docs/host-decomposition.md` — and records an explicit Continue/Redesign/Stop decision, per the task's own instruction not to implement further until that decision is made explicit.

**A scoping note on sources.** The master-plan workbook itself (`NanoClaw_Go_Host_Project_Master_Plan_UPDATED.xlsx`, including its "Preservation Matrix" sheet) lives outside the git repository and was not re-opened this session. That is not a gap in this review: `docs/design-laws.md` and `docs/host-decomposition.md` are exactly the documents Phase 1 (P1-01/P1-05) produced to carry that workbook's operative substance into the repo as a durable, checkable record — LAW-01/LAW-02/LAW-05/LAW-06/LAW-09 and the host-decomposition classification map are what this review actually checks the Go work against, and no conflict with either was found. If a future review wants to check something specific to the workbook's own Preservation Matrix wording, that requires the file to be re-shared into a session — nothing in that sheet was contradicted here, but nothing in it was independently re-derived either.

## Decision drivers

The task defines four axes to compare: complexity, coupling, required agent changes, and hidden dependencies. Each is evidenced below against the actual delivered code and the real-Docker verification runs (sandbox-first, then confirmed by the user on the real Mac, then run against real Docker three separate times at P3-04/P3-06).

## Evidence

### 1. Complexity

The entire protocol-proof surface is small and cleanly separated:

| Package | Source | Tests |
|---|---|---|
| `cmd/nanogo` (CLI wiring) | 7.2 KB | — (thin wrapper, not unit-tested directly, matching the project's existing style) |
| `internal/config` | 2.5 KB | 2.6 KB |
| `internal/hostinfo` | 0.9 KB | 0.3 KB |
| `internal/mailbox` (inbound + outbound) | 23.9 KB | 16.9 KB |
| **Total (non-vendor)** | **~34 KB** | **~20 KB** |

25 tests, all passing, in both the cloud sandbox and on the real Mac, across every task from P3-01 onward — no regressions introduced by any later task. One external dependency, `modernc.org/sqlite` (pure Go, no CGO, vendored in full so no future build needs the Go module proxy), which is the minimum unavoidable to read/write the real mailbox SQLite files at all — this satisfies LAW-05's "every component must justify itself" bar rather than being an unexamined addition. No framework, no RPC library, no daemon.

### 2. Coupling

The host↔container boundary is, and remains, exactly what P1-02's message-flow trace found before any Go code existed: two SQLite files on disk (`inbound.db`, `outbound.db`), no IPC, no socket, no RPC. Building the Go side against this did not require inventing a new coupling mechanism — it required transcribing an existing one, verbatim, field-for-field, from `src/mailbox/sqlite/schema.ts` and `src/mailbox/model.ts`. `docs/host-decomposition.md` classified exactly this material (`mailbox/model.ts`, #12; `types.ts`/`db/schema.ts`, #14) as **BOUNDARY** — a shared contract owned by neither side, to be transcribed and differentially tested, not redesigned — and that is precisely what P3-03/P3-05 did. Nothing found during P3-01 through P3-06 changes that classification or reveals coupling tighter than "two processes agreeing on a file format."

### 3. Required agent-runner changes

Zero, established twice, each time more strongly than the last:

- **P3-04** proved the real, completely unmodified agent-runner container consumes a Go-written inbound session and produces a real reply through the genuine Claude Agent SDK integration — no source file under `container/agent-runner/` was touched.
- **P3-06** went further: it proved a *different, deterministic, non-Claude* provider could be substituted into that same unmodified container — via an external bind-mounted script and a `bun -e` dynamic-import chain loaded before the real entry point runs — again with zero edits to any file under `/app/src`. This is a stronger result than P3-04 needed to establish: it shows the substitution mechanism this project leans on (external mount + load-order trick, exploiting `providers/provider-registry.ts`'s open self-registration API) generalizes from "read a message I wrote" to "swap the logic that answers it," entirely from outside the image.

Both results are direct, positive evidence for LAW-01/LAW-02 ("ordinary customization must never require touching Go" — and, by the same coin, a Go host must never require touching the agent-runner to be exercised against it). This isn't an assumption holding up so far; it's now been tested against a real container under two different scenarios.

### 4. Hidden dependencies

Four were found, all discoverable only by reading real source or running against real Docker — consistent with this project's established pattern that infrastructure-level facts, unlike Go logic itself, tend to surface only at execution. All four are now resolved or explicitly documented; none required changing the wire format itself.

1. **`outbound.db` is not self-initializing** (found at P3-04). The container's own `connection.ts` assumes `messages_out`/`processing_ack` already exist; the real host creates them at session-creation time via `session-db.ts`'s `ensureSchema('outbound')`. Closed by `mailbox.OpenForSetup` (P3-05) and its CLI surface, `-prepare-outbound` (P3-06) — no more hand-written `sqlite3` schema pre-creation, as P3-04's harness originally had to do.
2. **The host-writes-even / container-writes-odd sequence-number invariant** (found at P3-03, reading `session-db.ts`'s `nextEvenSeq`). This is nowhere written down as a formal contract in NanoClaw's own docs; it is an emergent property of how the two sides allocate `seq` independently without coordination. Now captured as `internal/mailbox.nextEvenSeq` and pinned by a dedicated regression test (`TestDueOutboundReturnsDeterministicSingleReply`) reproducing P3-04's exact real result.
3. **Provider selection is not a first-class, externally-configurable extension point today** (found at P3-06). `providers/index.ts`'s self-registration barrel wires up only the real Claude provider in a shipped container; the shipped `MockProvider` exists but is never registered in production, and even if it were, its registration lambda drops the constructor arguments needed to customize its behavior. P3-06 worked around this from outside (bind-mount + dynamic import) rather than exposing a gap in the Go design — but it's worth flagging forward: if a future Go host ever wants to select or influence which provider runs as part of its own decision logic, today's TypeScript side would need a real extension point for that, which does not currently exist. This is a fact about the existing ecosystem, not a defect in the protocol proof.
4. **The destination-free error-delivery path is the only way to get a reply without also building routing/destinations** (found at P3-06, in `poll-loop.ts`'s `deliverErrorResult`). P3-06's proof is therefore scoped precisely to the mailbox *wire format* — it does not exercise, and cannot yet stand in for, the full destination-routed delivery contract a real production reply normally goes through. This is the single most important scope boundary of this milestone, and is called out explicitly in the next section so it is not mistaken for more than it is.

## What this milestone does not prove

Consistent with this project's standing practice of not overclaiming (see the Product-perspective review and Release-readiness sections of the main assessment doc), it matters to be precise about what P3-01 through P3-06 did *not* attempt:

- **Container spawn from Go.** `scripts/p3-04-launch.sh` and `scripts/p3-06-e2e.sh` hand-mirror the real host's `docker create` argv and mount list in shell; neither is a Go implementation of `wakeContainer`/`composeSessionSpec`. `docs/design-laws.md`'s LAW-07 annotation already designates this as real Go-kernel work for "a later, more careful phase" — this ADR does not change that; it confirms the deferral was correct, not that the work is now easy.
- **`guard()`'s decision logic, mount-security, egress-lockdown.** None of these have been touched in Go. `docs/host-decomposition.md` classifies the highest-value remaining target — `container-runner.ts`'s spec/mount composition — as **UNDECIDED, leaning GO KERNEL**, with an explicit risk note: *"very high if attempted early... any gap introduced during a port is a sandbox escape, not a bug."* Nothing in this milestone's evidence argues for rushing that work; if anything, the hidden-dependency count found even in the comparatively low-risk mailbox seam (four, across six tasks) argues for treating the higher-risk `container-runner.ts` port with at least as much care, and with the differential-testing discipline Phase 2 already built for exactly this purpose.
- **The full destination-routed delivery contract.** As noted above, P3-06 deliberately used the one delivery path that needs no `destinations` table. Real routing/destinations logic on the Go side remains unbuilt and unverified.

Milestone B's mandate, per the workbook, was to prove the *seam* — not the whole kernel — is viable before further investment. That narrower claim is what the evidence above supports.

## Options considered

**Continue as planned into Phase 4** (session persistence, routing, container lifecycle, delivery/restart-durability parity — starting with P4-01). *Recommended.*

**Redesign the protocol before continuing.** Considered and rejected: no evidence surfaced of a structurally wrong choice in the mailbox wire format itself. All four hidden dependencies found were gaps in documentation or in this project's own test coverage (now closed), not mistakes in the SQLite-files-on-disk design — and that design itself was inherited from NanoClaw's real architecture, not invented by this project, so "redesign" would mean diverging from upstream compatibility (LAW-03/LAW-09) for no evidenced benefit.

**Stop.** Considered and rejected: the specific risk this milestone existed to de-risk — can an independent Go process speak the real protocol without modifying or special-casing the agent-runner — came back unambiguously yes, verified against real Docker on three separate occasions (P3-04's real-auth-error round trip, P3-05's pinned regression test of that exact result, P3-06's fully automated deterministic proof, repeated and matching twice in the user's own confirming run). There is no finding here that would justify abandoning the architecture.

## Decision

**Continue.** The mailbox-protocol seam between a Go process and NanoClaw's real, unmodified TypeScript/Bun ecosystem is clean: low complexity (~34 KB of source, one vendored dependency, no CGO), loose coupling (two SQLite files, no IPC), zero required agent-runner changes (proven twice, including a provider substitution), and a small, fully-resolved set of hidden dependencies, none of which required touching the wire format. This clears Milestone B's go/no-go bar as the workbook defines it.

This decision authorizes proceeding into Phase 4 as already sequenced. It does **not** authorize skipping ahead into Phase 5's security-kernel functions (`guard.ts`, mount-security, egress-lockdown, or `container-runner.ts`'s spawn/mount composition) ahead of that sequencing — those remain gated behind Phase 4's host-parity work exactly as the plan already has them, not implicitly greenlit by this proof. Per `docs/host-decomposition.md`'s own risk notes, those items carry materially higher stakes than anything exercised in Milestone B.

## Consequences

- Phase 3 (Minimal Go Host) is closed. Phase 4 begins with **P4-01 (session persistence primitives)**.
- The differential-testing discipline built in Phase 2 (65 fixtures, `verify-baseline.sh`) and the multi-level verification bar established in Phase 3 (sandbox Go toolchain first, then the user's real Mac, then real Docker where applicable) both carry forward unchanged into Phase 4 — nothing here argues for relaxing either.
- The three open items in "What this milestone does not prove" above are not newly discovered risks; they are the same items `docs/host-decomposition.md` and `docs/design-laws.md` already flagged during Phase 1, now confirmed still open rather than accidentally resolved along the way.
- If a later phase uncovers a structural problem with the mailbox contract itself (not merely a new hidden dependency of the kind found here), that should be recorded in a new, separately dated ADR rather than by editing this one — this document is the record of what was true and decided on 2026-09-01, at the close of Milestone B.

## References

- `docs/design-laws.md` (P1-05) — LAW-01, LAW-02, LAW-05, LAW-06, LAW-07 (and its "exclusive enforcement" annotation), LAW-09.
- `docs/host-decomposition.md` (P1-01) — classifications #4 (`container-runner.ts`), #6 (`host-sweep.ts`), #7 (`guard.ts`), #8 (`egress-lockdown.ts`), #10 (`mount-security`), #12 (`mailbox/model.ts`), #14 (`types.ts`/`db/schema.ts`).
- `docs/message-flow.md` (P1-02), `docs/compatibility-contract.md` (P1-03), `docs/threat-model.md` (P1-04) — the pre-Go-code findings this milestone's evidence is checked against.
- `docs/parity-schema.md`, `docs/test-inventory.md`, `scripts/verify-baseline.sh` (Phase 2) — the differential-testing foundation this milestone's own multi-level verification approach follows the spirit of.
- `docs/baseline.md` — machine/toolchain record, updated through P3-06.
- Commits: P3-01 through P3-05 (see `docs/baseline.md`'s history for exact hashes), P3-06 (`57b36108`), and its gitignore-anchoring follow-up (`8720a0a7`), all on `origin/go-host-experiment`.

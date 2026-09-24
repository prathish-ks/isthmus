# ADR-027: Entering the Feature-Growth Phase — LAW-03 Satisfied, Go-Kernel Migration Continues Alongside TypeScript Growth and Hardening

**Status**: Accepted, 2026-09-24.
**Depends on**: `docs/design-laws.md` (LAW-03, LAW-07, and the "why there is no tenth law" precedent this ADR follows for recording a reading of the laws without editing their text), `go-host/docs/ADR-017-p9-07-upstream-overlap-review.md`, `docs/traceability.md` (companion edit, same day).

## Context

`docs/design-laws.md` was committed 2026-08-30 as task P1-05, sourced from the
project master-plan's "Design Laws" sheet, at the very start of the Go-kernel
decomposition effort — before a single line of `go-host/` existed. LAW-03
("Upstream compatibility before feature growth") reflects that starting
posture: the project didn't yet know whether it could reproduce upstream
NanoClaw's behavior faithfully, so proving that came first and everything
differentiated waited.

That question has since been answered for the surface the kernel currently
covers. Differential parity fixtures (`src/differential/fixtures*.test.ts`)
and `go-host/internal/parity` are established, passing, and required in CI.
`go-host/docs/compatibility-matrix.md` rates multiple contracts "Stable."
Several Go-kernel slices have landed: guard exclusive enforcement, mount
security, egress-lockdown network isolation (most recently re-verified this
session — ADR-024/025/026). The project is no longer at the "can we even do
this" stage LAW-03 was written for.

At the same time, the project's own direction is now explicitly two
concurrent streams, not one sequential one: continue moving privileged
actions into the Go kernel where it's possible to do so *without* breaking
the upstream relationship or ordinary customization (the user's own framing,
2026-09-24) — and grow new TypeScript-side features and harden the
TypeScript layer itself. Read literally, an unqualified LAW-03 would suggest
the second stream is still blocked on finishing the first. It isn't, and
hasn't been for a while; this ADR is the dated record of that, the same way
"why there is no tenth law" in `design-laws.md` records a reading of LAW-07
without editing LAW-07's text.

## Decision

**LAW-03 is satisfied for the currently-decomposed contract surface** — the
set of contracts `compatibility-matrix.md` rates "Stable" — and no longer
reads as a project-wide gate blocking feature growth. It is not retired: any
*new* or *expanded* surface the kernel takes a dependency on (a new contract,
a new consumed upstream shape) still needs parity work before differentiated
behavior is layered on top of it. LAW-03 now applies per-contract, checked
against `compatibility-matrix.md`, rather than as a blanket "no features
yet" rule.

**LAW-07's migration goal remains active and ongoing, not a completed
milestone.** Every new privileged or security-sensitive action introduced by
a new feature — a new mount type, a new credential path, a new externally
reachable command — should still be evaluated against LAW-07's exclusive-
enforcement bar (`design-laws.md`'s annotated reading: physically
un-bypassable through the Go kernel, not merely decided by it), bounded the
same way it always was by LAW-01/LAW-02 (must not require Go for ordinary
customization) and LAW-09 (must not weaken the upstream-independence
promise). Feature growth and continued kernel migration run side by side
from here, not one after the other.

**`docs/traceability.md` is extended, same commit**, with a provenance note
(the nine laws are the Go/TS boundary constitution from the decomposition's
starting phase, not a general project constitution) and a "General
regression safety net" section covering the TypeScript feature-growth and
hardening stream, which LAW-02 deliberately keeps outside the nine laws'
reach — that stream's safety comes from CI/PR hygiene (`test`,
`coverage-gate`, `performance-gate`, `pnpm-audit`/`bun-audit`, PR hygiene),
not from the law table.

## Consequences

- A PR proposing a new TypeScript feature no longer needs to justify itself
  against LAW-03 unless it depends on upstream contract surface
  `compatibility-matrix.md` doesn't yet rate "Stable" — check that matrix
  first, not this ADR, for the current answer.
- A PR introducing any new privileged/security-sensitive action still owes
  the LAW-07 question as a standing review checklist item — "does this need
  Go-kernel enforcement, and if so is it physically un-bypassable" — not a
  phase-gated one that can be deferred until "later, after features."
- `docs/traceability.md`'s provenance note and General regression safety net
  section are the durable, day-to-day record of this decision; this ADR is
  the dated reasoning behind that edit, in case it needs revisiting.
- If a future contract surface expansion turns out to need real parity work
  before it can ship, that is LAW-03 operating exactly as designed at the
  per-contract level — not a reason to reopen this ADR.

## References

- `docs/design-laws.md` — LAW-03, LAW-07 and its annotated "exclusive
  enforcement" reading, and the "why there is no tenth law" precedent this
  ADR follows.
- `go-host/docs/compatibility-matrix.md`, `go-host/docs/version-compatibility.md`
  — what "LAW-03 satisfied" is measured against, going forward.
- `go-host/docs/ADR-017-p9-07-upstream-overlap-review.md` — the review whose
  findings this decision leans on.
- `docs/traceability.md` — companion edit adding the provenance note and the
  General regression safety net section.

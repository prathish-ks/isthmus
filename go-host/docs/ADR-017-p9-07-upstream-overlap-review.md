# ADR-017: Upstream-Overlap Review, 2026-09 — v2.3.0 Baseline Still Current, No New Admission-Checked Feature Work Cleared Yet

Status: accepted, 2026-09-03 (Phase 9, P9-07). Scopes the master plan's "Add
upstream-overlap check before implementing differentiated features... Record
Build / Reuse / Defer / Drop decision" for this Phase 9/10 hardening pass, and
performs the specific follow-up `docs/baseline.md`'s own "Upstream watch"
section flagged: re-checking that `DockerSessionDriver.prepare(spec)` is still
the real chokepoint before assuming the Go kernel's target interface is
unchanged.

## Context

This project's stable baseline (`docs/baseline.md`) is pinned to nanocoai/
nanoclaw `v2.3.0` (commit `54d9d9a5`, released 2026-08-24), deliberately
decoupled from upstream's own ongoing development (LAW-09). That baseline
doc separately records an "upstream watch" data point: `upstream/main` at
`f6cf8dc` (captured 2026-08-29) was already materially ahead of the pinned
tag, and names a specific, credible signal worth re-checking later — a
founder reply (Gavriel Cohen, NanoClaw's official Discord, 2026-08-20)
confirming that a generalized "registries" abstraction for launching agent
containers was actively being merged into NanoClaw core, "identical from
30k feet" to a community member's external-host launcher project.

Phase 9/10 is a hardening pass over this project's OWN Go code (fuzzing, CI,
crash/restart tests, docs) — it does not itself add a new Go-side admission
capability. But P9-07 exists precisely so that decision is made deliberately
once per phase, not skipped by default: before this project's roadmap moves
into any phase that WOULD add new Go-side capability surface (v1.1's
capability/credential-broker work named in `docs/ADR-014`, or anything
building on EC-04's guard-catalog independence), a fresh check of what
upstream has actually shipped since the pin is due diligence, not busywork.

## What this review found (2026-09-03, via public GitHub pages — no
authenticated API access, no repository clone; see Method below)

**The v2.3.0 pin already includes the "registries" work the Discord signal
flagged.** v2.3.0's own release notes (24 Aug 2026) confirm the founder's
claim landed in this exact tagged release, not just on an unreleased branch:

- *"Agent mailbox access now goes through storage-neutral host and runner
  registries."*
- *"The container runtime moves behind the session driver seam."*
- *"Container gateway wiring now typed and admission-checked."*

This is **not new drift relative to this project's baseline** — it is
already what `docs/host-decomposition-addendum-drivers.md`'s entry 16
describes (`src/drivers/types.ts`/`index.ts`/`docker-driver.ts`, the
`SessionDriver` seam, `DockerSessionDriver.prepare(spec)` as the real
chokepoint via its first-line `validateSpec(spec, policy, capabilities)`
call). **`DockerSessionDriver.prepare(spec)` is confirmed still the real
chokepoint** — the v2.3.0 release notes describe the same driver seam this
project already ported from (`internal/mount` = `drivers/types.ts`'s
`validateSpec`/`mountAllowed`), under the same name, with no indication the
admission chokepoint moved to a different function or file. The "typed,
admission-checked container gateway wiring" language is upstream's own
framing for the seam this project's ADR-003/ADR-016 already targeted — an
independent confirmation that this project picked the right layer, not a
sign it picked the wrong one.

**One new, concrete compatibility fact worth recording, not acted on yet:**
v2.3.0's release notes state plainly that *"SQLite remains the default and
existing `data/v2.db` files are unchanged"* despite the `DbDriver`
abstraction — direct, first-party confirmation that this project's core
assumption (`internal/mailbox`, `internal/session` read/write the same
sqlite files the TS host does, via `modernc.org/sqlite`) still holds **for
the default backend**. The same notes also require **Node.js 22+ "due to
the upgraded `better-sqlite3` release"** — a newer native sqlite3 binding
writing files this project's pure-Go `modernc.org/sqlite` (v1.57.0, vendored)
must keep reading correctly. Recorded as a compatibility-matrix watch item
(see `docs/compatibility-matrix.md`'s SQLite row) rather than a finding this
ADR can resolve — verifying it needs a real file written by the upgraded
`better-sqlite3` on the user's Mac, not something checkable from this
sandbox.

**No newer tagged release exists yet.** As of 2026-09-03, v2.3.0 (24 Aug) is
still nanocoai/nanoclaw's latest published release. Upstream `main` has
continued to move in the interim (e.g. an in-progress "opt-in persistent
memory scaffold for providers" commit observed via GitHub Actions run
metadata) — expected, unreleased, and per LAW-09 not this project's concern
until it lands in a tag.

## Decision

**Build/Reuse/Defer/Drop, for this phase:** N/A to Build/Reuse/Drop — Phase
9/10 adds no new differentiated Go-side feature, so there is nothing here to
weigh against upstream's own direction. The applicable decision is **Defer**:
this review clears Phase 9/10's own hardening work to proceed exactly as
planned (nothing found here changes any of P9-01 through P9-06/P9-08/P9-09),
but any FUTURE phase that adds new Go-side admission/capability surface
(the v1.1 candidate work in `docs/ADR-014`) must re-run this same review
against whatever upstream tag is current at that time before assuming
`DockerSessionDriver.prepare(spec)` and `drivers/types.ts`'s contract shape
are unchanged — v2.3.0's own pace of change (a major driver-seam rework
inside one release) is evidence this contract is not static.

**Process decision, going forward:** don't rely on remembering to do this by
hand. P9-05's new `upstream-watch` CI job (`.github/workflows/ci.yml`,
`docs/upstream-pin.json`) automates the cheap half — noticing a new tagged
release exists — on a weekly schedule; this ADR's kind of qualitative review
(reading the new release's notes for anything touching the ported surface)
stays a human step, triggered by that job's alert, not something CI itself
attempts to judge.

## Method (for anyone re-running this later)

Performed via web search and page fetches only (`nanocoai/nanoclaw`'s GitHub
pages, no clone, no authenticated API) — this project's own development
sandbox has no network path to `github.com` (see `go-host/README.md`'s CI
caveats), so this review ran from a session with broader, tool-mediated web
access. GitHub's search UI over commits/PRs was not usable this way (returns
a static default listing, not a real filtered search — the same limitation
`docs/baseline.md` already noted); release notes and the repo's own
description page were usable and are what this ADR's findings are drawn
from. A `CHANGELOG.md` fetch returned only entries up to v2.1.0 despite
v2.3.0 being tagged — apparently the file lags actual releases rather than
being kept in lockstep — so this review treats the GitHub Releases page as
authoritative over `CHANGELOG.md` for "what shipped," and future re-runs
should do the same.

## Consequences

- No parity fixture, ADR line citation, or `internal/mount`/`internal/
  kernel` contract needs updating as a result of this review — v2.3.0 was
  already the ported baseline before this review started.
- `docs/compatibility-matrix.md` gets one new explicit watch row (SQLite
  file compatibility under Node 22's upgraded `better-sqlite3`) that did not
  exist before this review surfaced it.
- The next phase that proposes new Go-side capability surface must cite a
  review like this one — dated, sourced, with an explicit Build/Reuse/
  Defer/Drop call — before that phase's design doc is considered complete.

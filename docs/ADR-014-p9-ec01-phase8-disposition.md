# ADR-014: Phase 8 Capability/Credential Prototype Disposition for v1 (EC-01)

Status: accepted, 2026-09-02, as task EC-01 (Phase 9 — Enforcement Closure, per `docs/roadmap-to-v1.md`). This ADR exists specifically so the question "does `internal/capability`/`internal/credentialbroker` need to be wired into the kernel before release?" has one recorded, decisive answer instead of remaining an open question that could silently block or scope-creep every later phase.

## Decision

**`internal/capability` and `internal/credentialbroker` are not wired into the v1 enforcement path.** `internal/kernel` ships v1 with exactly the three capabilities it has always had (`container.wake`, `container.build_image`, `container.kill`) as its complete capability surface. Neither prototype is promoted, extended, or connected to any live request during this project's run to v1.

This is not a deferral made by default or by running out of time — it is a considered choice, made explicitly so a reader isn't left wondering why a tested package sits unused.

## Why

1. **Both P8-02 and P8-04's own done-when criteria never required production wiring.** They are complete against what they were actually asked for: a tested prototype proving a property in isolation (bounded-lifetime filesystem grants; secret-free credential tokens), not against "ship this in the kernel." Treating them as unfinished because they aren't wired in would be holding this phase to a bar it was never designed to clear.

2. **Wiring either one in is real, nontrivial, cross-language integration work that ADR-012 itself already names as unresolved**: who calls `Issue` (`internal/kernel` at `container.wake` time?), who calls `Resolve` (a trusted gateway/proxy process that doesn't exist yet — today's real credential path is TypeScript's OneCLI gateway, per `internal/credential`), and how the agent/proxy trust boundary gets enforced by process separation rather than by a Go-level access modifier a same-process caller can bypass. None of this is a small addition; it is comparable in scope to EC-02 itself, and bundling it into the same release would risk the release never shipping.

3. **OBJ-07 (credential/capability security) is explicitly "High, Non-negotiable: No"** in the master plan's own objective list — unlike OBJ-01 through OBJ-04's "Critical, Non-negotiable: Yes." Deferring a High/negotiable objective's full realization past v1, while shipping its groundwork as tested, documented prototypes, is consistent with the project's own stated priorities, not a compromise of them.

4. **LAW-05 ("every component must justify itself")** cuts the same way from the enforcement side: wiring a capability broker into the live kernel boundary before EC-02/EC-03 even exist would mean adding new enforcement surface to a kernel that isn't yet in the request path at all — solving a second problem before the first one (real enforcement) is real.

## What v1 says about this, explicitly

The compatibility/security report (Phase 11, the former P10-04) states this plainly, per that task's own instruction to distinguish "100% of defined tests pass" from "bug-free" or "complete": capability scoping and credential brokering are **designed, prototyped, and tested in isolation** (`docs/capabilities.md`, `internal/capability`, `internal/credentialbroker`, ADR-011/012/013) but **not yet adopted** into the kernel's live enforcement boundary. This is named as a v1.1-or-later roadmap item, not implied to be already shipping.

## What would change this decision

A future phase that actually specs the cross-process wiring (a TS-side proxy process, or a decision to have `internal/kernel` itself hold `Resolve` authority once it's a real long-lived daemon per EC-03) would be the right place to revisit adoption. At that point, the prototypes here are exactly the tested starting point that phase would build on, not wasted work. Nothing about this ADR says "never"; it says "not inside this release," with the reasoning on record so a future session doesn't have to re-litigate it from scratch.

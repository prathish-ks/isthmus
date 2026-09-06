# NanoClaw Go Host — Design Laws

Status: committed 2026-08-30, as task P1-05. Source: `NanoClaw_Go_Host_Project_Master_Plan_UPDATED.xlsx`, "Design Laws" sheet (project constitution), cross-referenced against "Objectives," "Test Strategy," and "Risk Register."

## Purpose

These nine laws are the project's constitution. They exist so that months of AI-assisted development — much of it done by asking Claude or another coding agent to implement individual tasks — stays aligned with the project's actual thesis, rather than drifting task by task toward either "NanoClaw rewritten in Go" (defeats the purpose) or "Go kernel that quietly regrows product logic" (defeats the security value). Every task in the workbook, and every architectural change proposed during development, should be checked against this list before it's accepted.

**Any intentional violation of a law below requires an Architecture Decision Record (ADR)** — a short, dated, written justification of why the exception is warranted, what alternative was rejected and why, and what would have to change for the exception to be revisited. No application code changes accompany this document; it is a governance artifact only.

## The nine laws

| Law | Rule | Practical interpretation | Failure signal |
|---|---|---|---|
| LAW-01 | Flexible above, rigid below | Routinely changing behaviour stays in TypeScript/skills; security/reliability invariants may live in Go. | Business workflow or prompt changes require Go edits. |
| LAW-02 | No Go for ordinary customization | A normal user should be able to ask Claude/Codex to alter workflows, prompts, channels or integrations without touching the kernel. | Customization regression suite contains unexpected Go changes. |
| LAW-03 | Upstream compatibility before feature growth | Preserve the original agent runner, protocols and ecosystem before adding differentiated features. | New features are added while compatibility is still unknown/broken. |
| LAW-04 | Every security control needs low-friction UX | Use context, risk and temporary capabilities to avoid approval fatigue. | Security improvement produces repeated unnecessary prompts. |
| LAW-05 | Every component must justify itself | Do not add bridges, daemons, gRPC, Redis or policy services unless they remove more complexity than they add. | Architecture grows into a distributed system for a personal-agent use case. |
| LAW-06 | Contracts before rewrites | Capture observable TypeScript behaviour in tests before replacing it in Go. | Go code is accepted because it "looks equivalent." |
| LAW-07 | Mechanism in Go; experience in flexible layer | Go enforces what must never be bypassed; TypeScript decides most user-facing behaviour. | Go accumulates formatting, prompts, business rules or channel-specific behaviour. |
| LAW-08 | No weaker security than upstream | A rewrite must never weaken mounts, identity/session isolation, credential handling or container restrictions. | Parity tests pass but security regression tests fail. |
| LAW-09 | Upstream moves independently | A NanoClaw release that does not change a contract consumed by the Go kernel should require zero Go source changes. Pin stable releases for development and use a separate upstream watch track. | Routine NanoClaw minor releases require repeated Go rewrites or users remain stuck on old versions. |

There is no LAW-10. See "Why there is no tenth law," below.

## LAW-07 / OBJ-04, annotated: "exclusive enforcement"

LAW-07 reads, on its face, as a division of labor: Go enforces, TypeScript decides most things. Phase 1's investigation (P1-01 through P1-04) sharpened what "enforces" has to mean for that division to actually produce security value, and that sharpened reading is recorded here so it doesn't get lost or re-litigated later in the project.

**The reading**: LAW-07 is not satisfied by Go *also* running a copy of the decision logic. It is satisfied only when the real-world privileged effect — not just the decision about it — is *physically impossible* to trigger except through the Go kernel. A decision made in Go that TypeScript can still act on unilaterally, by calling the underlying function directly, provides no enforcement at all; it's advisory. This is the same point OBJ-04 makes from the objectives side ("trusted core smaller and harder to accidentally weaken" — measured by "security-critical invariants are enforced in the Go kernel and regression-tested," not merely decided by it), and it is exactly what Test Strategy layer 7 ("Security regression... no Docker socket... All critical invariants pass") is built to catch: a passing differential-parity test (layer 4) proves the *decision* matches; only a security regression test proves the *effect* is actually blocked when it should be.

**Why this matters concretely, from what P1-02 through P1-04 found**: the codebase's decision layer (`guard()`, plus the CLI-derived guard catalog discovered at P1-04) is already close to complete and well-designed — fail-closed, compile-time-linked to its actions, with live grant re-validation. The actual gap identified by tracing every call site to `container-runner.ts`'s three Docker-facing functions (`wakeContainer`, `buildAgentGroupImage`, `killContainer`) is that they are plain exported TypeScript functions, callable from anywhere in the same Node process. Nothing but code-review discipline stops a new module, a misused import, or a compromised transitive dependency from calling them directly and skipping every decision layer entirely. A Go kernel satisfies LAW-07's "must never be bypassed" clause the moment — and only the moment — those three functions become physically uncallable except through a boundary the kernel itself checks.

**What follows for scope, so this isn't read as "move everything"**: only the guard logic that actually gates those three functions needs to move into the kernel alongside the execution authority — concretely, self-mod's `install_packages`/`add_mcp_server` checks and the CLI-derived guard for the `restart` command, per the P1-04 enumeration. The rest of the guarded-action catalog (`a2a.send`, `agents.create`, `senders.admit`, `channels.register`, and every other `ncl` command that never touches Docker) gates nothing the kernel controls, and moving it would violate LAW-01/LAW-02 for no security benefit. This is the concrete, scoped form of LAW-07 that Phase 3 should build against — not "port `guard.ts`," but "make these three functions, and the specific decisions that gate them, jointly un-bypassable."

**Explicit risk cross-references**: this reading is what keeps the project out of Risk R-06's trap ("kernel accumulates product/integration logic" — avoided by moving only the narrow gating logic, not the whole catalog) and Risk R-10's trap ("Go rewrite narrative: project solves engineering interest, not user problem... only measurable benefit is runtime/language change" — avoided because the benefit being pursued is a physically enforced boundary, not a language swap of the same advisory check).

## Why there is no tenth law

A second-opinion review of the project (2026-08-30) proposed adding a new "LAW-10 — security authority must be exclusive." The explicit decision, made and recorded at the time, was not to add it: the substance is already fully covered by LAW-07 and OBJ-04, sharpened above with the concrete evidence Phase 1 produced. Adding a numbered law for the same idea would duplicate the constitution rather than clarify it. A later, unverified "upstream monitoring" update referenced "LAW-10" as though it had been adopted — it had not, and this document is the durable record that it was considered and declined in favor of annotating the existing laws.

## Using this document going forward

Before any architectural change in this project — not just Go-kernel work — check it against LAW-01 through LAW-09 above. If a change is genuinely justified despite conflicting with one of these laws, write a short ADR (a dated markdown note: what law it touches, why the exception is warranted, what was rejected instead, what would make the exception unnecessary later) rather than proceeding silently. This document itself should be revisited, not silently drifted from, if Phase 3's design work surfaces a genuinely new principle — the bar for adding a tenth law is that it must not be restating something LAW-01 through LAW-09 already cover.

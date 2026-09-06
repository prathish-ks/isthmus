# ADR-011: Risk-Based Approval Model (P8-03)

Status: accepted, 2026-09-02, as task P8-03. Prerequisite: P8-01 (satisfied). Done when, per the master plan: "Approval matrix and UX examples exist." Instruction: "Classify sample operations into automatic, context approval, explicit approval and prohibited. Keep the model small."

## Why this needs a model at all

R-07 in the master plan's own risk register names the failure mode directly: "JIT capabilities... Approval fatigue damages UX... Trigger to stop/redesign: Users approve repeatedly for routine safe work." A capability model (docs/capabilities.md) that asked for explicit approval on every grant would be more secure on paper and worse in practice — a user who reflexively clicks "approve" on ten prompts a day is not meaningfully protected by the eleventh. The four-tier model below exists to keep genuinely risky actions gated while routine ones aren't, which is the actual security property, not "every action requires a click."

## The four tiers

| Tier | Meaning | Who/what decides |
|---|---|---|
| **Automatic** | Granted with no human in the loop, subject to the request passing every structural validation already in place (mount.ValidateSpec, containerdefaults, ownership). | The Go kernel / capability manager itself, at request time. |
| **Context approval** | Granted automatically, but only when specific contextual conditions hold (first time for this session, resource class, or time window); outside those conditions it escalates to Explicit. | The Go layer evaluates the condition; escalates rather than silently allowing or denying when the condition can't be confidently evaluated. |
| **Explicit approval** | Requires a human decision before the grant is issued — a real prompt, not inferred from context. | The operator/user, via whatever UI surfaces the prompt (out of scope for this ADR — see "Not decided here" below). |
| **Prohibited** | No grant exists for this shape of request under any circumstance — not "requires approval," but structurally absent from the capability set. | Nobody decides this at request time; it was decided once, here, at design time. |

## Classification of sample operations

| Operation | Tier | Rationale |
|---|---|---|
| `container.wake` for an existing, previously-validated session (re-waking after idle) | **Automatic** | Already validated once at session creation; internal/kernel's own mount/RunAs/ownership checks re-run every time regardless, so "automatic" here means "no additional human gate," not "no validation." |
| P8-02's temporary read-only filesystem grant, scoped to a session's own scratch directory, ≤15 minutes | **Automatic** | Read-only, session-scoped, short-lived, and revocable — the exact shape docs/capabilities.md's misuse-case list was designed to keep narrow. Matches R-07's own mitigation: "risk-based approvals; temporary least privilege; low-risk defaults." |
| `container.build_image` for a session's own agent group, first time this session | **Context approval** | Building a new image is more consequential than waking an existing one (arbitrary Dockerfile content executes at build time), but re-running it for the *same* agent group after the *first* approval is routine iteration, not a new risk. Condition: "has this exact (agent group, image tag) pair been approved before, within a bounded window?" — yes escalates to Automatic-after-first-approval; no requires the human decision below. |
| P8-04's scoped credential token, first issuance per session | **Context approval** | The token itself is narrowly scoped and short-lived by construction (docs/capabilities.md's schema), but *issuing the first one for a brand-new session* is the point where a compromised or misconfigured session would first try to get credential access — worth a lighter contextual check (has this session completed container.wake successfully?) before auto-issuing subsequent tokens. |
| `container.kill` for a session the requester did not itself wake | **Prohibited** | This is not a tier a human can escalate into — `internal/kernel`'s own `handleKill` structurally cannot resolve a container name for a session it didn't register (see ADR-008's non-capabilities list). There is no approval flow here because there is no request shape that could reach one. |
| A read-write (not read-only) filesystem grant outside a session's own group directory | **Explicit approval** | This is the one genuinely new privileged shape Phase 8 discusses (P8-01's schema technically allows a broader Action/Resource combination than P8-02 prototypes) — write access outside a session's own scope is exactly the kind of action R-07's matrix exists to gate with a real human decision, not infer from context. |
| Raw Docker argv / shell passthrough of any kind | **Prohibited** | Named explicitly in `internal/kernel/doc.go`'s non-capabilities list; restated here because P8-03's own instruction asks for a "prohibited" example, and this is the clearest one already established elsewhere in this project rather than invented for this ADR. |

## UX examples

**Automatic, done well**: nothing appears in the UI. The only trace is `internal/capability`'s audit log (`ApprovalContext: "auto-approved: read-only, 15-minute default"`) and, for kernel-boundary capabilities, `internal/kernel`'s own `StatusTrace` audit entries — both inspectable after the fact via `nanogo doctor`/`security-check`, never demanding attention before the fact.

**Context approval, done well**: the first `container.build_image` for a new agent group surfaces one clear prompt ("Build a new container image for agent group `research-bot`? This runs the Dockerfile you configured.") with enough detail to make an informed choice, but every *subsequent* build of the same agent group (a normal part of iterating on a Dockerfile) proceeds automatically — the condition ("already approved once") is what keeps this from becoming R-07's "users approve repeatedly for routine safe work."

**Explicit approval, done well**: a read-write grant outside a session's own directory names exactly what's being requested and why in plain language ("Agent wants write access to `/data/groups/other-group/shared` — outside its own group's directory") rather than a generic "Allow this app to access files?" dialog a user learns to dismiss without reading.

**Prohibited, done well**: there is no dialog at all — `container.kill` for a session you didn't wake, or raw argv passthrough, simply isn't offered as an option anywhere in the surface a user or agent interacts with, the same way `internal/kernel`'s `CapabilityRequestPayload` has no field for a caller-chosen build-context directory (ADR-008 §"Two non-obvious calls"). The absence of the option is the security property, not a rejected request a user has to understand why they can't do.

## Not decided here

This ADR classifies *which tier* a given operation falls into and states the design principle each tier follows. It deliberately does not design the actual approval UI/prompt surface (which channel adapter shows it, what the exact prompt copy is, how a "context" condition's approval history is persisted across restarts) — that's implementation work for whichever phase actually wires a human-in-the-loop flow into a live host process, consistent with this project's standing practice of not building UI ahead of the process (`cmd/nanogo`, `container-runner.ts` wiring) that would need it.

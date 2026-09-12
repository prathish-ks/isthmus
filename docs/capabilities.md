# Capability Model (P8-01)

Status: written 2026-09-02, as task P8-01. Prerequisite: P7-04 (satisfied). Done when, per the master plan: "docs/capabilities.md contains compact schema, examples and misuse cases." Instruction: "Define resource, action, agent/session, scope, expiry and approval context. Do not invent a generic policy language."

## Relationship to `internal/kernel`'s existing `Capability` type

`internal/kernel` (P6-02, ADR-008) already defines a `Capability` — a closed, three-value enum (`container.wake`, `container.build_image`, `container.kill`) with no request-shaped scoping at all: a `capability.request` either names one of those three fixed operations or is rejected outright (`ErrUnknownCapability`). That design is correct for what it is — LAW-05's "every component must justify itself" argues against adding scope/expiry/approval-context fields to a boundary that, today, only ever grants one of three all-or-nothing container-lifecycle actions per session.

This document is the schema Phase 8's *new* prototype capabilities (P8-02's temporary read-only filesystem grant, P8-04's scoped credential token) actually need, distinct from a redesign of `internal/kernel`'s existing type. It defines a **temporary, scoped grant** — narrower than "kill this session's container," and time-bounded in a way none of the existing three are (a wake either succeeds or fails once; it does not expire). Where the two models overlap (both are "an agent/session is allowed to do X"), this document's fields are a superset a future `internal/kernel` capability could adopt if a fourth privileged operation ever needs scoping.

## Schema

A deliberately small, fixed struct — six fields, no nested policy language, no wildcard/glob DSL, no boolean expression evaluator. If a use case needs more than these six fields to describe, the answer is a new, separately-justified field (with its own ADR), never a generic "conditions" bag that could grow into a policy language by accretion.

| Field | Type | Meaning |
|---|---|---|
| `Resource` | string | What the grant is over — a path, a session id, a capability name. Interpretation depends on `Action` (a filesystem action's Resource is a path; a container action's Resource is a session id). |
| `Action` | string, closed enum per resource kind | What's allowed — e.g. `fs.read`, `fs.write`, `credential.use`. Never a raw verb like `"do"` — every Action is specific enough that granting it has one unambiguous meaning. |
| `SessionID` | string | Which session this grant belongs to. A grant is always scoped to exactly one session — there is no "grant to every session" shape, matching `internal/ownership`'s existing session-scoping discipline elsewhere in this project. |
| `Scope` | string, optional | A narrowing qualifier within Resource — e.g. a subdirectory prefix for `fs.read`, or a rate/byte limit for `credential.use`. Empty means "the whole Resource," never "unrestricted across all resources." |
| `ExpiresAt` | time.Time | When the grant stops being valid. Every grant has one — there is no permanent-grant shape in this model; a capability an operator wants to be effectively permanent still gets a long `ExpiresAt` and a renewal path, not a bypass of expiry itself. |
| `ApprovalContext` | string, optional | A free-text record of why/how this grant was authorized — "operator CLI," "auto-approved (low-risk, see ADR-011)," "explicit approval, ticket #123." Never parsed or branched on by the grant-checking code itself; it exists purely for the audit trail P8-02/P8-04's own tests already assert gets recorded.

## Examples

**A temporary read-only filesystem grant** (P8-02's actual prototype shape): `Resource="/data/groups/ag-1/scratch"`, `Action="fs.read"`, `SessionID="sess-42"`, `Scope=""` (the whole scratch directory), `ExpiresAt=now+15m`, `ApprovalContext="auto-approved: read-only, session-scoped, 15-minute default"`.

**A scoped credential token** (P8-04's actual prototype shape): `Resource="onecli-gateway"`, `Action="credential.use"`, `SessionID="sess-42"`, `Scope="chat-completions-only"`, `ExpiresAt=now+5m`, `ApprovalContext="issued at container wake, tied to sess-42's own lifetime"`.

**A container kill request** (shown here for comparison — this is `internal/kernel`'s existing shape, not this document's): no Scope, no ExpiresAt, since a kill is one-shot rather than time-windowed. There's no ApprovalContext field either; the kernel's own audit log records the decision instead. This is why the two models coexist rather than one replacing the other. The existing three capabilities don't need what this schema adds, and this schema's grants don't need `internal/kernel`'s exec-chokepoint machinery — a filesystem read grant never invokes `docker`.

## Misuse cases this schema is designed to make structurally awkward

1. **A grant that never expires.** `ExpiresAt` is a required field with no "never" sentinel value in the type — a caller wanting a long-lived grant must supply an actual future time, which at least forces a conscious choice of how long "long" means.
2. **A grant that widens to more than its Resource.** `Scope` only narrows; there is no field that broadens a grant beyond its named `Resource` (no `"resource": "*"`, no glob). Requesting access to a second path means requesting a second grant.
3. **A grant reused across sessions.** `SessionID` is mandatory and singular. A grant minted for `sess-42` structurally cannot be checked against `sess-43` — the check function takes both the grant and the requesting session id and compares them, the same pattern `internal/ownership.ValidateOwnership` already uses for cross-session mount checks.
4. **Approval-context used as an authorization mechanism.** `ApprovalContext` is explicitly documented above as never parsed by grant-checking code — a caller cannot forge authorization by setting `ApprovalContext="approved by admin"` on a grant that was actually auto-issued, because nothing reads that field to decide whether the grant is valid. It is provenance for a human or audit tool reading grant history.
5. **A capability language growing by accretion.** Six fixed fields, no generic key-value "conditions" map. A seventh field requires a new schema version and its own justification (this document, updated) — the explicit trade this task's own instruction names ("do not invent a generic policy language").

## Where enforcement actually lives

This schema describes *what a grant looks like*, not *how it's checked* — that's P8-02/P8-04's job, each in its own package, each with its own tests proving access during the grant's window and denial after `ExpiresAt`. This document is deliberately silent on storage/transport (in-memory for the P8-02/P8-04 prototypes, matching their own "prototype only" scope per the master plan) — a durable, multi-process capability store is future work if this model is ever promoted out of prototype status.

# ADR-031: Community portal adoption

Status: decided 2026-09-25, by direct founder direction. Reverses Workstream
C4's original "do not adopt" recommendation in `docs/promotion-v2.4.0.md`.
Adds new Workstream C tasks C10/C11.

## Background

Workstream C4's full repo-wide sweep (this promotion's bypass-closure pass)
found `src/community-portal/` — ~2,990 lines, entirely new in v2.4.0, not
previously mentioned anywhere in this plan. It is a client for
`https://portal.nanoclaw.dev`, an upstream-operated hosted service: a
per-machine device identity, a browser-based sign-in flow, and (as of
v2.4.0) exactly two "perks" offered during setup — `echo` (pull nanocoai's
Echo-built hardened agent image instead of building locally) and `slack` (a
managed, automated Slack app install). C4's original recommendation was not
to adopt it, reasoning it was a product/trust decision (does an Isthmus
install register a device identity with and phone home to nanocoai's
infrastructure) with no bearing on kernel compatibility.

That recommendation was revisited and reversed after two rounds of direct
discussion, each correcting a factual error in the prior reasoning:

1. **First correction**: Isthmus does not have an "independent alternative"
   that makes this redundant. `docs/hardened-image.md` — an *existing*
   Isthmus doc, present before this promotion started — documents Isthmus's
   current hardened-image opt-in, and it is **the same Echo/nanocoai hosted
   service** the community portal's `echo` perk offers (verbatim: "That
   image is built by **Echo**... enable Echo's hardened image?"), gated by
   the same account system (`setup/registry-login.sh`,
   `NANOCLAW_REGISTRY_API`). Isthmus is not choosing between "our own
   feature" and "nanocoai's feature" — it already depends on nanocoai's
   hosted registry for this one path.
2. **Second correction**: the real scope was undercounted twice, once each
   way. `setup/registry-login.ts` (1,265 lines in v2.4.0) is **not** net-new
   porting work — Isthmus already has a version of this file, inherited from
   its nanoclaw fork base. But that existing version only exports
   `AccountCredential` and `run` — a much narrower shape than v2.4.0's, which
   adds the full device-flow machinery (`startDeviceFlow`, `finishDeviceFlow`,
   `LoginError`, `DeviceFlow`) that `setup/portal.ts` actually depends on. So
   the real port is not "3,563 new lines, cleanly additive" — it is
   **upgrading a live file the existing hardened-image sign-in flow already
   depends on**, plus adding `src/community-portal/`, `setup/portal.ts`, and
   `setup/slack-worker.ts` on top of it.

## Why this is in scope for this promotion specifically

This plan's own Goal section states the promotion is about "adopting the new
upstream features — not just absorbing them passively." Community-portal is
squarely that: a real, shipped, tested upstream v2.4.0 feature, not
speculative growth invented for this promotion. Declining to adopt it would
need its own justification under LAW-03 (compatibility before feature
growth) the way the original C4 finding attempted — and that justification
no longer holds once the "redundant with an existing feature" premise is
gone.

## Checked against the nine design laws

- **LAW-01/LAW-02** (no Go for ordinary customization) — fully compliant.
  Confirmed directly: `src/community-portal/`'s own header states it
  "depends only on Node built-ins"; the one process-spawning call
  (`slack-job.ts`) spawns a plain `node --import tsx setup/slack-worker.ts`
  subprocess, never docker, never a privileged operation. Zero Go kernel
  involvement, zero mount/container/network surface touched.
- **LAW-03** (compatibility before feature growth) — passes once reframed
  correctly: this is adopting upstream's own already-built, already-tested
  v2.4.0 feature, the same posture as C7/C8/C9's gateway-provider adoption,
  not inventing new scope.
- **LAW-04** (every security control needs low-friction UX) — not
  applicable as a blocker; community-portal is not a security control, it's
  an opt-in convenience feature. Every stage (`signInThroughPortal`,
  `offerPortalReminder`) treats a declined, expired, or failed sign-in as
  "skip this stage," never a hard gate — confirmed directly in `portal.ts`.
- **LAW-05** (every component must justify itself; no unjustified
  complexity) — the real complexity cost is material (~3,563 new lines plus
  an upgrade to an already-depended-on file) but justified: it extends an
  ecosystem Isthmus already has one foot in, ships real user value (patch
  currency on sandboxed components, and Slack setup without a manual
  developer-console flow), is fully opt-in end to end, and adopts
  already-built-and-tested upstream code rather than requiring Isthmus to
  design something equivalent later.
- **LAW-06** (contracts before rewrites) — this is the concrete engineering
  requirement the port work must satisfy, not a policy question: before
  extending `setup/registry-login.ts` from its current narrow export shape
  to v2.4.0's fuller device-flow shape, characterize its *current* exported
  behavior (what `AccountCredential`/`run` actually do today, and any
  callers depending on them) with tests, the same discipline A1's Go port
  used when it ran the existing suite before assuming its port was correct.
  The existing hardened-image sign-in flow must not regress.
- **LAW-07** (mechanism in Go; experience in flexible layer) — cleanly on
  the "flexible layer" side. No privileged effect (mount, container,
  network) is produced or influenced by any of this code; it is pure
  account/UI/setup-wizard work.
- **LAW-08** (no weaker security than upstream) — a real, concrete task for
  the port, not yet verified: confirm Isthmus's ported version preserves
  upstream's own stated privacy posture (`docs/hardened-image.md`'s own
  "What is collected" / "What is never collected" section is the bar to
  match — verified email, IP truncated to /24, and the image requested at
  fetch time; explicitly never anything about groups, channels, messages,
  prompts, files, or API keys). A Workstream-C6-style review pass should
  cover the ported code before it's considered closed, the same bar every
  other new surface in this promotion was held to.
- **LAW-09** (upstream moves independently) — favors adoption: porting
  upstream's own feature close to verbatim keeps the two lineages in sync,
  which is more consistent with this law than maintaining Isthmus-only
  divergence from a feature upstream users get by default.

No law is violated by adopting this; LAW-05's cost is real and named rather
than minimized, and LAW-06/LAW-08 name concrete obligations the port work
itself must satisfy, not just a general implementation.

## Decision

Adopt `community-portal`, matching upstream v2.4.0, as two new Workstream C
tasks:

**C10 (new) — Upgrade `setup/registry-login.ts` to v2.4.0's device-flow
shape, under contract tests.** Characterize the current narrow
(`AccountCredential`/`run`-only) exported shape with tests first (LAW-06),
confirm nothing that currently calls it (the existing hardened-image
sign-in flow, `docs/hardened-image.md`'s documented commands) regresses,
then extend it to add `startDeviceFlow`/`finishDeviceFlow`/`LoginError`/
`DeviceFlow` matching v2.4.0's shape. Sequenced first — C11 depends on it.

**C11 (new) — Port `src/community-portal/`, `setup/portal.ts`, and
`setup/slack-worker.ts`; wire into Isthmus's setup wizard.** Verify
Isthmus's setup wizard has (or gains) the `--step registry`-style structure
`portal.ts` assumes. Include a security-review pass against LAW-08's bar
above before this counts as done — what's collected, what's never
collected, whether the device key / account token land anywhere the kernel
wouldn't admit as a valid mount (expected: no, this never touches mounts at
all, but confirm rather than assume).

## Consequences

- `docs/promotion-v2.4.0.md` Workstream C: C4's row updated to point here
  instead of standing as a final "do not adopt" recommendation.
- Workstream D's file inventory (D1): the 19 `src/community-portal/` rows
  already flagged "not yet looked at" get reclassified once C10/C11 land,
  plus new rows for `setup/portal.ts`, `setup/slack-worker.ts`, and their
  tests (not previously counted at all), and `setup/registry-login.ts`
  moves from "clean, untouched" to "modified, contract-tested" once C10
  lands.
- This is genuinely new implementation work, not documentation — C10/C11
  are each real, not checkbox items.

## What would change this

A response from nanocoai clarifying that fork traffic against
`portal.nanoclaw.dev` is unwelcome or against their terms would reopen this
decision — that is a policy question this ADR could not resolve from
reading client-side code alone, and remains the one open unknown.

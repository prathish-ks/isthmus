# ADR-021: `doctor` reports the container runtime class (hardened isolation)

**Status**: accepted, implemented in `internal/doctor` (`checkRuntimeClass`).

**Context**: the 2025–2026 agent-sandboxing landscape has converged on an
isolation hierarchy — plain OCI containers (shared host kernel) at the
bottom, gVisor (user-space kernel) above that, microVMs (Kata, Firecracker)
above that. The July 2026 Hugging Face agent-intrusion writeup is the
clearest public example of what the bottom of that hierarchy costs: an agent
escaped its sandbox and then pivoted using credential material it could
reach from the host it landed on. Google's GKE Agent Sandbox, Modal and E2B
all take the position that untrusted, model-generated code belongs above the
shared-kernel tier.

Isthmus's own scope rules out implementing any of that. A user-space kernel
or a microVM is a deployment/infrastructure decision an operator makes for
their host; building one would be exactly the "second product layer" the
design laws exist to prevent. What is in scope — and is the whole point of
`doctor`/`security-check` — is being honest about which tier this host is
actually running on. That gap is what this ADR closes.

## Decision

`nanogo doctor` gains a seventh check, `container runtime class (hardened
isolation)`. It asks the daemon, in one `docker info --format` call, for its
default runtime and every runtime it knows about, and classifies the names it
gets back: `runsc`/`io.containerd.runsc.v1` → gVisor, `kata*`/
`io.containerd.kata.v2` → Kata Containers, `sysbox-runc` → Sysbox. Anything
else (`runc`, `crun`, `io.containerd.runc.v2`, `nvidia`) is an ordinary
shared-kernel runtime and is reported as exactly that.

Three outcomes:

| Daemon state | Level | Why |
|---|---|---|
| Default runtime is a hardened class | `pass` | Containers do not share the host kernel; say which runtime, by name. |
| A hardened runtime is installed, but is not the default | `warn` | The one case an operator can honestly act on: they installed it, and containers are not getting it. Remediation names `default-runtime`/`--runtime`. |
| No hardened runtime available | `pass` | The expected default for a personal install. |

## Why "no hardened runtime" is a pass, not a warn

This is the load-bearing judgment in this ADR, and it cuts the opposite way
from ADR-018's follow-up (which deliberately turned a silent `pass` into a
`warn` for a missing `-allowlist`).

The difference is what the project promised. A missing mount allowlist is a
gap in something Isthmus itself enforces, with a remediation inside the
product: pass `-allowlist`. A missing hardened runtime is not a gap in
anything Isthmus enforces or ever claimed — the isolation tier is the
operator's infrastructure, and this host neither selects a runtime nor
depends on one. Warning every stock Docker install about it would put a
permanent yellow line in `doctor`'s output that no reasonable personal-host
operator is going to act on, which trains people to ignore the yellow lines
that do matter.

So the honesty lives in the `Detail` string instead of the level: the pass
states plainly that agent containers run under `runc` and share the host
kernel, and that Isthmus provides no microVM or user-space-kernel isolation
of its own. A reader gets the real posture without a false alarm.

## Why `doctor` and not `security-check`

`internal/securitycheck`'s own doc comment draws the line: it inspects
configuration and policy an operator controls, never a live daemon. This
check has nothing to read but the live daemon — there is no Isthmus-side
runtime setting to inspect (`internal/config` has no runtime field, and
`internal/containerdefaults` composes no `--runtime` argv). It belongs where
the other live-Docker checks already are.

Unlike `checkMetadataEgressBlock` (ADR-013 Decision 3) it is not opt-in:
`docker info` spawns no container and changes nothing, the same cost as the
existing `container runtime` check, so it runs on every `doctor` call.

## What this deliberately does not do

- It does not select, configure, install or recommend a runtime. Isthmus
  reports the class; the operator decides the tier.
- It does not fail. No level above `warn` is reachable from this check —
  consistent with `doctor` never auto-fixing and never inventing a policy
  the host does not enforce.
- It does not read per-container runtime overrides. A container started with
  an explicit `--runtime` by something outside this host would not be
  visible here; the check reports the daemon default, which is what an
  Isthmus-spawned container actually gets today.

## Provenance

Staged as item 5 in the post-beta backlog ("`security-check`/`doctor`:
report whether a hardened container runtime class (gVisor/Kata) is
configured"), sourced from the agent-security landscape research pass —
GKE Agent Sandbox, Modal and E2B's isolation tiers, and the Hugging Face
incident timeline (https://huggingface.co/blog/agent-intrusion-technical-timeline).

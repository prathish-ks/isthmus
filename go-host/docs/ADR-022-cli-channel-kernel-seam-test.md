# ADR-022: one automated test spans the channel→kernel seam; the live-Docker leg stays separate

**Status**: accepted, implemented as `src/cli-channel-kernel-smoke.test.ts`.

**Context**: this project's evidence for the kernel-mediated path has a
specific, load-bearing hole, and it is not where an outside reader would
guess. It is not that the Go side is untested — `internal/kernel` has EC-05's
adversarial pass, five fuzz targets and a live-Docker CI job. It is that
nothing connects the TypeScript host's own request path to it.

Enumerated, because the hole is only visible once the existing coverage is
laid out side by side:

- `src/host-core.test.ts` proves an inbound channel event becomes a
  `messages_in` row for a resolved session — and asserts the wake as "the
  mocked `wakeContainer` was called". It opens with
  `vi.mock('./container-runner.js')`.
- `src/delivery.test.ts` proves an outbound row reaches a channel adapter —
  a fake one the test registers, not the adapter the message arrived on. It
  also mocks `container-runner`.
- `src/drivers/docker-driver.test.ts` proves the driver composes a spec and
  calls `wake` — on `FakeKernelClient`, an in-memory object, over no socket.
- `src/kernel/client.test.ts` proves the NDJSON envelope contract in both
  directions over a real Unix socket — with no router, no driver and no
  session in front of it.
- `src/channels/cli.test.ts` proves the CLI adapter parses a routed line —
  and never routes it, never delivers, never calls `deliver()`.
- `scripts/p3-06-e2e.sh` and `scripts/ec06-live-smoke.sh` prove the container
  and everything below it, the second one with the kernel genuinely in the
  path. ec06's own header states its boundary: a real channel adapter round
  trip "is TypeScript-host routing/channel infrastructure this proof's scope
  deliberately does not touch."

Every one of those cuts at the same seam, and the seam is the same line of
code: `vi.mock('./container-runner.js')`. The composition step that turns a
routed message into a `SessionSpec` — `spawnContainer`'s
`materializeContainerJson` → `buildMounts` → gateway contribution →
`composeSessionSpec` → `driver.prepare` → `KernelClient.wake` — has no
automated coverage at all from the router's side. A refactor that broke it
would be caught by a human running the host, or not at all.

## Decision

One vitest file, `src/cli-channel-kernel-smoke.test.ts`, spans that seam in
process, with `container-runner.ts` **not** mocked. A line written to the CLI
adapter's real Unix socket is routed by the real router, resolves a real
session, is persisted to a real `inbound.db`, composes a real `SessionSpec`
through the real `DockerSessionDriver` (real `validateSpec`), and reaches a
real `KernelClient` that sends a real NDJSON envelope over a real socket. An
outbound row then travels the real delivery path back out through the same
CLI adapter and arrives on the same connection.

The CLI channel is the subject because it is the only adapter that ships on
trunk and the only one that needs no credentials — `scripts/init-cli-agent.ts`
already seeds exactly its prerequisites, so the test's fixture is that script's
row set and nothing more.

Three things are deliberately not real, and each is a scope decision rather
than a convenience:

1. **The kernel is a recording NDJSON fake**, the same shape
   `src/kernel/client.test.ts` uses. This test's claim is about the *host*:
   that it speaks the protocol correctly and honours the kernel's answer.
   Whether `internal/kernel` **admits** a spec the real host composed is a
   different claim, it is answered on the Go side, and answering it needs a
   real `nanogo serve` and a real Docker daemon. Conflating the two would
   produce a test that fails for two unrelated reasons and diagnoses neither.
2. **The docker binary is `FakeCli`.** After the kernel's `Wake` does
   `create` + `start`, the handle's only remaining docker call is
   `attach --no-stdin <name>` — supervision, not creation. Faking exactly
   that is what lets the whole composition path run with no daemon, which is
   what lets this test live in the ordinary `test` job and gate every PR
   rather than sit in a report-only job nobody reads.
3. **The OneCLI gateway is a no-op stub**, via the `resetGatewayProvider`
   seam the module already declares. A CI runner has no gateway, and
   `spawnContainer` fails closed without one by design.

### The assertion that is doing the real work

`KERNEL_DERIVED_NAME` is deliberately unlike the
`nanoclaw-v2-<folder>-<timestamp>` name `spawnContainer` computes locally, and
the test asserts the host attached to the kernel's name rather than its own.

Writing that assertion turned up a detail worth recording, because the
obvious form of it is wrong: the host's predicted name **does** cross the
wire. It rides as the informational `nanoclaw-container-name` label on the
session. So "the payload contains no host-computed name" is false, and a test
asserting it fails for a correct system. The property that actually holds is
narrower and stronger: the wire session has no *name field* for the kernel to
adopt, the label is a breadcrumb the kernel is free to ignore, and the name
the host subsequently supervises differs from the one it sent. The test
asserts all three, and the last — that the attached name is not the labelled
one — is the one with teeth.

This is EC-02's "never trust a caller-supplied name" property, previously
guaranteed by `internal/kernel/naming.go` and asserted only from inside the
kernel or by a shell harness, now observed from the outside by the host's own
supervision call, on every PR.

## What this deliberately does not do

**It is not the live-Docker leg, and does not close that backlog item.** No
container is created, no agent-runner image runs, no provider replies. A
message does not travel from a terminal to an agent and back in this test;
it travels from a terminal to the kernel boundary and back from the mailbox.
Automating `scripts/ec06-live-smoke.sh` with the TypeScript host in front of
it — a real `nanogo serve`, a real image, a deterministic mock provider, as a
`continue-on-error` job modelled on `go-ec05-live-docker` — remains a
separate, larger piece of work whose cost is dominated by standing up the
agent image in CI, not by the test logic. It stays on the backlog.

**It does not replace `ec06-live-smoke.sh`** in the release-gate checklist.
That script is still the only evidence that a real container is woken by a
real kernel, and `docs/release-gate-checklist.md` still calls for it manually
before each release.

**It proves nothing about any other channel.** Slack, Discord, Telegram and
the rest live on the `channels` branch and are installed by skills; the
registry-skills matrix proves each skill still applies and the composed tree
still builds, which is drift protection, not behaviour. That gap is real and
is recorded as its own backlog item.

## Alternatives rejected

**Run the real `nanogo serve` and let it fail at `docker create`.** Tempting,
because it would make the kernel's admission decision real. Rejected: on a
runner with no agent image the wake is denied for an image reason, so the
test would assert a denial rather than the path, and every future spec change
would be diagnosed through a `docker` error message. The variant that swaps
in a throwaway image (`alpine`) to make `create` succeed proves the kernel
accepts a spec that is not the one the host actually sends. Neither is worth
the daemon dependency in the per-PR job.

**Extend `host-core.test.ts` instead of adding a file.** Rejected: that file
mocks `container-runner` at module scope for all of its ~1500 lines, and the
mock is correct for what it tests. Un-mocking it there would either change
what those tests mean or require a second mock scope in one file — the kind
of shared fixture that makes a later reader unsure which half of the file is
real.

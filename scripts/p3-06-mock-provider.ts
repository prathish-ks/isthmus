// P3-06's deterministic provider.
//
// This file is NOT part of the agent-runner image — it is bind-mounted into
// the container at /workspace/agent/mock-provider.ts by scripts/p3-06-e2e.sh
// and loaded before /app/src/index.ts runs (see that script's docker create
// invocation), so it can register itself with the agent-runner's own
// provider registry (providers/provider-registry.ts) as a brand-new provider
// name — "nanogo-mock" — without editing a single file under /app/src.
//
// Why a new provider, not the shipped one: container/agent-runner/src/
// providers/mock.ts already ships a MockProvider for the agent-runner's own
// unit tests (providers/factory.test.ts), but providers/index.ts — the
// self-registration barrel every provider module relies on — only imports
// claude.js, so 'mock' is never registered in a real running container.
// Even if it were, MockProvider's constructor is invoked by its own
// registerProvider('mock', (opts) => new MockProvider(opts)) call with no
// way to reach the responseFactory/textFactory constructor arguments through
// createProvider()'s single-options-object signature — so there's no way to
// opt a real run into a specific deterministic reply through the shipped
// registration, only through its untestable-from-outside default
// ("Mock response to: ..."), which (see below) would not even get delivered.
//
// Design choice — why this result carries isError: true with no
// <message to="...">...</message> wrapping: poll-loop.ts requires every
// normal reply to be wrapped in a <message to="name"> block addressed to a
// destination the container can resolve, and destinations come from
// inbound.db's `destinations` table — a table only the real TypeScript
// host's session-manager.ts ever populates (before every container wake).
// Writing one ourselves here would mean reimplementing routing/channel
// wiring, which P3-06's own task scope explicitly rules out ("Do not add
// routing/channels"). poll-loop.ts's dispatchResultText/deliverErrorResult
// has exactly one delivery path that needs no destination at all: a
// non-retryable error result (`resultBlocks === 0 && event.isError === true
// && !routing.taskRun`) is delivered straight back using only the ORIGINAL
// inbound message's own routing fields (in_reply_to/platform_id/
// channel_type/thread_id, echoed from the message the Go host wrote) — see
// deliverErrorResult in poll-loop.ts. This is not a workaround invented for
// this proof: it is the exact same path that produced P3-04's real observed
// reply ("Not logged in · Please run /login", a genuine Claude Code SDK
// auth-preflight error). Reusing it here keeps this proof to pure mailbox
// protocol, nothing else — the same scope P3-01 through P3-05 have held
// throughout Phase 3.

import { registerProvider } from '/app/src/providers/provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from '/app/src/providers/types.js';

/**
 * Fixed, timestamp-free reply text. Deterministic by construction — the
 * same inbound message always produces this exact string — so P3-06's own
 * done-when ("a repeated integration test passes") holds without needing to
 * canonicalize a generated id, timestamp, or random continuation the way
 * the differential-testing harness's normalize.ts does for TypeScript-side
 * fixtures (P2-02/P2-03). scripts/p3-06-e2e.sh asserts on this exact string.
 */
export const DETERMINISTIC_REPLY = 'p3-06: deterministic reply from the fake provider';

export class DeterministicMockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  // No mid-turn 'text' events are ever emitted below, so this capability
  // flag has no observable effect either way; false reads correctly as
  // "the result event is this provider's only door."
  readonly emitsMidTurnText = false;

  registerMemorySessionHook(): void {
    // No-op: this proof never resumes a session, so there is nothing for a
    // memory hook to attach to. Mirrors MockProvider's own no-op.
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: QueryInput): AgentQuery {
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: 'p3-06-mock' };
        yield { type: 'activity' };
        // isError: true with zero <message> blocks in the text routes
        // through poll-loop.ts's deliverErrorResult — see file header.
        yield { type: 'result', text: DETERMINISTIC_REPLY, isError: true };
      },
    };

    return {
      push() {
        // No follow-up pushes in this proof; queued messages are ignored.
      },
      end() {},
      events,
      abort() {},
    };
  }
}

registerProvider('nanogo-mock', () => new DeterministicMockProvider());

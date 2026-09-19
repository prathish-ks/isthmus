/**
 * EC-07's deterministic provider — the container half of
 * `scripts/ec07-live-host-smoke.ts`.
 *
 * This file is in the tree but NOT in `providers/index.ts`, exactly like
 * `mock.ts` beside it: the barrel is the only thing that registers a
 * provider, so a production image built from this checkout has this class
 * compiled in and unreachable — `createProvider('livesmoke')` throws
 * "Unknown provider" because nothing ever imported this module. The live
 * smoke harness appends the one import line before its run and removes it
 * afterwards (`scripts/ec07-live-host-smoke.sh`), which is the same
 * mechanism `/add-opencode` uses to install a real provider. Adding it here
 * permanently would ship a fake provider that a `container.json` could
 * select on a real install; gating the barrel on an env var would ship the
 * same reachability behind a flag. Neither belongs in a trust kernel's
 * shipped image, and neither is needed: the harness that wants this
 * provider is also the thing that installs it.
 *
 * Why not reuse `scripts/p3-06-mock-provider.ts`: that file is bind-mounted
 * into the container by a harness that issues `docker create` itself and
 * overrides the entrypoint to import it before `/app/src/index.ts`. With
 * the TypeScript host in front there is no such seam — `composeSessionSpec`
 * hard-codes `exec bun run /app/src/index.ts` and no container-config knob
 * changes it (deliberately: the command is part of what the kernel
 * admits). So the provider has to arrive the way a real provider arrives,
 * through the barrel, which also means relative imports rather than
 * p3-06's absolute `/app/src/...` ones.
 *
 * Why not `mock.ts`: its default `responseFactory` returns
 * "Mock response to: <prompt>" with `isError` unset, which carries no
 * `<message to="...">` block and is not an error result either — so
 * `poll-loop.ts` has no path that delivers it, and `createProvider()`'s
 * single-options-object signature gives a real run no way to reach the
 * `responseFactory` argument. It is a unit-test double, not a deliverable
 * reply.
 */
import { registerProvider } from './provider-registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';

/**
 * Fixed, timestamp-free reply text: the same inbound line always produces
 * this exact string, so the harness asserts equality rather than a shape.
 * `scripts/ec07-live-host-smoke.ts` imports nothing from here (it runs on
 * the host, in a different runtime) and carries its own copy of this
 * string — if you change one, change both; the harness fails loudly with a
 * diff when they disagree.
 */
export const EC07_DETERMINISTIC_REPLY = 'ec07: deterministic reply from the live-smoke provider';

/**
 * `isError: true` with zero `<message to="...">` blocks is the one delivery
 * path in `poll-loop.ts` that needs no entry in the session's
 * `destinations` table: `deliverErrorResult` routes a non-retryable error
 * result straight back on the ORIGINAL inbound message's own routing
 * fields (`in_reply_to` / `platform_id` / `channel_type` / `thread_id`).
 *
 * Destinations are populated by the agent-to-agent module's
 * `writeDestinations()`, which `spawnContainer` calls only when the
 * `agent_destinations` table exists AND has rows for the group — an
 * operator action (`ncl destinations add`), not something a fresh install
 * has. Taking the error path keeps this proof to the mailbox contract plus
 * the host's own routing, with no operator-state prerequisite, and it is
 * the same path that produced P3-04's real observed Claude reply and
 * EC-06's. The `<message to="...">` path is therefore NOT exercised here;
 * ADR-023 records that as a named limit rather than hiding it.
 */
export class Ec07LiveSmokeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  /** No mid-turn `text` events are emitted below, so the result is this provider's only door. */
  readonly emitsMidTurnText = false;

  registerMemorySessionHook(_hook: MemorySessionHookRegistration): void {
    // No-op: this proof never resumes a session, so there is nothing to attach to.
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(_input: QueryInput): AgentQuery {
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: 'ec07-livesmoke' };
        yield { type: 'activity' };
        yield { type: 'result', text: EC07_DETERMINISTIC_REPLY, isError: true };
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

registerProvider('livesmoke', () => new Ec07LiveSmokeProvider());

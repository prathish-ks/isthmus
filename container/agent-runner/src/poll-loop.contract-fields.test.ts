import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import { waitFor } from './test-helpers.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';
import type { ProviderRuntimeContract } from './provider-contracts/registry.js';

// Item 2a (post-v2.4.0-promotion follow-up): poll-loop.ts now prefers a
// provider's resolved `contract.commands.formatting`/`contract.textDelivery`
// over its legacy `supportsNativeSlashCommands`/`emitsMidTurnText` instance
// fields when a contract is present. Every provider below declares its
// LEGACY fields as the OPPOSITE of what its contract (when attached) says —
// so these tests fail unless poll-loop.ts genuinely reads the contract
// rather than always falling through to the instance fields.

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', NULL, ?)`,
    )
    .run(id, JSON.stringify(content));
}

const MID_TURN_CONTRACT: ProviderRuntimeContract = {
  seamVersion: 1,
  configuration: {},
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
};

const NATIVE_COMMANDS_CONTRACT: ProviderRuntimeContract = {
  seamVersion: 1,
  configuration: {},
  textDelivery: 'result',
  commands: { formatting: 'native' },
};

/**
 * A provider whose declared instance fields say the OPPOSITE of what its
 * (optional) contract says. `contract` starts undefined — each test attaches
 * one, or leaves it off to exercise the legacy fallback.
 */
class OverrideProbeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly emitsMidTurnText = false;
  contract?: ProviderRuntimeContract;
  capturedPrompt = '';
  outCountBeforeResult = -1;

  constructor(
    private readonly midTurnBlock?: string,
    private readonly resultText: string = 'ok',
  ) {}

  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.capturedPrompt = input.prompt;
    const midTurnBlock = this.midTurnBlock;
    const resultText = this.resultText;
    const self = this;
    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'init', continuation: 's1' };
        if (midTurnBlock) {
          yield { type: 'text', text: `Let me check.\n${midTurnBlock}` };
          self.outCountBeforeResult = getUndeliveredMessages().length;
        }
        yield { type: 'result', text: resultText };
      },
    };
    return { push: () => {}, end: () => {}, events, abort: () => {} };
  }
}

async function driveOneTurn(provider: AgentProvider, probe: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loopPromise = Promise.race([
    runPollLoop({ provider, providerName: 'contract-test', cwd: '/tmp', signal: controller.signal }),
    new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  ]);
  await waitFor(probe, 2000).finally(() => controller.abort());
  await loopPromise.catch(() => {});
}

describe('poll-loop reads provider.contract over legacy instance fields', () => {
  it('textDelivery: contract mid-turn-complete overrides emitsMidTurnText=false', async () => {
    const block = '<message to="discord-test">The answer is 4.</message>';
    insertMessage('m1', { sender: 'Alice', text: 'What is 2+2?' });
    const provider = new OverrideProbeProvider(block, 'wrapped answer already sent above');
    provider.contract = MID_TURN_CONTRACT;

    await driveOneTurn(provider, () => provider.outCountBeforeResult !== -1);

    // The probe fired between the mid-turn text event and the result event —
    // it already saw the block delivered, which only happens when the
    // mid-turn door is open. The provider's own emitsMidTurnText says false;
    // only the contract's textDelivery explains this.
    expect(provider.outCountBeforeResult).toBe(1);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('The answer is 4.');
  });

  it('textDelivery: no contract falls back to emitsMidTurnText=false (result-door only)', async () => {
    const block = '<message to="discord-test">The answer is 4.</message>';
    insertMessage('m1', { sender: 'Alice', text: 'What is 2+2?' });
    // No contract attached — same block/result shape as above.
    const provider = new OverrideProbeProvider(block, 'wrapped answer already sent above');

    // Nothing will ever deliver (mid-turn text is delivery-inert without the
    // capability, and the plain-text result carries no <message> block) — so
    // there's no delivery signal to wait on; give the single turn a fixed
    // grace period to run to completion instead.
    const controller = new AbortController();
    const loopPromise = Promise.race([
      runPollLoop({ provider, providerName: 'contract-test', cwd: '/tmp', signal: controller.signal }),
      new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    ]);
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await loopPromise.catch(() => {});

    expect(provider.outCountBeforeResult).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('commands.formatting: contract native overrides supportsNativeSlashCommands=false', async () => {
    insertMessage('m1', { sender: 'Alice', text: '/review please' });
    const provider = new OverrideProbeProvider();
    provider.contract = NATIVE_COMMANDS_CONTRACT;

    await driveOneTurn(provider, () => provider.capturedPrompt !== '');

    // Native formatting sends a passthrough command as raw text — no XML
    // <message> wrapping. The provider's own supportsNativeSlashCommands
    // says false; only the contract's commands.formatting explains this.
    expect(provider.capturedPrompt).toContain('/review please');
    expect(provider.capturedPrompt).not.toContain('<message');
  });

  it('commands.formatting: no contract falls back to supportsNativeSlashCommands=false (xml)', async () => {
    insertMessage('m1', { sender: 'Alice', text: '/review please' });
    const provider = new OverrideProbeProvider(); // contract left undefined

    await driveOneTurn(provider, () => provider.capturedPrompt !== '');

    expect(provider.capturedPrompt).toContain('<message');
    expect(provider.capturedPrompt).toContain('/review please');
  });
});

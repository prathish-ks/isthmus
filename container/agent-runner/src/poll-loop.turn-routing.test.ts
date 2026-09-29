import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// Nanoclaw-2.4.0-parity follow-up: `routing` used to be captured once from
// the initial batch and never advanced, even though one processQuery call
// can span many turns queued via query.push() (the underlying MessageStream
// — providers/claude.ts, mirrored by MockProvider — is a strict FIFO: a
// push never injects into an in-flight generation, it queues a genuinely
// separate later turn). A follow-up from a DIFFERENT destination arriving
// while the query is open got its own result handled with the STALE
// initial routing — misrouting a non-retryable error notice (no <message>
// envelope for deliverErrorResult to key on) and the a2a in-reply-to stamp
// to the wrong destination. These tests pin the fix: each turn's own result
// is handled with THAT turn's own routing, not whichever happened to be
// active first.

beforeEach(() => {
  initTestSessionDb();
  seedDest('discord-a', 'discord', 'chan-a');
  seedDest('slack-b', 'slack', 'chan-b');
});

afterEach(() => {
  closeSessionDb();
});

function seedDest(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function insertMessage(id: string, platformId: string, channelType: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, NULL, ?)`,
    )
    .run(id, platformId, channelType, JSON.stringify(content));
}

const ROUTING_A = { platformId: 'chan-a', channelType: 'discord', threadId: null, inReplyTo: 'a1', taskRun: false };
const TASK_ROUTING_A = { platformId: null, channelType: null, threadId: 'system:tasks:ser-1', inReplyTo: 'a1', taskRun: true };

describe('per-turn routing across destinations', () => {
  it("a follow-up turn from a different destination gets its own error delivery, not the stale initial turn's routing", async () => {
    insertMessage('a1', 'chan-a', 'discord', { sender: 'Alice', text: 'hi from A' });

    let pushed = '';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn A closes cleanly (delivered, no retry) before B ever arrives —
      // the realistic, common timing: the query sits idle between turns.
      yield { type: 'result', text: '<message to="discord-a">reply to A</message>' };

      insertMessage('b1', 'chan-b', 'slack', { sender: 'Bob', text: 'hi from B' });
      const deadline = Date.now() + 5000;
      while (!pushed.includes('hi from B') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pushed.includes('hi from B')) throw new Error("poller never pushed B's follow-up within 5s");

      // Turn B: a non-retryable provider error with NO <message> envelope —
      // the sharpest probe for routing correctness, since deliverErrorResult
      // writes directly from `routing.*` with no per-destination lookup.
      yield { type: 'result', text: 'billing_error: payment required', isError: true };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushed = m;
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ROUTING_A, ['a1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();

    const toA = out.find((m) => JSON.parse(m.content).text === 'reply to A');
    expect(toA?.platform_id).toBe('chan-a');
    expect(toA?.channel_type).toBe('discord');

    const toB = out.find((m) => JSON.parse(m.content).text === 'billing_error: payment required');
    expect(toB).toBeDefined();
    expect(toB?.platform_id).toBe('chan-b');
    expect(toB?.channel_type).toBe('slack');
    expect(toB?.in_reply_to).toBe('b1');
  }, 10_000);

  it('same-destination follow-ups keep using the same routing throughout (no spurious advance)', async () => {
    insertMessage('a1', 'chan-a', 'discord', { sender: 'Alice', text: 'first' });

    let pushed = '';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: '<message to="discord-a">reply one</message>' };

      insertMessage('a2', 'chan-a', 'discord', { sender: 'Alice', text: 'second' });
      const deadline = Date.now() + 5000;
      while (!pushed.includes('second') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pushed.includes('second')) throw new Error("poller never pushed the second follow-up within 5s");

      yield { type: 'result', text: 'billing_error: payment required', isError: true };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushed = m;
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ROUTING_A, ['a1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    const errorNotice = out.find((m) => JSON.parse(m.content).text === 'billing_error: payment required');
    expect(errorNotice?.platform_id).toBe('chan-a');
    expect(errorNotice?.channel_type).toBe('discord');
    expect(errorNotice?.in_reply_to).toBe('a2');
  }, 10_000);

  // The prior two tests only exercise the result door (deliverErrorResult),
  // which happens to be exactly where the FIRST version of this fix advanced
  // routing — so they passed even when a follow-up's mid-turn 'text' events
  // (deliverMidTurnBlocks, the door a `textDelivery: 'mid-turn-complete'`
  // provider actually uses) still saw the PREVIOUS turn's routing. These pin
  // the fix at the door that actually matters for that provider shape.

  it("B's own mid-turn text delivery uses B's routing, not A's stale one — B pushed after A already closed", async () => {
    insertMessage('a1', 'chan-a', 'discord', { sender: 'Alice', text: 'first' });

    let pushed = '';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Delivered via a mid-turn text event, with the result repeating it —
      // the documented emitsMidTurnText contract (providers/types.ts: "the
      // SDK result is exactly the last streamed segment"). Delivering
      // mid-turn means the result's repeat is a structural no-op, so A
      // closes cleanly here with no retry.
      yield { type: 'text', text: '<message to="discord-a">reply to A</message>' };
      yield { type: 'result', text: '<message to="discord-a">reply to A</message>' };

      insertMessage('b1', 'chan-b', 'slack', { sender: 'Bob', text: 'hi from B' });
      const deadline = Date.now() + 5000;
      while (!pushed.includes('hi from B') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pushed.includes('hi from B')) throw new Error("poller never pushed B's follow-up within 5s");

      // B delivers via a mid-turn text event, not the result — the door a
      // textDelivery: 'mid-turn-complete' provider actually uses.
      yield { type: 'text', text: '<message to="slack-b">reply to B</message>' };
      yield { type: 'result', text: '<message to="slack-b">reply to B</message>' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushed = m;
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, ROUTING_A, ['a1'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    const toB = out.find((m) => JSON.parse(m.content).text === 'reply to B');
    expect(toB).toBeDefined();
    expect(toB?.platform_id).toBe('chan-b');
    expect(toB?.channel_type).toBe('slack');
  }, 10_000);

  it("B pushed WHILE A is still answering: B's own mid-turn text still uses B's (chat) routing, not A's (task) one", async () => {
    // A is a task turn and B is a chat turn so a stale routing.taskRun is an
    // unambiguous, hard failure: deliverMidTurnBlocks returns immediately
    // (delivers nothing) whenever routing.taskRun is true, so if B's text
    // event is still processed under A's routing, this asserts on an empty
    // outbox rather than a misrouted destination — the sharpest possible
    // probe, and the exact shape an external review flagged as uncovered.
    let pushed = '';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };

      // B arrives while A is still generating (no result yet) — the poller
      // must queue it, not adopt it immediately, since A is still answering.
      insertMessage('b1', 'chan-b', 'slack', { sender: 'Bob', text: 'hi from B' });
      const deadline = Date.now() + 5000;
      while (!pushed.includes('hi from B') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!pushed.includes('hi from B')) throw new Error("poller never pushed B's follow-up within 5s");

      // NOW close A — routing must advance to B's (chat) routing here,
      // before B's own text event below, not at B's own result.
      yield { type: 'result', text: 'task A done' };

      yield { type: 'text', text: '<message to="slack-b">reply to B</message>' };
      yield { type: 'result', text: '' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushed = m;
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, TASK_ROUTING_A, ['a1'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    const toB = out.find((m) => JSON.parse(m.content).text === 'reply to B');
    expect(toB).toBeDefined();
    expect(toB?.platform_id).toBe('chan-b');
    expect(toB?.channel_type).toBe('slack');
  }, 10_000);
});

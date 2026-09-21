/**
 * PERF-GATE: bounds the container-side mailbox's per-cycle cost — a
 * writeMessageOut (agent reply) followed by a getPendingMessages poll (the
 * agent-runner's own poll loop checking for new inbound work), the pair
 * every agent-runner iteration pays. getPendingMessages opens/closes a
 * fresh bun:sqlite connection per call outside test mode (see
 * connection.ts's own doc comment: "Cost is microseconds per query, so
 * safe for universal use") — this test is the thing that verifies that
 * claim rather than just asserting it in a comment. Picked up by the CI
 * `performance-gate` job (.github/workflows/ci.yml), which greps both
 * src/ and container/agent-runner/src/ for this tag.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './connection.js';
import { SqliteAgentMailbox } from './index.js';

afterEach(() => closeSessionDb());

describe('mailbox write+poll performance budget', () => {
  test('stays within budget across repeated write-then-poll cycles', async () => {
    initTestSessionDb();
    const mailbox = new SqliteAgentMailbox();
    await mailbox.start({ agentGroupId: 'agent', sessionId: 'session', mailbox: null });

    const iterations = 200;
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
      await mailbox.writeMessageOut({
        id: `out-${i}`,
        inReplyTo: null,
        deliverAfter: null,
        recurrence: null,
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"hello"}',
      });
      mailbox.getPendingMessages(10, false);
    }
    const elapsed = Date.now() - start;

    // PERF-RESULT is a fixed-format marker (see .github/workflows/ci.yml's
    // performance-gate job) that the CI report step greps out of raw test
    // output to build a human-readable results-vs-budget table on the run
    // summary page — keep the "name=" / "elapsed_ms=" / "budget_ms="
    // fields exactly as shown if this line is ever edited.
    const budgetMs = 100;
    console.log(`PERF-RESULT: name="Bun container: mailbox write+poll" elapsed_ms=${elapsed} budget_ms=${budgetMs}`);

    // Real CI measurement (2026-09-20, github-actions ubuntu-latest,
    // performance-gate job): 16ms for 200 cycles — the number this budget
    // is actually tuned against. This sandbox's own dev-machine runs (Mac,
    // Docker Desktop's VM layer nearby but unrelated to this pure
    // bun:sqlite path) ranged 40-120ms, meaningfully slower than the real
    // CI runner. 100ms gives ~6.25x headroom over the real CI baseline —
    // comfortable there, but tight enough that a slow local Mac run could
    // occasionally approach it; that's expected, CI is what this budget is
    // tuned for.
    expect(elapsed).toBeLessThan(budgetMs);
  }, 20000);
});

/**
 * TC-03 — a remembered preference surviving into a NEW session, replayed from
 * a live capture (2026-10-14).
 *
 * TC-03's mechanism is covered elsewhere, each claim where it belongs:
 *   survives the lifecycle  memory/scaffold.test.ts — "is idempotent and
 *       never clobbers the agent edits"
 *   reaches the agent       memory/context.test.ts (existing memory inlined),
 *       memory/session-hook.test.ts (injected at startup/clear/compact)
 *   stays in its own scope  container memory is at a FIXED path, so which
 *       agent's memory a container sees is a host MOUNT decision — tested with
 *       negative controls in mount-composition.test.ts:178 and
 *       drivers/conformance.test.ts:241
 *
 * This file covers what none of those can: the round trip the test case
 * actually describes. Told "remember X", does the agent WRITE it — and does a
 * session sharing nothing but the directory read it back? Model behaviour on
 * both ends.
 *
 * The capture used ONE shared cwd for two scenarios, driving the production
 * scaffold and the production memory renderer, with no `resume` token. Two
 * facts in the fixture make "a genuinely new session" checkable rather than
 * asserted: the two turns report DIFFERENT session_ids, and mem02's
 * memory-before snapshot equals mem01's memory-after. Disk is the only channel
 * between them.
 *
 * Re-capture (needs real auth):
 *   cd container/agent-runner
 *   bun scripts/sdk-capture/run-memory-battery.ts
 *   bun scripts/sdk-capture/extract-memory-fixtures.ts
 */
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { processQuery } from '../poll-loop.js';

import recordings from './__fixtures__/sdk-memory-recordings.json';

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { claudeRuntimeContract } = await import('../provider-contracts/claude.js');
const { resolveRuntimeConfiguration } = await import('../provider-contracts/realize.js');
const TEST_CONFIGURATION = resolveRuntimeConfiguration(claudeRuntimeContract, {});

interface Fixture {
  gist: string;
  sections: string[];
  capturedAt: string;
  harnessError: string | null;
  memoryBefore: string[];
  memoryAfter: Record<string, string>;
  storedSomewhere: boolean;
  recalledInReply: boolean;
  messages: Array<{
    type?: string;
    subtype?: string;
    session_id?: string;
    message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
  }>;
}

const FIXTURES = recordings as unknown as Record<string, Fixture>;
const STORE = 'mem01-store';
const RECALL = 'mem02-recall-fresh-session';
const SECTIONS = ['Summary', 'Risks', 'Actions'];

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
  failureNoticeWake: false,
};

let tmp: string;
let prevHome: string | undefined;

function seedDestination(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-recorded-memory-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  seedDestination();
});

afterEach(() => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sessionIdOf(id: string): string | undefined {
  return FIXTURES[id].messages.find((m) => m.type === 'system' && m.subtype === 'init')?.session_id;
}

async function deliver(id: string): Promise<string[]> {
  sdkMessages.length = 0;
  sdkMessages.push(...FIXTURES[id].messages);
  const provider = new ClaudeProvider({}, TEST_CONFIGURATION);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'hi', cwd: tmp });
  await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
}

describe('both turns captured cleanly', () => {
  it('has the two scenarios and no harness error', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([STORE, RECALL].sort());
    expect(FIXTURES[STORE].harnessError).toBeNull();
    expect(FIXTURES[RECALL].harnessError).toBeNull();
  });

  it('delivers exactly one message per turn', async () => {
    for (const id of [STORE, RECALL]) {
      expect(await deliver(id)).toHaveLength(1);
      closeSessionDb();
      initTestSessionDb();
      seedDestination();
    }
  });
});

describe('mem01 — told to remember the preference', () => {
  it('started from the bare production scaffold', () => {
    // Nothing pre-planted: the preference file cannot already exist, or the
    // write below would prove nothing.
    expect(FIXTURES[STORE].memoryBefore).toEqual(['index.md', 'system/definition.md', 'system/index.md']);
  });

  it('wrote the preference into a new memory file', () => {
    expect(FIXTURES[STORE].storedSomewhere).toBe(true);
    const added = Object.keys(FIXTURES[STORE].memoryAfter).filter((f) => !FIXTURES[STORE].memoryBefore.includes(f));
    expect(added).toContain('preferences/weekly-report-format.md');
  });

  it('the stored file names all three sections', () => {
    const body = FIXTURES[STORE].memoryAfter['preferences/weekly-report-format.md'];
    for (const section of SECTIONS) expect(body).toContain(section);
  });

  it('followed the memory system definition rather than dumping a loose note', () => {
    // The scaffold's definition.md requires OKF frontmatter with a `type`, and
    // an index entry. Both are evidence the agent read the definition it was
    // given, not just that it wrote a file somewhere.
    const body = FIXTURES[STORE].memoryAfter['preferences/weekly-report-format.md'];
    expect(body.startsWith('---')).toBe(true);
    expect(body).toContain('type:');
    expect(Object.keys(FIXTURES[STORE].memoryAfter)).toContain('preferences/index.md');
  });
});

describe('mem02 — a fresh session asked for the preference', () => {
  it('really was a different session', () => {
    // No `resume` was passed; the SDK confirms it by reporting a different id.
    const first = sessionIdOf(STORE);
    const second = sessionIdOf(RECALL);
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('began with exactly the memory the previous session left behind', () => {
    // The decisive link: disk is the only thing shared between the two turns.
    expect(FIXTURES[RECALL].memoryBefore).toEqual(Object.keys(FIXTURES[STORE].memoryAfter).sort());
  });

  it('recalled all three sections, in order, to the channel', async () => {
    expect(FIXTURES[RECALL].recalledInReply).toBe(true);
    const [delivered] = await deliver(RECALL);
    const positions = SECTIONS.map((s) => delivered.indexOf(s));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('answered from memory rather than guessing — it went and looked', () => {
    const reads = FIXTURES[RECALL].messages
      .filter((m) => m.type === 'assistant')
      .flatMap((m) => m.message?.content ?? [])
      .filter((b) => b.type === 'tool_use')
      .map((b) => JSON.stringify(b.input ?? {}));
    expect(reads.some((r) => r.includes('weekly-report-format'))).toBe(true);
  });

  it('left the memory tree unchanged — a read is not a write', () => {
    expect(Object.keys(FIXTURES[RECALL].memoryAfter).sort()).toEqual(FIXTURES[RECALL].memoryBefore);
  });
});

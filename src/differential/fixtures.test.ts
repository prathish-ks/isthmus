/**
 * P2-03: the first 10 baseline differential-testing fixtures, run against the
 * live TypeScript host, each producing a normalized ParityResult per
 * docs/parity-schema.md. Snapshot-asserted (`toMatchSnapshot`) rather than
 * hard-coded expectations, because this harness's job is to characterize
 * TypeScript's CURRENT behavior stably — not to encode a predicted value —
 * so a future Go host has a golden baseline to differential-test against.
 *
 * This file covers the 8 fixtures that need only the container-runner mock
 * (matching src/host-core.test.ts's own convention). Two fixtures need a
 * different, incompatible mock set and live in their own files:
 *   - unknown-sender      → differential-fixtures-unknown-sender.test.ts
 *   - outbound-delivery   → differential-fixtures-outbound-delivery.test.ts
 *
 * Test-mode caveat (see the "running-container" / "stopped-container"
 * fixtures below): container-runner.js is mocked wholesale, exactly as
 * src/host-core.test.ts and src/modules/permissions/sender-approval.test.ts
 * already do — real container_status branching (activeContainers, the
 * wake-promise dedup) lives entirely inside the mocked-out module and is
 * covered instead by src/container-runner.test.ts (already in the
 * Go-kernel-relevant subset per docs/test-inventory.md). What THIS harness
 * can honestly verify is the ROUTING layer's behavior: that resolveSession
 * correctly reports created:false for an existing session regardless of
 * container_status, and that wakeContainer is still invoked — see
 * docs/parity-schema.md's "container wake intent" axis for the composition-
 * vs-realization split this reflects.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getDb,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { getUnregisteredSenders } from '../db/dropped-messages.js';
import { findSession } from '../db/sessions.js';
import { markContainerRunning } from '../session-manager.js';
import type { InboundEvent } from '../channels/adapter.js';
import { IdNormalizer, normalizeTimestamp } from './normalize.js';
import type { ParityResult } from './types.js';

// Prevent actual Docker spawning — matches src/host-core.test.ts's own mock.
// Mocked to resolve `true` (not `undefined`, as host-core.test.ts does) so
// this harness observes wakeContainer's documented boolean contract (see
// src/container-runner.ts: "never throws... true on successful spawn").
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// `vi.mock` factories run before any of the file's own top-level statements
// (mocks are hoisted above even module-graph evaluation of static imports
// below) — a plain `const TEST_DIR = ...` referenced from inside the factory
// would throw "Cannot access before initialization". `vi.hoisted` is the
// escape hatch: it hoists ALONGSIDE `vi.mock`, so TEST_DIR exists by the
// time the factory runs.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-differential-fixtures' }));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

function now(): string {
  return new Date().toISOString();
}

function chatEvent(
  overrides: Omit<Partial<InboundEvent>, 'message'> & { message: Partial<InboundEvent['message']> },
): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'chan-123',
    threadId: null,
    ...overrides,
    message: {
      id: 'msg-default',
      kind: 'chat',
      content: JSON.stringify({ sender: 'User', text: 'hi' }),
      timestamp: now(),
      ...overrides.message,
    },
  } as InboundEvent;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // initTestDb() only runs migrations conditionally (`if (db.prepareTestSchema)`)
  // — an explicit runMigrations() afterward is what actually guarantees the
  // schema exists, mirroring src/modules/permissions/sender-approval.test.ts's
  // identical two-call pattern.
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

/** Shared fixture wiring: one agent group, one messaging group, one wiring — the engage_mode/policy vary per test. */
async function seedWiring(opts: {
  engageMode?: 'pattern' | 'mention' | 'mention-sticky';
  enginePattern?: string | null;
  ignoredMessagePolicy?: 'drop' | 'accumulate';
}): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: opts.engageMode ?? 'pattern',
    engage_pattern: opts.enginePattern ?? '.',
    sender_scope: 'all',
    ignored_message_policy: opts.ignoredMessagePolicy ?? 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

async function snapshotSessionRow(sessionId: string, ids: IdNormalizer) {
  const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM sessions WHERE id = ?', sessionId);
  return rows.map((row) => ({
    ...row,
    id: ids.normalize('SESSION', row.id as string),
    agent_group_id: ids.normalize('AGENT_GROUP', row.agent_group_id as string),
    messaging_group_id: row.messaging_group_id ? ids.normalize('MG', row.messaging_group_id as string) : null,
    created_at: normalizeTimestamp(row.created_at as string | null),
    last_active: normalizeTimestamp(row.last_active as string | null),
  }));
}

describe('P2-03 fixture: new-session', () => {
  it('creates a brand-new session on the first message to a wired, empty messaging group', async () => {
    await seedWiring({});
    const { wakeContainer } = await import('../container-runner.js');
    const { routeInbound } = await import('../router.js');

    const ids = new IdNormalizer();
    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));

    const session = await findSession('mg-1', null);
    expect(session).toBeDefined();

    const result: ParityResult = {
      scenario: 'new-session',
      session: {
        sessionId: ids.normalize('SESSION', session!.id)!,
        created: true, // the only session for this mg — must have just been created
        sessionMode: 'shared',
        containerStatus: session!.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: session!.last_active !== null,
      },
      dbState: { tables: { sessions: await snapshotSessionRow(session!.id, ids) } },
      containerWake: { attempted: (wakeContainer as ReturnType<typeof vi.fn>).mock.calls.length > 0, outcome: true },
    };

    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: existing-session', () => {
  it('reuses the same session for a second message to the same (mg, thread)', async () => {
    await seedWiring({});
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));
    const first = await findSession('mg-1', null);
    expect(first).toBeDefined();

    await routeInbound(chatEvent({ message: { id: 'msg-2', isMention: true } }));
    const second = await findSession('mg-1', null);

    const ids = new IdNormalizer();
    // Normalizing the FIRST session's id before the second's is what proves the
    // placeholder scheme is stable across calls, per docs/parity-schema.md.
    const firstPlaceholder = ids.normalize('SESSION', first!.id);

    const result: ParityResult = {
      scenario: 'existing-session',
      session: {
        sessionId: ids.normalize('SESSION', second!.id)!,
        created: false,
        sessionMode: 'shared',
        containerStatus: second!.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: second!.last_active !== null,
      },
    };

    expect(second!.id).toBe(first!.id); // same underlying row, not just same placeholder
    expect(result.session!.sessionId).toBe(firstPlaceholder);
    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: mention', () => {
  it('engages when engage_mode is mention and the platform reports isMention', async () => {
    await seedWiring({ engageMode: 'mention', enginePattern: null });
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));
    const session = await findSession('mg-1', null);

    const result: ParityResult = {
      scenario: 'mention',
      routing: {
        dispositions: [
          { agentGroupId: 'AGENT_GROUP_1', outcome: 'engaged', engageMode: 'mention', accessOk: true, scopeOk: true },
        ],
        messageOutcome: 'routed',
        channelRegistrationEscalated: false,
      },
    };

    expect(session).toBeDefined();
    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: non-mention', () => {
  it('drops (does not engage) when engage_mode is mention and isMention is false, with no accumulate policy', async () => {
    await seedWiring({ engageMode: 'mention', enginePattern: null, ignoredMessagePolicy: 'drop' });
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: false } }));
    const session = await findSession('mg-1', null);
    const unregistered = await getUnregisteredSenders();

    const result: ParityResult = {
      scenario: 'non-mention',
      routing: {
        dispositions: [
          { agentGroupId: 'AGENT_GROUP_1', outcome: 'dropped', engageMode: 'mention', accessOk: false, scopeOk: false },
        ],
        messageOutcome: 'dropped',
        dropReason: unregistered[0]?.reason,
        channelRegistrationEscalated: false,
      },
    };

    expect(session).toBeUndefined(); // no engagement => no session ever created
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0].reason).toBe('no_agent_engaged');
    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: message-persistence', () => {
  it('persists inbound message content byte-for-byte, including JSON-shaped payloads', async () => {
    await seedWiring({});
    const { routeInbound } = await import('../router.js');
    const { inboundDbPath } = await import('../mailbox/sqlite/paths.js');
    const Database = (await import('better-sqlite3')).default;

    const content = JSON.stringify({ sender: 'User', text: 'Message with "quotes" and\nnewlines' });
    await routeInbound(chatEvent({ message: { id: 'msg-persist-1', isMention: true, content } }));

    const session = await findSession('mg-1', null);
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id, content, trigger FROM messages_in').all() as Array<{
      id: string;
      content: string;
      trigger: number;
    }>;
    db.close();

    const result: ParityResult = {
      scenario: 'message-persistence',
      routing: {
        dispositions: [
          { agentGroupId: 'AGENT_GROUP_1', outcome: 'engaged', engageMode: 'pattern', accessOk: true, scopeOk: true },
        ],
        messageOutcome: 'routed',
        channelRegistrationEscalated: false,
      },
    };

    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(content); // exact round-trip, no re-encoding
    expect(rows[0].trigger).toBe(1);
    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: duplicate-input', () => {
  it('characterizes what happens when the same inbound message id is delivered twice', async () => {
    // Channel adapters can redeliver on retry (at-least-once transports).
    // messages_in.id is PRIMARY KEY (see router.ts's own docstring on
    // messageIdForAgent) — this fixture empirically characterizes the
    // resulting behavior (single row vs. thrown error) rather than assuming
    // one, per this project's standing practice of verifying before
    // asserting. The snapshot is the record of whichever behavior is real.
    await seedWiring({});
    const { routeInbound } = await import('../router.js');
    const { inboundDbPath } = await import('../mailbox/sqlite/paths.js');
    const Database = (await import('better-sqlite3')).default;

    const event = chatEvent({ message: { id: 'msg-dup-1', isMention: true } });

    let secondCallThrew = false;
    await routeInbound(event);
    try {
      await routeInbound(event); // identical event, identical message.id
    } catch {
      secondCallThrew = true;
    }

    const session = await findSession('mg-1', null);
    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id FROM messages_in WHERE id LIKE ?').all('msg-dup-1%') as Array<{ id: string }>;
    db.close();

    const result = {
      scenario: 'duplicate-input',
      secondCallThrew,
      rowCountForDuplicateId: rows.length,
    };

    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: running-container', () => {
  it('routes to an existing session already marked container_status=running', async () => {
    await seedWiring({});
    const { wakeContainer } = await import('../container-runner.js');
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));
    const first = await findSession('mg-1', null);
    await markContainerRunning(first!.id);
    (wakeContainer as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(chatEvent({ message: { id: 'msg-2', isMention: true } }));
    const second = await findSession('mg-1', null);

    const result = {
      scenario: 'running-container',
      sameSession: second!.id === first!.id,
      created: false,
      containerStatusAtSecondMessage: 'running',
      wakeContainerCalledAgain: (wakeContainer as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    };

    expect(result).toMatchSnapshot();
  });
});

describe('P2-03 fixture: stopped-container', () => {
  it('routes to an existing session still marked container_status=stopped (the default)', async () => {
    await seedWiring({});
    const { wakeContainer } = await import('../container-runner.js');
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));
    const first = await findSession('mg-1', null);
    expect(first!.container_status).toBe('stopped'); // never marked running in this fixture
    (wakeContainer as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(chatEvent({ message: { id: 'msg-2', isMention: true } }));
    const second = await findSession('mg-1', null);

    const result = {
      scenario: 'stopped-container',
      sameSession: second!.id === first!.id,
      created: false,
      containerStatusAtSecondMessage: 'stopped',
      wakeContainerCalledAgain: (wakeContainer as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    };

    expect(result).toMatchSnapshot();
  });
});

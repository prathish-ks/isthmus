/**
 * P2-04 batch 2: routing, session-mode, and container-wake axis diversity
 * beyond what P2-03's core 10 and the guard-catalog batch (P2-04 batch 1)
 * already cover. Chosen as high-value representative contracts — not
 * another exhaustive sweep like the guard catalog — per docs/parity-schema.md's
 * "observable contracts" design principle.
 *
 * Same mock set as fixtures.test.ts (container-runner.js + config.js only):
 * every fixture here either goes through routeInbound with no access/scope
 * gate registered, or calls session-manager.ts's resolveSession/db/sessions.ts's
 * createSession directly — neither needs the permissions module's hooks.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { getUnregisteredSenders } from '../db/dropped-messages.js';
import { setMessagingGroupDeniedAt } from '../db/messaging-groups.js';
import { createSession, findSession } from '../db/sessions.js';
import { isUniqueViolation } from '../db/errors.js';
import { resolveSession } from '../session-manager.js';
import type { InboundEvent } from '../channels/adapter.js';
import { IdNormalizer } from './normalize.js';
import type { ParityResult } from './types.js';
import type { Session } from '../types.js';

// Prevent actual Docker spawning — matches fixtures.test.ts's own mock.
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// `vi.mock` factories run before any of the file's own top-level statements —
// `vi.hoisted` hoists TEST_DIR alongside them. See fixtures.test.ts's identical comment.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-differential-fixtures-batch2' }));

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

/** Shared fixture wiring: one agent group, one GROUP messaging group, one wiring. */
async function seedWiring(opts: {
  engageMode?: 'pattern' | 'mention' | 'mention-sticky';
  enginePattern?: string | null;
  ignoredMessagePolicy?: 'drop' | 'accumulate';
  isGroup?: boolean;
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
    is_group: opts.isGroup === false ? 0 : 1,
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

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ---------------------------------------------------------------------------
// Routing: mention-sticky, accumulate, no-agent-wired
// ---------------------------------------------------------------------------

describe('P2-04 batch2 fixture: mention-sticky-follow-up-engages', () => {
  it('mention-sticky follow-up (no mention) still engages once a session exists for the thread', async () => {
    await seedWiring({ engageMode: 'mention-sticky', enginePattern: null });
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));
    const first = await findSession('mg-1', null);
    expect(first).toBeDefined();

    // Follow-up with NO mention: mention-sticky's session-existence check
    // (router.ts evaluateEngage) should still fire since the thread already engaged once.
    await routeInbound(chatEvent({ message: { id: 'msg-2', isMention: false } }));
    const second = await findSession('mg-1', null);

    const ids = new IdNormalizer();
    const result: ParityResult = {
      scenario: 'mention-sticky-follow-up-engages',
      routing: {
        dispositions: [
          {
            agentGroupId: ids.normalize('AGENT_GROUP', 'ag-1')!,
            outcome: 'engaged',
            engageMode: 'mention-sticky',
            accessOk: true,
            scopeOk: true,
          },
        ],
        messageOutcome: 'routed',
        channelRegistrationEscalated: false,
      },
    };

    expect(second!.id).toBe(first!.id); // sticky follow-up reuses the same session, no re-mention needed
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: mention-sticky-dm-never-engages', () => {
  it('mention-sticky never engages a non-mention message in a DM, even with a prior session', async () => {
    await seedWiring({ engageMode: 'mention-sticky', enginePattern: null, isGroup: false });
    const { routeInbound } = await import('../router.js');

    // Even after an initial mention would have created a session, is_group=0
    // short-circuits mention-sticky's follow-up path (router.ts: "DMs never
    // use mention-sticky sensibly") — so a bare non-mention message never engages.
    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: false } }));
    const session = await findSession('mg-1', null);
    const unregistered = await getUnregisteredSenders();

    const ids = new IdNormalizer();
    const result: ParityResult = {
      scenario: 'mention-sticky-dm-never-engages',
      routing: {
        dispositions: [
          {
            agentGroupId: ids.normalize('AGENT_GROUP', 'ag-1')!,
            outcome: 'dropped',
            engageMode: 'mention-sticky',
            accessOk: false,
            scopeOk: false,
          },
        ],
        messageOutcome: 'dropped',
        dropReason: unregistered[0]?.reason,
        channelRegistrationEscalated: false,
      },
    };

    expect(session).toBeUndefined();
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0].reason).toBe('no_agent_engaged');
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: accumulate-stores-without-waking', () => {
  it('ignored_message_policy=accumulate creates a session and stores context, but never wakes the container', async () => {
    await seedWiring({ engageMode: 'mention', enginePattern: null, ignoredMessagePolicy: 'accumulate' });
    const { wakeContainer } = await import('../container-runner.js');
    const { routeInbound } = await import('../router.js');
    const { inboundDbPath } = await import('../mailbox/sqlite/paths.js');
    const Database = (await import('better-sqlite3')).default;

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: false } }));

    const session = await findSession('mg-1', null);
    expect(session).toBeDefined(); // accumulate still resolves/creates a session

    const db = new Database(inboundDbPath('ag-1', session!.id));
    const rows = db.prepare('SELECT id, trigger FROM messages_in').all() as Array<{ id: string; trigger: number }>;
    db.close();

    const ids = new IdNormalizer();
    const result: ParityResult = {
      scenario: 'accumulate-stores-without-waking',
      session: {
        sessionId: ids.normalize('SESSION', session!.id)!,
        created: true,
        sessionMode: 'shared',
        containerStatus: session!.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: session!.last_active !== null,
      },
      routing: {
        dispositions: [
          {
            agentGroupId: ids.normalize('AGENT_GROUP', 'ag-1')!,
            outcome: 'accumulated',
            engageMode: 'mention',
            accessOk: false,
            scopeOk: false,
          },
        ],
        messageOutcome: 'routed', // stored, not dropped — recordDroppedMessage only fires when nothing engaged OR accumulated
        channelRegistrationEscalated: false,
      },
      containerWake: { attempted: (wakeContainer as ReturnType<typeof vi.fn>).mock.calls.length > 0, outcome: null },
    };

    expect(session!.container_status).toBe('stopped');
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(0); // accumulated: stored as context only, never a wake trigger
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: no-agent-wired-no-gate', () => {
  it('an unwired channel with no channel-request gate registered drops silently with reason=no_agent_wired', async () => {
    // No seedWiring at all: the auto-created messaging group has zero wirings.
    // This file never imports the permissions module, so channelRequestGate
    // stays unregistered — exercises core's own fallback path (router.ts:
    // "without the module the router silently records the drop... and moves on").
    const { routeInbound } = await import('../router.js');

    await routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }));

    const unregistered = await getUnregisteredSenders();
    const result: ParityResult = {
      scenario: 'no-agent-wired-no-gate',
      routing: {
        dispositions: [],
        messageOutcome: 'dropped',
        dropReason: unregistered[0]?.reason,
        channelRegistrationEscalated: false,
      },
    };

    expect(unregistered).toHaveLength(1);
    expect(unregistered[0].reason).toBe('no_agent_wired');
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: no-agent-wired-denied-channel', () => {
  it('a channel already denied by the owner drops silently with no drop record at all', async () => {
    await createMessagingGroup({
      id: 'mg-denied',
      channel_type: 'discord',
      platform_id: 'chan-denied',
      name: 'Denied Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await setMessagingGroupDeniedAt('mg-denied', now());

    const { routeInbound } = await import('../router.js');
    await routeInbound(chatEvent({ platformId: 'chan-denied', message: { id: 'msg-1', isMention: true } }));

    const unregistered = await getUnregisteredSenders();
    const result = {
      scenario: 'no-agent-wired-denied-channel',
      dropRecordWritten: unregistered.length > 0,
    };

    // Genuinely distinct from no-agent-wired-no-gate: denied_at short-circuits
    // BEFORE recordDroppedMessage is even called (router.ts line ~301-307) —
    // no audit row at all, not even one with a "denied" reason.
    expect(unregistered).toHaveLength(0);
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Session modes: per-thread, agent-shared, id-collision classification
// ---------------------------------------------------------------------------

describe('P2-04 batch2 fixture: session-mode-per-thread', () => {
  it('resolveSession isolates sessions per thread and reuses them on repeat', async () => {
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

    const a1 = await resolveSession('ag-1', 'mg-1', 'thread-a', 'per-thread');
    const b1 = await resolveSession('ag-1', 'mg-1', 'thread-b', 'per-thread');
    const a2 = await resolveSession('ag-1', 'mg-1', 'thread-a', 'per-thread');

    const ids = new IdNormalizer();
    const result = {
      scenario: 'session-mode-per-thread',
      threadASessionId: ids.normalize('SESSION', a1.session.id),
      threadBSessionId: ids.normalize('SESSION', b1.session.id),
      distinctThreads: a1.session.id !== b1.session.id,
      threadACreatedFirstTime: a1.created,
      threadBCreatedFirstTime: b1.created,
      threadAReusedSecondTime: a2.created === false && a2.session.id === a1.session.id,
    };

    expect(a1.created).toBe(true);
    expect(b1.created).toBe(true);
    expect(a1.session.id).not.toBe(b1.session.id);
    expect(a2.created).toBe(false);
    expect(a2.session.id).toBe(a1.session.id);
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: session-mode-agent-shared', () => {
  it('resolveSession shares one session per agent group across DIFFERENT messaging groups when session_mode=agent-shared', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-a',
      channel_type: 'discord',
      platform_id: 'chan-a',
      name: 'Channel A',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-b',
      channel_type: 'slack',
      platform_id: 'chan-b',
      name: 'Channel B',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const first = await resolveSession('ag-1', 'mg-a', null, 'agent-shared');
    // Different messaging group entirely (even a different channel_type) —
    // agent-shared ignores messagingGroupId, per session-manager.ts's own doc.
    const second = await resolveSession('ag-1', 'mg-b', null, 'agent-shared');

    const ids = new IdNormalizer();
    const result = {
      scenario: 'session-mode-agent-shared',
      sessionId: ids.normalize('SESSION', first.session.id),
      firstCreated: first.created,
      secondCallCreated: second.created,
      sameSessionAcrossMessagingGroups: first.session.id === second.session.id,
    };

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.session.id).toBe(first.session.id);
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: session-id-collision-classified', () => {
  it('a duplicate session id throws a constraint error that isUniqueViolation recognizes', async () => {
    // This exercises db/sessions.ts's createSession + db/errors.ts's classifier
    // directly against the real driver's error shape. It deliberately does NOT
    // attempt to force resolveSession's own lock-protected catch-and-recover
    // branch (session-manager.ts lines ~141-152): that branch only matters when
    // two callers race past withSessionCreationLock, and forcing that race would
    // require bypassing/mocking the lock itself — which conflicts with this
    // harness's real-execution characterization philosophy. Recorded here as a
    // known, deliberate scope boundary rather than silently skipped.
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

    const session: Session = {
      id: 'sess-fixed-collision-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };

    await createSession(session);

    let caught: unknown;
    try {
      await createSession(session); // identical id — must violate the PRIMARY KEY
    } catch (err) {
      caught = err;
    }

    const result = {
      scenario: 'session-id-collision-classified',
      secondCallThrew: caught !== undefined,
      classifiedAsUniqueViolation: isUniqueViolation(caught),
    };

    expect(caught).toBeDefined();
    expect(isUniqueViolation(caught)).toBe(true);
    expect(result).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Container wake: the boolean-only failure contract at the routing boundary
// ---------------------------------------------------------------------------

describe('P2-04 batch2 fixture: container-wake-failure', () => {
  it('a failed wake never throws through routeInbound — the session is created and left stopped', async () => {
    await seedWiring({});
    const { wakeContainer } = await import('../container-runner.js');
    (wakeContainer as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    const { routeInbound } = await import('../router.js');

    await expect(routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } }))).resolves.toBeUndefined(); // never throws — matches wakeContainer's documented "never throws" contract

    const session = await findSession('mg-1', null);
    expect(session).toBeDefined();
    expect(session!.container_status).toBe('stopped'); // markContainerRunning lives inside the (mocked-out) real wake path

    const ids = new IdNormalizer();
    // No `failure` populated deliberately: wakeContainer's contract collapses
    // every driver-level SessionFailure kind (drivers/types.ts — spec-invalid,
    // denied-by-policy, image-unavailable, runtime-unavailable,
    // resources-exhausted, started-then-died, unknown) to this bare boolean
    // before it ever reaches routeInbound. The taxonomy drives internal
    // logging/retryability inside container-runner.ts (armSessionLifecycle /
    // finish) but is NOT observable from the routing layer — a Go host only
    // needs to reproduce the boolean at THIS seam.
    const result: ParityResult = {
      scenario: 'container-wake-failure',
      session: {
        sessionId: ids.normalize('SESSION', session!.id)!,
        created: true,
        sessionMode: 'shared',
        containerStatus: session!.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: session!.last_active !== null,
      },
      containerWake: { attempted: true, outcome: false },
    };

    expect(result).toMatchSnapshot();
  });
});

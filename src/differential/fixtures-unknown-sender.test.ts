/**
 * P2-03 fixture: unknown-sender.
 *
 * Separated from fixtures.test.ts because this scenario needs a different,
 * incompatible mock set: the permissions module (registered as a side-effect
 * import) needs `delivery.js` mocked to capture the approval-card send and
 * `modules/permissions/user-dm.js` mocked to avoid a real openDM RPC — see
 * src/modules/permissions/sender-approval.test.ts, whose mock setup this
 * fixture mirrors verbatim (container-runner.js, delivery.js, user-dm.js,
 * then a side-effect `await import('../modules/permissions/index.js')` to
 * register the module's hooks after the mocks are in place).
 *
 * A genuine, code-grounded subtlety this fixture surfaces (see the long
 * comment above the assertions below): `recordDroppedMessage` upserts into
 * `unregistered_senders` keyed by (channel_type, platform_id), and BOTH the
 * permissions module's own drop record (reason `unknown_sender_<policy>`,
 * written synchronously inside the access-gate call) and router.ts's
 * end-of-loop drop record (reason `no_agent_engaged`, written because this
 * agent's engagement never counts as engaged/accumulated once the gate
 * refuses it) target the SAME key. The second write wins the UPSERT. Per
 * this project's standing practice of characterizing real behavior rather
 * than assuming it (see fixtures.test.ts's "duplicate-input" fixture), this
 * is captured via `toMatchSnapshot()` — not hard-coded — so the snapshot
 * itself is the record of which reason string actually survives.
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
import type { InboundEvent } from '../channels/adapter.js';
import { IdNormalizer, normalizeGuardReason, normalizeTimestamp } from './normalize.js';
import type { ParityResult } from './types.js';

// `vi.mock` factories run before any of the file's own top-level statements
// (mocks are hoisted above even module-graph evaluation of static imports
// below) — a plain `const TEST_DIR = ...` referenced from inside the
// `../config.js` factory would throw "Cannot access before initialization".
// `vi.hoisted` hoists ALONGSIDE `vi.mock`, so TEST_DIR exists by the time
// that factory runs. (deliverMock/ensureUserDm's mock below don't need this:
// they only close over their outer consts inside a NESTED function that
// isn't invoked until a test actually runs, long after module load.)
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-differential-fixtures-unknown-sender' }));

// Prevent actual Docker spawning — same mock as fixtures.test.ts / host-core.test.ts.
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter — records the approval-card send for assertions,
// exactly as src/modules/permissions/sender-approval.test.ts does. This
// harness only needs getDeliveryAdapter (the only export the permissions
// module imports from delivery.js).
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

// Mock ensureUserDm — return the approver's pre-seeded DM messaging group
// instead of hitting a real openDM RPC. Verbatim adaptation of
// sender-approval.test.ts's mock, one directory up.
vi.mock('../modules/permissions/user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb: getDbInner } = await import('../db/connection.js');
    return getDbInner().get(
      `SELECT mg.* FROM messaging_groups mg
         JOIN user_dms ud ON ud.messaging_group_id = mg.id
        WHERE ud.user_id = ?`,
      userId,
    );
  }),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

function now(): string {
  return new Date().toISOString();
}

function strangerEvent(text: string): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'chan-123',
    threadId: null,
    message: {
      id: 'msg-stranger-1',
      kind: 'chat',
      content: JSON.stringify({ sender: 'Stranger', text }),
      timestamp: now(),
    },
  } as InboundEvent;
}

async function expectAsyncDelivery(action: () => Promise<void>): Promise<void> {
  const previousCount = deliverMock.mock.calls.length;
  await action();
  await vi.waitFor(() => {
    expect(deliverMock.mock.calls.length).toBeGreaterThan(previousCount);
  });
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

  // Side-effect import: register the permissions module's hooks AFTER the
  // mocks above are in place (setSenderResolver/setAccessGate/
  // setSenderScopeGate + the approval response handler).
  await import('../modules/permissions/index.js');

  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-chat',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-chat',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // Owner user + DM messaging group, so requestSenderApproval has an
  // approver to deliver the card to (pickApprover picks the owner absent a
  // more specific admin — see sender-approval.test.ts's identical fixture).
  const { upsertUser } = await import('../modules/permissions/db/users.js');
  const { grantRole } = await import('../modules/permissions/db/user-roles.js');
  await upsertUser({ id: 'discord:owner', kind: 'discord', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'discord:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'discord',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await getDb().run(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`,
    'discord:owner',
    'discord',
    'mg-dm-owner',
    now(),
  );

  deliverMock.mockClear();
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('P2-03 fixture: unknown-sender', () => {
  it('holds for admin approval on first message from an unrecognized sender (request_approval policy)', async () => {
    const { routeInbound } = await import('../router.js');
    const { guard } = await import('../guard/index.js');
    const { sendersAdmit } = await import('../modules/permissions/guard.js');

    const ids = new IdNormalizer();

    await expectAsyncDelivery(() => routeInbound(strangerEvent('let me in')));

    // No session is ever created — the access gate refuses before
    // resolveSession is reached for this agent (mirrors the "non-mention"
    // fixture's "no engagement => no session" characterization).
    const session = await findSession('mg-chat', null);
    expect(session).toBeUndefined();

    // pending_sender_approvals: the module's own hold-state row.
    const pendingRows = await getDb().all<Record<string, unknown>>('SELECT * FROM pending_sender_approvals');
    expect(pendingRows).toHaveLength(1);
    const pending = pendingRows[0];
    let originalMessagePreview: unknown = null;
    try {
      const parsed = JSON.parse(pending.original_message as string) as InboundEvent;
      originalMessagePreview = {
        channelType: parsed.channelType,
        platformId: parsed.platformId,
        messageId: parsed.message.id,
        hasTimestamp: Boolean(parsed.message.timestamp),
      };
    } catch {
      originalMessagePreview = '<unparseable>';
    }
    const normalizedPending = {
      id: ids.normalize('APPROVAL', pending.id as string),
      messaging_group_id: ids.normalize('MG', pending.messaging_group_id as string),
      agent_group_id: ids.normalize('AGENT_GROUP', pending.agent_group_id as string),
      sender_identity: pending.sender_identity, // stable, derived from the fixed input handle — not generated
      sender_name: pending.sender_name,
      approver_user_id: pending.approver_user_id, // stable — the fixed seeded owner id
      created_at: normalizeTimestamp(pending.created_at as string | null),
      originalMessagePreview,
    };

    // unregistered_senders: the aggregated drop-counter row — see the file
    // docstring for why its final `reason` is genuinely ambiguous without
    // running this (two different callers upsert the same key).
    const unregistered = await getUnregisteredSenders();
    expect(unregistered).toHaveLength(1); // one (channel_type, platform_id) key, not two rows
    const normalizedUnregistered = {
      ...unregistered[0],
      messaging_group_id: unregistered[0].messaging_group_id
        ? ids.normalize('MG', unregistered[0].messaging_group_id)
        : null,
      agent_group_id: unregistered[0].agent_group_id
        ? ids.normalize('AGENT_GROUP', unregistered[0].agent_group_id)
        : null,
      first_seen: normalizeTimestamp(unregistered[0].first_seen),
      last_seen: normalizeTimestamp(unregistered[0].last_seen),
    };

    // Independently exercise the `senders.admit` guarded action with the
    // same effective inputs the router path used, per docs/parity-schema.md's
    // "observable contracts" principle — this is the GuardDecision axis,
    // captured directly rather than inferred from side effects.
    const decision = await guard(sendersAdmit, {
      actor: { kind: 'human', userId: 'discord:Stranger' },
      payload: {
        messagingGroupId: 'mg-chat',
        agentGroupId: 'ag-1',
        senderIdentity: 'discord:Stranger',
        policy: 'request_approval',
      },
    });

    const result: ParityResult = {
      scenario: 'unknown-sender',
      routing: {
        dispositions: [
          {
            agentGroupId: ids.normalize('AGENT_GROUP', 'ag-1')!,
            outcome: 'dropped',
            engageMode: 'pattern',
            accessOk: false,
            scopeOk: true,
          },
        ],
        messageOutcome: 'dropped',
        dropReason: normalizedUnregistered.reason as string,
        channelRegistrationEscalated: false,
      },
      dbState: {
        tables: {
          pending_sender_approvals: [normalizedPending],
          unregistered_senders: [normalizedUnregistered],
        },
      },
      guard: {
        effect: decision.effect,
        reasonCategory: normalizeGuardReason(decision.reason),
      },
    };

    // The approval card went to the owner's DM, not back into the source channel.
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [cardChannel, cardPlatformId] = deliverMock.mock.calls[0];
    expect(cardChannel).toBe('discord');
    expect(cardPlatformId).toBe('dm-owner');

    expect(result).toMatchSnapshot();
  });
});

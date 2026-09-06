/**
 * P2-04 batch 2 fixture: channel-registration-escalation.
 *
 * Separated from fixtures-batch2.test.ts because this scenario needs the same
 * heavier, incompatible mock set fixtures-unknown-sender.test.ts uses: the
 * permissions module (registered as a side-effect import) needs delivery.js
 * mocked to capture the approval-card send and modules/permissions/user-dm.js
 * mocked to avoid a real openDM RPC. This exercises the OTHER escalation path
 * the permissions module registers — channel-level (an unwired channel gets a
 * connect/reject card) rather than sender-level (P2-03's unknown-sender
 * fixture) — via router.ts's channelRequestGate hook
 * (src/modules/permissions/channel-approval.ts's requestChannelApproval).
 *
 * This is also the first fixture in the differential suite to set
 * routing.channelRegistrationEscalated: true — every P2-03/P2-04-batch1
 * fixture that populates the routing axis has it false.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../db/index.js';
import { getUnregisteredSenders } from '../db/dropped-messages.js';
import type { InboundEvent } from '../channels/adapter.js';
import { IdNormalizer, normalizeTimestamp } from './normalize.js';
import type { ParityResult } from './types.js';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-differential-fixtures-channel-registration' }));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: deliverMock }),
}));

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

function chatEvent(
  overrides: Omit<Partial<InboundEvent>, 'message'> & { message: Partial<InboundEvent['message']> },
): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'chan-new',
    threadId: null,
    ...overrides,
    message: {
      id: 'msg-default',
      kind: 'chat',
      content: JSON.stringify({ sender: 'Someone', text: 'hey bot' }),
      timestamp: now(),
      ...overrides.message,
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
  const db = await initTestDb();
  await runMigrations(db);

  // Side-effect import: register the permissions module's hooks (including
  // setChannelRequestGate(requestChannelApproval)) AFTER the mocks above are
  // in place.
  await import('../modules/permissions/index.js');

  // One existing agent group — requestChannelApproval needs at least one to
  // offer as a "Connect to <agent>" option, and to pick a reference group for
  // approver resolution. Deliberately NOT wired to any messaging group, so
  // the channel this fixture messages stays at agentCount=0.
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });

  // Owner user + DM messaging group, so requestChannelApproval has an
  // approver to deliver the card to — same fixture pattern as
  // fixtures-unknown-sender.test.ts.
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

describe('P2-04 batch2 fixture: channel-registration-escalation', () => {
  it('a mention on a brand-new, unwired channel escalates to the owner via a connect/reject card', async () => {
    const { routeInbound } = await import('../router.js');
    const ids = new IdNormalizer();

    await expectAsyncDelivery(() => routeInbound(chatEvent({ message: { id: 'msg-1', isMention: true } })));

    // Structural drop is still recorded — the escalation is IN ADDITION TO,
    // not instead of, the router's own no_agent_wired audit row (router.ts:
    // recordDroppedMessage happens unconditionally at agentCount===0 before
    // the channelRequestGate is ever consulted).
    const unregistered = await getUnregisteredSenders();
    expect(unregistered).toHaveLength(1);
    expect(unregistered[0].reason).toBe('no_agent_wired');

    const pendingRows = await getDb().all<Record<string, unknown>>('SELECT * FROM pending_channel_approvals');
    expect(pendingRows).toHaveLength(1);
    const pending = pendingRows[0];
    const normalizedPending = {
      messaging_group_id: ids.normalize('MG', pending.messaging_group_id as string),
      agent_group_id: ids.normalize('AGENT_GROUP', pending.agent_group_id as string),
      approver_user_id: pending.approver_user_id, // stable — the fixed seeded owner id
      created_at: normalizeTimestamp(pending.created_at as string | null),
      title: pending.title,
    };

    const result: ParityResult = {
      scenario: 'channel-registration-escalation',
      routing: {
        dispositions: [],
        messageOutcome: 'dropped',
        dropReason: 'no_agent_wired',
        channelRegistrationEscalated: true,
      },
      dbState: {
        tables: {
          pending_channel_approvals: [normalizedPending],
        },
      },
    };

    // The connect/reject card went to the owner's DM, not back into the source channel.
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [cardChannel, cardPlatformId] = deliverMock.mock.calls[0];
    expect(cardChannel).toBe('discord');
    expect(cardPlatformId).toBe('dm-owner');

    expect(result).toMatchSnapshot();
  });
});

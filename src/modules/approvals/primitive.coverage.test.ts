/**
 * Approvals primitive — the requestApproval branches the delivery-failure
 * suite doesn't reach (no approver, no reachable DM, explicit approver,
 * origin-channel tie-break, adapter not yet bound), plus the registry warn on
 * re-registration and the un-namespaced approver id in pickApprovalDelivery.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import {
  getApprovalHandler,
  notifyAgent,
  pickApprovalDelivery,
  pickApprover,
  registerApprovalHandler,
  requestApproval,
} from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-primitive-cov' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-approval-primitive-cov';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ channelType: string; platformId: string; content: Record<string, unknown> }>;
const okAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content: JSON.parse(content) });
    return 'pm-1';
  },
};

let session: Session;

async function seedDmUser(id: string, channelType: string, platformId: string, mgId: string): Promise<void> {
  await upsertUser({ id, kind: channelType, display_name: id, created_at: now() });
  await createMessagingGroup({
    id: mgId,
    channel_type: channelType,
    platform_id: platformId,
    name: `${id} DM`,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: id, channel_type: channelType, messaging_group_id: mgId, resolved_at: now() });
}

function lastNotifyText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  delivered = [];
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  setDeliveryAdapter(okAdapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('registerApprovalHandler', () => {
  it('warns and overwrites when an action is registered twice', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const first = vi.fn();
    const second = vi.fn();
    registerApprovalHandler('dup_action', first);
    expect(warn).not.toHaveBeenCalled();
    registerApprovalHandler('dup_action', second);
    expect(warn).toHaveBeenCalledWith('Approval handler re-registered (overwriting)', { action: 'dup_action' });
    expect(getApprovalHandler('dup_action')).toBe(second);
    warn.mockRestore();
  });
});

describe('pickApprover', () => {
  it('lists a user holding several roles once, in first-seen position', async () => {
    await upsertUser({ id: 'slack:both', kind: 'slack', display_name: 'Both', created_at: now() });
    await upsertUser({ id: 'slack:owner2', kind: 'slack', display_name: 'Owner2', created_at: now() });
    await grantRole({
      user_id: 'slack:both',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await grantRole({
      user_id: 'slack:both',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await grantRole({
      user_id: 'slack:owner2',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await pickApprover('ag-1')).toEqual(['slack:both', 'slack:owner2']);
  });
});

describe('pickApprovalDelivery', () => {
  it('skips an un-namespaced approver id in the origin pass and resolves nobody', async () => {
    expect(await pickApprovalDelivery(['nocolon'], 'slack')).toBeNull();
  });

  it('skips an origin-channel approver with no DM and takes the next reachable one', async () => {
    await upsertUser({ id: 'slack:nodm', kind: 'slack', display_name: 'NoDm', created_at: now() });
    await seedDmUser('slack:withdm', 'slack', 'D-withdm', 'mg-withdm');
    const picked = await pickApprovalDelivery(['slack:nodm', 'slack:withdm'], 'slack');
    expect(picked?.userId).toBe('slack:withdm');
    expect(picked?.messagingGroup.platform_id).toBe('D-withdm');
  });
});

describe('notifyAgent', () => {
  it('does not wake a session that no longer exists in the DB', async () => {
    await notifyAgent({ ...session, id: 'sess-gone' }, 'hello');
    expect(lastNotifyText()).toBe('hello');
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('wakes the freshly-read session row after writing the note', async () => {
    await notifyAgent(session, 'hi');
    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));
  });
});

describe('requestApproval', () => {
  const base = {
    agentName: 'Agent',
    action: 'test_action',
    payload: { key: 'value' },
    title: 'Test Approval',
    question: 'Approve?',
  };

  it('tells the agent when no owner or admin exists to approve', async () => {
    await requestApproval({ session, ...base });
    expect(lastNotifyText()).toBe('test_action failed: no owner or admin configured to approve.');
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
  });

  it('tells the agent when no eligible approver has a reachable DM', async () => {
    await upsertUser({ id: 'slack:ghost', kind: 'slack', display_name: 'Ghost', created_at: now() });
    await grantRole({
      user_id: 'slack:ghost',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await requestApproval({ session, ...base });
    expect(lastNotifyText()).toBe('test_action failed: no DM channel found for any eligible approver.');
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
  });

  it('delivers to an explicitly named approver even without any role and records them on the row', async () => {
    await seedDmUser('slack:named', 'slack', 'D-named', 'mg-named');
    await requestApproval({ session, ...base, approverUserId: 'slack:named' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].platformId).toBe('D-named');
    expect(delivered[0].content).toMatchObject({ type: 'ask_question', title: 'Test Approval', question: 'Approve?' });
    expect((delivered[0].content.options as unknown[]).length).toBe(3);
    const rows = await getPendingApprovalsByAction('test_action');
    expect(rows).toHaveLength(1);
    expect(rows[0].approver_user_id).toBe('slack:named');
    expect(rows[0].session_id).toBe('sess-1');
    expect(rows[0].instance).toBe('slack');
    expect(JSON.parse(rows[0].payload)).toEqual({ key: 'value' });
    expect(JSON.parse(rows[0].options_json)).toHaveLength(3);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it("prefers an approver on the requesting session's channel", async () => {
    await seedDmUser('slack:first', 'slack', 'D-first', 'mg-first');
    await seedDmUser('telegram:second', 'telegram', '222', 'mg-second');
    for (const user_id of ['slack:first', 'telegram:second']) {
      await grantRole({ user_id, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    }
    await createMessagingGroup({
      id: 'mg-origin',
      channel_type: 'telegram',
      platform_id: 'g-1',
      name: 'Origin',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await requestApproval({ session: { ...session, messaging_group_id: 'mg-origin' }, ...base });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe('telegram');
    expect(delivered[0].platformId).toBe('222');
  });

  it('falls back to list order when the origin messaging group is missing', async () => {
    await seedDmUser('slack:first', 'slack', 'D-first', 'mg-first');
    await grantRole({
      user_id: 'slack:first',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await requestApproval({ session: { ...session, messaging_group_id: 'mg-does-not-exist' }, ...base });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].platformId).toBe('D-first');
  });

  it('removes the just-created row and tells the agent when card delivery throws', async () => {
    await seedDmUser('slack:first', 'slack', 'D-first', 'mg-first');
    await grantRole({
      user_id: 'slack:first',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    setDeliveryAdapter({
      async deliver() {
        throw new Error('platform down');
      },
    });
    await requestApproval({ session, ...base });
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
    expect(lastNotifyText()).toBe('test_action failed: could not deliver approval request to slack:first.');
  });

  it('records the row without delivering when no delivery adapter is bound yet, then delivers once one is', async () => {
    await seedDmUser('slack:first', 'slack', 'D-first', 'mg-first');
    await grantRole({
      user_id: 'slack:first',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    setDeliveryAdapter(null as unknown as ChannelDeliveryAdapter);
    await requestApproval({ session, ...base });
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(1);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();

    // Regression test for a fixed bug: the row used to be stranded forever
    // here — nothing retried delivery once an adapter came up later. It must
    // now be delivered as soon as setDeliveryAdapter runs.
    setDeliveryAdapter(okAdapter);
    await vi.waitFor(() => {
      expect(delivered).toHaveLength(1);
    });
    expect(delivered[0]).toMatchObject({ channelType: 'slack', platformId: 'D-first' });
  });
});

/**
 * Coverage tests for the permissions guard adapter — every branch of the two
 * decide functions driven directly against an in-memory central DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { guard } from '../../guard/index.js';
import { createPendingChannelApproval } from './db/pending-channel-approvals.js';
import { grantRole } from './db/user-roles.js';
import { createUser } from './db/users.js';
import { channelsRegister, sendersAdmit } from './guard.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('senders.admit', () => {
  const base = { messagingGroupId: 'mg-1', agentGroupId: 'ag-1', senderIdentity: 'tg:x' };

  it('maps unknown_sender_policy verbatim: public allow, request_approval hold, decline_notify/strict deny', async () => {
    const actor = { kind: 'human' as const, userId: 'tg:x' };
    const pub = await guard(sendersAdmit, { actor, payload: { ...base, policy: 'public' } });
    expect(pub).toEqual({ effect: 'allow', reason: 'public messaging group' });

    const hold = await guard(sendersAdmit, { actor, payload: { ...base, policy: 'request_approval' } });
    expect(hold.effect).toBe('hold');
    expect(hold.reason).toContain('messaging group mg-1');

    const decline = await guard(sendersAdmit, { actor, payload: { ...base, policy: 'decline_notify' } });
    expect(decline).toEqual({ effect: 'deny', reason: 'unknown sender declined (decline-and-notify policy)' });

    const strict = await guard(sendersAdmit, { actor, payload: { ...base, policy: 'strict' } });
    expect(strict).toEqual({ effect: 'deny', reason: 'unknown sender on a strict messaging group' });

    // Unknown/missing policy values fail closed to the strict deny.
    const weird = await guard(sendersAdmit, { actor: { kind: 'system' }, payload: { ...base, policy: 'bogus' } });
    expect(weird.effect).toBe('deny');
  });
});

describe('channels.register', () => {
  beforeEach(async () => {
    await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'tg',
      platform_id: 'chan-1',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: now(),
    });
    await createUser({ id: 'tg:owner', kind: 'tg', display_name: null, created_at: now() });
    await createUser({ id: 'tg:admin', kind: 'tg', display_name: null, created_at: now() });
    await createUser({ id: 'tg:bystander', kind: 'tg', display_name: null, created_at: now() });
    await grantRole({
      user_id: 'tg:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    await createPendingChannelApproval({
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      original_message: '{}',
      approver_user_id: 'tg:owner',
      created_at: now(),
      title: 't',
      question: 'q',
      options_json: '[]',
    });
  });

  it('denies non-human actors', async () => {
    const d = await guard(channelsRegister, {
      actor: { kind: 'agent', agentGroupId: 'ag-1' },
      payload: { questionId: 'mg-1' },
    });
    expect(d).toEqual({ effect: 'deny', reason: 'channel registration resolves via human clicks/replies' });
  });

  it('denies when there is no pending registration for the question id', async () => {
    const missing = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'tg:owner' },
      payload: { questionId: 'mg-nope' },
    });
    expect(missing).toEqual({ effect: 'deny', reason: 'no pending channel registration for mg-nope' });

    // A non-string questionId reads as missing.
    const untyped = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'tg:owner' },
      payload: { questionId: 42 },
    });
    expect(untyped.reason).toBe('no pending channel registration for (missing questionId)');
  });

  it('allows the delivered approver and an admin of the anchor group; denies everyone else', async () => {
    const approver = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'tg:owner' },
      payload: { questionId: 'mg-1' },
    });
    expect(approver).toEqual({ effect: 'allow', reason: 'delivered approver or anchor-group admin' });

    const admin = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'tg:admin' },
      payload: { questionId: 'mg-1' },
    });
    expect(admin.effect).toBe('allow');

    const bystander = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'tg:bystander' },
      payload: { questionId: 'mg-1' },
    });
    expect(bystander).toEqual({ effect: 'deny', reason: 'not an eligible channel-registration approver' });

    const anonymous = await guard(channelsRegister, {
      actor: { kind: 'human', userId: '' },
      payload: { questionId: 'mg-1' },
    });
    expect(anonymous.effect).toBe('deny');
  });
});

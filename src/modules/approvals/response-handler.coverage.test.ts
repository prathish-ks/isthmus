/**
 * Approval response handler — the branches the authz regression suite leaves
 * open: gateway credential rows (resolved / stale), rows with no session, handler-less and
 * throwing approvals, already-claimed rows, scoped-admin authorization.
 *
 * Real central DB. gateway-approval-coordinator is stubbed so the gateway-credential branch can be
 * steered without the SDK; writeSessionMessage is mocked to read back the
 * agent-facing note.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { resolveGatewayApproval } from '../../gateway-approval-coordinator.js';
import { registerApprovalHandler } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approval-response-cov' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../../gateway-approval-coordinator.js', () => ({
  GATEWAY_APPROVAL_ACTION: 'gateway_credential',
  resolveGatewayApproval: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-approval-response-cov';

function now(): string {
  return new Date().toISOString();
}

async function seedApproval(overrides: Partial<PendingApproval> & { approval_id: string; action: string }) {
  await createPendingApproval({
    session_id: 'sess-1',
    request_id: overrides.approval_id,
    payload: JSON.stringify({ k: 'v' }),
    created_at: now(),
    title: 'Approval',
    options_json: '[]',
    ...overrides,
  });
}

function click(questionId: string, value: string, userId: string | null = 'owner') {
  return handleApprovalsResponse({
    questionId,
    value,
    userId,
    channelType: 'telegram',
    platformId: 'dm-x',
    threadId: null,
  });
}

/** Leave the row pointing at a deleted session (plain REFERENCES, no cascade — lift enforcement for one delete). */
async function orphanSession(id: string): Promise<void> {
  await getDb().run('PRAGMA foreign_keys = OFF');
  await getDb().run('DELETE FROM sessions WHERE id = ?', id);
  await getDb().run('PRAGMA foreign_keys = ON');
}

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastNotifyText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  await upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  await grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('handleApprovalsResponse — claim rules', () => {
  it('does not claim a response for an unknown approval id', async () => {
    expect(await click('nope', 'approve')).toBe(false);
  });

  it('claims but ignores a response with no user id', async () => {
    await seedApproval({ approval_id: 'a-1', action: 'x' });
    expect(await click('a-1', 'approve', null)).toBe(true);
    expect(await getPendingApproval('a-1')).toBeDefined();
  });

  it('accepts an already-namespaced user id as-is', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('ns_action', handler);
    await seedApproval({ approval_id: 'a-ns', action: 'ns_action' });
    expect(await click('a-ns', 'approve', 'telegram:owner')).toBe(true);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ userId: 'telegram:owner' }));
  });
});

describe('handleApprovalsResponse — gateway credential rows', () => {
  it('hands the click to the in-memory resolver when it is still waiting', async () => {
    vi.mocked(resolveGatewayApproval).mockResolvedValueOnce(true);
    await seedApproval({ approval_id: 'oa-1', action: 'gateway_credential', session_id: null });
    expect(await click('oa-1', 'approve')).toBe(true);
    expect(resolveGatewayApproval).toHaveBeenCalledWith('oa-1', 'approve');
    // The resolver owns the row in this branch — the handler must not touch it.
    expect(await getPendingApproval('oa-1')).toBeDefined();
  });

  it('drops the row when the resolver is gone (timer fired / process state lost)', async () => {
    vi.mocked(resolveGatewayApproval).mockResolvedValueOnce(false);
    await seedApproval({ approval_id: 'oa-2', action: 'gateway_credential', session_id: null });
    expect(await click('oa-2', 'reject')).toBe(true);
    expect(await getPendingApproval('oa-2')).toBeUndefined();
  });
});

describe('handleApprovalsResponse — registered approvals', () => {
  it('drops a row that has no session id', async () => {
    const handler = vi.fn();
    registerApprovalHandler('no_session', handler);
    await seedApproval({ approval_id: 'a-2', action: 'no_session', session_id: null });
    expect(await click('a-2', 'approve')).toBe(true);
    expect(await getPendingApproval('a-2')).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops a row whose session no longer exists', async () => {
    const handler = vi.fn();
    registerApprovalHandler('gone_session', handler);
    await seedApproval({ approval_id: 'a-3', action: 'gone_session' });
    await orphanSession('sess-1');
    expect(await click('a-3', 'approve')).toBe(true);
    expect(await getPendingApproval('a-3')).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('tells the agent when no handler is installed for an approved action, then drops the row and wakes', async () => {
    await seedApproval({ approval_id: 'a-4', action: 'orphan_action' });
    expect(await click('a-4', 'approve')).toBe(true);
    expect(lastNotifyText()).toBe('Your orphan_action was approved, but no handler is installed to apply it.');
    expect(await getPendingApproval('a-4')).toBeUndefined();
    expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));
  });

  it('relays a handler failure to the agent and still drops the row', async () => {
    registerApprovalHandler('boom_action', async () => {
      throw new Error('disk full');
    });
    await seedApproval({ approval_id: 'a-5', action: 'boom_action' });
    expect(await click('a-5', 'approve')).toBe(true);
    expect(lastNotifyText()).toBe('Your boom_action was approved, but applying it failed: disk full.');
    expect(await getPendingApproval('a-5')).toBeUndefined();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('stringifies a non-Error throw from the handler', async () => {
    registerApprovalHandler('boom_string', async () => {
      throw 'plain string';
    });
    await seedApproval({ approval_id: 'a-5b', action: 'boom_string' });
    await click('a-5b', 'approve');
    expect(lastNotifyText()).toBe('Your boom_string was approved, but applying it failed: plain string.');
  });

  it('passes payload, approval row and a working notify() to the handler', async () => {
    const handler = vi.fn(async ({ notify }: { notify: (t: string) => Promise<void> }) => {
      await notify('progress note');
    });
    registerApprovalHandler('ctx_action', handler);
    await seedApproval({ approval_id: 'a-6', action: 'ctx_action', payload: JSON.stringify({ apt: ['jq'] }) });
    await click('a-6', 'approve');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { apt: ['jq'] },
        approval: expect.objectContaining({ approval_id: 'a-6' }),
        session: expect.objectContaining({ id: 'sess-1' }),
        userId: 'telegram:owner',
      }),
    );
    expect(lastNotifyText()).toBe('progress note');
    const call = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
    expect(call[0]).toBe('ag-1');
    expect(call[1]).toBe('sess-1');
    expect(call[2]).toMatchObject({ kind: 'chat', channelType: 'agent', platformId: 'ag-1', threadId: null });
  });

  it('a plain reject finalizes immediately: agent told, row dropped, container woken', async () => {
    const handler = vi.fn();
    registerApprovalHandler('reject_me', handler);
    await seedApproval({ approval_id: 'a-r1', action: 'reject_me' });
    expect(await click('a-r1', 'reject')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(lastNotifyText()).toBe('Your reject_me request was rejected by admin.');
    expect(await getPendingApproval('a-r1')).toBeUndefined();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('"Reject with reason…" arms capture instead of finalizing (falls back to plain reject when the admin has no DM)', async () => {
    const { REJECT_WITH_REASON_VALUE } = await import('./primitive.js');
    await seedApproval({ approval_id: 'a-r2', action: 'reject_reason' });
    expect(await click('a-r2', REJECT_WITH_REASON_VALUE)).toBe(true);
    // The owner has no cached DM and no adapter → the hold collapses to a plain reject.
    expect(lastNotifyText()).toBe('Your reject_reason request was rejected by admin.');
    expect(await getPendingApproval('a-r2')).toBeUndefined();
  });

  it('ignores an approve on a row that is no longer pending', async () => {
    const handler = vi.fn();
    registerApprovalHandler('claimed_action', handler);
    await seedApproval({ approval_id: 'a-7', action: 'claimed_action', status: 'approved' });
    expect(await click('a-7', 'approve')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect((await getPendingApproval('a-7'))?.status).toBe('approved');
  });
});

describe('handleApprovalsResponse — scoped authorization', () => {
  it('lets a scoped admin resolve an approval carrying their agent group', async () => {
    await upsertUser({ id: 'telegram:scoped', kind: 'telegram', display_name: 'Scoped', created_at: now() });
    await grantRole({
      user_id: 'telegram:scoped',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('scoped_action', handler);
    await seedApproval({ approval_id: 'a-8', action: 'scoped_action', agent_group_id: 'ag-1' });

    expect(await click('a-8', 'approve', 'scoped')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refuses a scoped admin of a different agent group', async () => {
    await upsertUser({ id: 'telegram:other', kind: 'telegram', display_name: 'Other', created_at: now() });
    await grantRole({
      user_id: 'telegram:other',
      role: 'admin',
      agent_group_id: 'ag-2',
      granted_by: null,
      granted_at: now(),
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('scoped_action_2', handler);
    await seedApproval({ approval_id: 'a-9', action: 'scoped_action_2', agent_group_id: 'ag-1' });

    expect(await click('a-9', 'approve', 'other')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(await getPendingApproval('a-9')).toBeDefined();
  });

  it('an assigned approver resolves it even without any role; everyone else is refused', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('assigned', handler);
    await seedApproval({ approval_id: 'a-11', action: 'assigned', approver_user_id: 'telegram:dana' });
    // Even the owner is not the assignee.
    expect(await click('a-11', 'approve', 'owner')).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(await click('a-11', 'approve', 'dana')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('lets a global admin who is not an owner resolve a row with no agent group', async () => {
    await upsertUser({ id: 'telegram:gadmin', kind: 'telegram', display_name: 'GA', created_at: now() });
    await grantRole({
      user_id: 'telegram:gadmin',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('groupless', handler);
    await seedApproval({ approval_id: 'a-12', action: 'groupless', session_id: null, agent_group_id: null });
    expect(await click('a-12', 'approve', 'gadmin')).toBe(true);
    // Authorized (global admin) but no session → row dropped without dispatch.
    expect(await getPendingApproval('a-12')).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it('derives the agent group from the session when the row carries none', async () => {
    await upsertUser({ id: 'telegram:scoped', kind: 'telegram', display_name: 'Scoped', created_at: now() });
    await grantRole({
      user_id: 'telegram:scoped',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('via_session', handler);
    await seedApproval({ approval_id: 'a-10', action: 'via_session', agent_group_id: null, session_id: 'sess-1' });

    expect(await click('a-10', 'approve', 'scoped')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

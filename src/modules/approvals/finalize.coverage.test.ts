/**
 * finalizeReject — the shared reject path called directly, so every branch is
 * pinned without going through a card click: the lost-race return, the
 * default expected-status derivation for held rows, and the reason /
 * no-reason wording.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { finalizeReject } from './finalize.js';
import { registerApprovalResolvedHandler, type ApprovalResolvedEvent } from './primitive.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-finalize-cov' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-finalize-cov';

function now(): string {
  return new Date().toISOString();
}

let session: Session;
const events: ApprovalResolvedEvent[] = [];
registerApprovalResolvedHandler((e) => {
  events.push(e);
});

async function seed(id: string, status: PendingApproval['status'] = 'pending'): Promise<PendingApproval> {
  await createPendingApproval({
    approval_id: id,
    session_id: 'sess-1',
    request_id: id,
    action: 'install_packages',
    payload: '{}',
    created_at: now(),
    title: 'Approval',
    options_json: '[]',
    status,
  });
  return (await getPendingApproval(id))!;
}

function lastText(): string {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  events.length = 0;
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
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('finalizeReject', () => {
  it('returns false and does nothing when the row is not in the expected state', async () => {
    const approval = await seed('a-1', 'approved');
    expect(await finalizeReject(approval, session, 'slack:admin')).toBe(false);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
    expect((await getPendingApproval('a-1'))?.status).toBe('approved');
  });

  it('defaults the expected state to awaiting_reason for a held row', async () => {
    const approval = await seed('a-2', 'awaiting_reason');
    expect(await finalizeReject(approval, session, 'slack:admin', 'nope')).toBe(true);
    expect(lastText()).toBe('Your install_packages request was rejected by admin: "nope"');
    expect(await getPendingApproval('a-2')).toBeUndefined();
    expect(events).toEqual([expect.objectContaining({ outcome: 'reject', userId: 'slack:admin' })]);
    expect(wakeContainer).toHaveBeenCalledWith(session);
  });

  it('an explicit expected state overrides the derived one', async () => {
    const approval = await seed('a-3', 'pending');
    // Row is pending but caller claims it should be awaiting_reason — no match.
    expect(await finalizeReject(approval, session, '', undefined, 'awaiting_reason')).toBe(false);
    expect(await getPendingApproval('a-3')).toBeDefined();
    expect(await finalizeReject(approval, session, '', undefined, 'pending')).toBe(true);
    expect(lastText()).toBe('Your install_packages request was rejected by admin.');
  });

  it('isolates a throwing approval-resolved callback: later callbacks still run, reject completes', async () => {
    const order: string[] = [];
    registerApprovalResolvedHandler(() => {
      order.push('boom');
      throw new Error('callback exploded');
    });
    registerApprovalResolvedHandler(() => {
      order.push('after');
    });
    const approval = await seed('a-5');
    expect(await finalizeReject(approval, session, '')).toBe(true);
    expect(order).toEqual(['boom', 'after']);
    expect(await getPendingApproval('a-5')).toBeUndefined();
    expect(wakeContainer).toHaveBeenCalledTimes(1);
  });

  it('writes the note as a system chat message into the requesting session', async () => {
    const approval = await seed('a-4');
    await finalizeReject(approval, session, '');
    const [agentGroupId, sessionId, msg] = vi.mocked(writeSessionMessage).mock.calls[0];
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-1');
    expect(msg).toMatchObject({ kind: 'chat', channelType: 'agent', platformId: 'ag-1', threadId: null });
    expect(JSON.parse(msg.content)).toMatchObject({ sender: 'system', senderId: 'system' });
  });
});

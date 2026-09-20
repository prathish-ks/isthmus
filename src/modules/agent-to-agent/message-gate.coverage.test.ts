/**
 * Coverage tests for the a2a approve continuation — the branches the routing
 * integration test does not reach: a missing target in the payload, payload
 * field defaulting, and a non-guard failure from the route being re-thrown
 * (only GuardDenyError is an expected policy outcome).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const routeMock = vi.hoisted(() => vi.fn());
vi.mock('./agent-route.js', () => ({
  routeAgentMessage: (...args: unknown[]) => routeMock(...args),
}));

import { GuardDenyError } from '../../guard/index.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { applyA2aMessageGate } from './message-gate.js';

const SESSION = { id: 'sess-A', agent_group_id: 'ag-A' } as Session;
const APPROVAL = { approval_id: 'appr-1', action: 'a2a_message_gate', payload: '{}' } as PendingApproval;

beforeEach(() => {
  routeMock.mockReset();
  vi.restoreAllMocks();
});

describe('applyA2aMessageGate', () => {
  it('notifies and skips routing when the payload has no target agent group', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const notify = vi.fn();
    await applyA2aMessageGate({
      session: SESSION,
      userId: 'tg:dana',
      notify,
      payload: { id: 'm1', platform_id: '', content: 'x' },
      approval: APPROVAL,
    });
    expect(notify).toHaveBeenCalledWith('Message approved but the target agent group was missing from the request.');
    expect(routeMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('a2a_message_gate apply: missing target', { sessionId: 'sess-A' });
  });

  it('defaults non-string id/content/in_reply_to and re-enters the route with the approval as grant', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    routeMock.mockResolvedValue(undefined);
    const notify = vi.fn();
    await applyA2aMessageGate({
      session: SESSION,
      userId: 'tg:dana',
      notify,
      payload: { id: 7, platform_id: 'ag-B', content: null, in_reply_to: 12 },
      approval: APPROVAL,
    });

    expect(routeMock).toHaveBeenCalledTimes(1);
    const [msg, session, opts] = routeMock.mock.calls[0] as [
      Record<string, unknown>,
      Session,
      { grant: PendingApproval },
    ];
    expect(msg.id).toMatch(/^a2a-gate-\d+$/);
    expect(msg).toMatchObject({ platform_id: 'ag-B', content: '', in_reply_to: null });
    expect(session).toBe(SESSION);
    expect(opts.grant).toBe(APPROVAL);
    expect(notify).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      'Held agent message delivered after approval',
      expect.objectContaining({ from: 'ag-A', to: 'ag-B' }),
    );
  });

  it('passes string payload fields through unchanged', async () => {
    routeMock.mockResolvedValue(undefined);
    await applyA2aMessageGate({
      session: SESSION,
      userId: 'tg:dana',
      notify: vi.fn(),
      payload: { id: 'held-9', platform_id: 'ag-B', content: '{"text":"hi"}', in_reply_to: 'in-1' },
      approval: APPROVAL,
    });
    expect(routeMock.mock.calls[0][0]).toEqual({
      id: 'held-9',
      platform_id: 'ag-B',
      content: '{"text":"hi"}',
      in_reply_to: 'in-1',
    });
  });

  it('reports a GuardDenyError to the requester instead of throwing', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    routeMock.mockRejectedValue(new GuardDenyError('destination revoked'));
    const notify = vi.fn();
    await applyA2aMessageGate({
      session: SESSION,
      userId: 'tg:dana',
      notify,
      payload: { id: 'held-2', platform_id: 'ag-B', content: 'x', in_reply_to: null },
      approval: APPROVAL,
    });
    expect(notify).toHaveBeenCalledWith(
      'Message approved, but not delivered — no longer authorized: destination revoked',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Approved a2a replay refused by the guard',
      expect.objectContaining({ msgId: 'held-2', reason: 'destination revoked' }),
    );
  });

  it('re-throws any other routing failure', async () => {
    routeMock.mockRejectedValue(new Error('disk on fire'));
    const notify = vi.fn();
    await expect(
      applyA2aMessageGate({
        session: SESSION,
        userId: 'tg:dana',
        notify,
        payload: { id: 'held-3', platform_id: 'ag-B', content: 'x', in_reply_to: null },
        approval: APPROVAL,
      }),
    ).rejects.toThrow('disk on fire');
    expect(notify).not.toHaveBeenCalled();
  });
});

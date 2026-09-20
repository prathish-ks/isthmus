import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  handlers: {} as Record<string, (content: Record<string, unknown>, session: unknown) => Promise<void>>,
  guards: {} as Record<string, unknown>,
  dispatch: vi.fn(),
  writeSessionMessage: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../delivery.js', () => ({
  registerDeliveryAction: (
    action: string,
    handler: (content: Record<string, unknown>, session: unknown) => Promise<void>,
    guard: unknown,
  ) => {
    state.handlers[action] = handler;
    state.guards[action] = guard;
  },
}));
vi.mock('../session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => state.writeSessionMessage(...args),
}));
vi.mock('./dispatch.js', () => ({ dispatch: (...args: unknown[]) => state.dispatch(...args) }));
vi.mock('../log.js', () => ({ log: state.log }));

import { isUnguarded } from '../guard/index.js';
import type { Session } from '../types.js';
// Side-effect import: registers the `cli_request` delivery action.
import './delivery-action.js';

const session = { id: 'sess-1', agent_group_id: 'ag-1', messaging_group_id: 'mg-1' } as Session;

beforeEach(() => {
  vi.clearAllMocks();
  state.writeSessionMessage.mockResolvedValue(undefined);
});

describe('cli_request delivery action', () => {
  it('registers as an unguarded transport envelope', () => {
    expect(state.handlers.cli_request).toBeTypeOf('function');
    expect(isUnguarded(state.guards.cli_request as object)).toBe(true);
    expect((state.guards.cli_request as { reason: string }).reason).toContain('guarded at dispatch');
  });

  it('dispatches the inner frame as the session agent and writes the response back untriggered', async () => {
    state.dispatch.mockResolvedValue({ id: 'q1', ok: true, data: { rows: 1 } });
    const before = Date.now();
    await state.handlers.cli_request({ requestId: 'q1', command: 'groups-get', args: { id: 'ag-1' } }, session);

    expect(state.dispatch).toHaveBeenCalledWith(
      { id: 'q1', command: 'groups-get', args: { id: 'ag-1' } },
      { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' },
    );
    expect(state.writeSessionMessage).toHaveBeenCalledTimes(1);
    const [group, sid, msg] = state.writeSessionMessage.mock.calls[0] as [
      string,
      string,
      { id: string; kind: string; timestamp: string; content: string; trigger: boolean },
    ];
    expect(group).toBe('ag-1');
    expect(sid).toBe('sess-1');
    expect(msg.id).toBe('cli-resp-q1');
    expect(msg.kind).toBe('system');
    expect(msg.trigger).toBe(false);
    expect(new Date(msg.timestamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(msg.content)).toEqual({
      type: 'cli_response',
      requestId: 'q1',
      frame: { id: 'q1', ok: true, data: { rows: 1 } },
    });
    expect(state.log.info).toHaveBeenCalledWith('CLI response written', {
      requestId: 'q1',
      ok: true,
      sessionId: 'sess-1',
    });
  });

  it('defaults args to {} and messagingGroupId to "" for agent-shared sessions', async () => {
    state.dispatch.mockResolvedValue({ id: 'q2', ok: false, error: { code: 'forbidden', message: 'x' } });
    await state.handlers.cli_request({ requestId: 'q2', command: 'help' }, {
      ...session,
      messaging_group_id: null,
    } as Session);
    expect(state.dispatch).toHaveBeenCalledWith(
      { id: 'q2', command: 'help', args: {} },
      { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: '' },
    );
    expect(state.log.info).toHaveBeenCalledWith('CLI response written', {
      requestId: 'q2',
      ok: false,
      sessionId: 'sess-1',
    });
  });

  it('warns and does nothing when requestId or command is missing', async () => {
    await state.handlers.cli_request({ command: 'help' }, session);
    await state.handlers.cli_request({ requestId: 'q3' }, session);
    expect(state.log.warn).toHaveBeenCalledTimes(2);
    expect(state.log.warn).toHaveBeenCalledWith('cli_request missing requestId or command', { sessionId: 'sess-1' });
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.writeSessionMessage).not.toHaveBeenCalled();
  });
});

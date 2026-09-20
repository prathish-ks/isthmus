import { describe, it, expect, vi, beforeEach } from 'vitest';

// The history custom op delegates to the cross-session-context module; this
// test pins the delegation contract (args/ctx forwarded, rows returned as
// `data`, the pipe-line rendering attached as `human`).
const state = vi.hoisted(() => ({ sessionHistory: vi.fn() }));
vi.mock('../../modules/cross-session-context/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../modules/cross-session-context/index.js')>(
    '../../modules/cross-session-context/index.js',
  );
  return { ...actual, sessionHistory: (...args: unknown[]) => state.sessionHistory(...args) };
});
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, TIMEZONE: 'UTC' };
});

import { HISTORY_DEFAULT_LIMIT } from '../../modules/cross-session-context/index.js';
import { getResource } from '../crud.js';
import { dispatch } from '../dispatch.js';
import { lookup } from '../registry.js';
// Side-effect import: registers sessions-list / sessions-get / sessions-history.
import './sessions.js';

beforeEach(() => vi.clearAllMocks());

describe('sessions history', () => {
  it('forwards validated args and the caller context, returning rows plus the human rendering', async () => {
    const rows = [
      { timestamp: '2026-01-15T09:30:00Z', direction: 'in', kind: 'chat', sender: 'dana', text: 'hi | there' },
      { timestamp: '2026-01-15T09:31:00Z', direction: 'out', kind: 'chat', sender: 'agent', text: 'hello' },
    ];
    state.sessionHistory.mockResolvedValue(rows);
    const resp = await dispatch(
      { id: 'h', command: 'sessions-history', args: { id: 'sess-1', limit: '10' } },
      { caller: 'host' },
    );
    expect(state.sessionHistory).toHaveBeenCalledWith({ id: 'sess-1', limit: 10 }, { caller: 'host' });
    expect(resp).toEqual({
      id: 'h',
      ok: true,
      data: rows,
      human: '2026-01-15 09:30|in|chat|dana|hi / there\n2026-01-15 09:31|out|chat|agent|hello',
    });
  });

  it('applies the default limit and requires --id via strict args', async () => {
    state.sessionHistory.mockResolvedValue([]);
    await dispatch({ id: 'h', command: 'sessions-history', args: { id: 'sess-1' } }, { caller: 'host' });
    expect(state.sessionHistory).toHaveBeenCalledWith(
      { id: 'sess-1', limit: HISTORY_DEFAULT_LIMIT },
      { caller: 'host' },
    );

    const missing = await dispatch({ id: 'h', command: 'sessions-history', args: {} }, { caller: 'host' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('invalid-args');
      expect(missing.error.message).toMatch(/^--id is required/);
    }
  });

  it('declares the sessions resource with the agent_group_id scope field and read-only generics', () => {
    const res = getResource('sessions')!;
    expect(res.scopeField).toBe('agent_group_id');
    expect(res.operations).toEqual({ list: 'open', get: 'open' });
    expect(lookup('sessions-create')).toBeUndefined();
    expect(lookup('sessions-history')?.formatHuman).toBeTypeOf('function');
  });
});

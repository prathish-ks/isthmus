/**
 * Coverage tests for writeDestinations — the central→session projection.
 * Every collaborator is mocked: channel rows resolve through messaging
 * groups (missing → skipped), agent rows through agent groups (missing →
 * skipped), unknown target types are ignored, and the resolved list is handed
 * to the mailbox's replaceDestinations.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  rows: [] as Array<{ agent_group_id: string; local_name: string; target_type: string; target_id: string }>,
  replaced: [] as unknown[][],
  sessions: [] as string[],
}));

vi.mock('./db/agent-destinations.js', () => ({
  getDestinations: async (agentGroupId: string) => state.rows.filter((r) => r.agent_group_id === agentGroupId),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) =>
    id === 'mg-named'
      ? { id, channel_type: 'slack', platform_id: 'C1', name: 'general' }
      : id === 'mg-unnamed'
        ? { id, channel_type: 'telegram', platform_id: '123', name: null }
        : undefined,
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => (id === 'ag-child' ? { id, name: 'Child' } : undefined),
}));
vi.mock('../../session-manager.js', () => ({
  withMailboxSession: async (agentGroupId: string, sessionId: string, fn: (db: unknown) => unknown) => {
    state.sessions.push(`${agentGroupId}/${sessionId}`);
    return fn({
      replaceDestinations: (entries: unknown[]) => {
        state.replaced.push(entries);
      },
    });
  },
}));

import { log } from '../../log.js';
import { writeDestinations } from './write-destinations.js';

beforeEach(() => {
  state.rows = [];
  state.replaced = [];
  state.sessions = [];
  vi.restoreAllMocks();
});

describe('writeDestinations', () => {
  it('projects channel and agent rows, skipping dangling targets and unknown types', async () => {
    const debugSpy = vi.spyOn(log, 'debug').mockImplementation(() => {});
    state.rows = [
      { agent_group_id: 'ag-1', local_name: 'general', target_type: 'channel', target_id: 'mg-named' },
      { agent_group_id: 'ag-1', local_name: 'tg', target_type: 'channel', target_id: 'mg-unnamed' },
      { agent_group_id: 'ag-1', local_name: 'gone-room', target_type: 'channel', target_id: 'mg-missing' },
      { agent_group_id: 'ag-1', local_name: 'child', target_type: 'agent', target_id: 'ag-child' },
      { agent_group_id: 'ag-1', local_name: 'gone-agent', target_type: 'agent', target_id: 'ag-missing' },
      { agent_group_id: 'ag-1', local_name: 'weird', target_type: 'webhook', target_id: 'x' },
      { agent_group_id: 'ag-other', local_name: 'not-mine', target_type: 'agent', target_id: 'ag-child' },
    ];

    await writeDestinations('ag-1', 'sess-1');

    expect(state.sessions).toEqual(['ag-1/sess-1']);
    expect(state.replaced).toHaveLength(1);
    expect(state.replaced[0]).toEqual([
      {
        name: 'general',
        displayName: 'general',
        type: 'channel',
        channelType: 'slack',
        platformId: 'C1',
        agentGroupId: null,
      },
      {
        name: 'tg',
        displayName: 'tg',
        type: 'channel',
        channelType: 'telegram',
        platformId: '123',
        agentGroupId: null,
      },
      {
        name: 'child',
        displayName: 'Child',
        type: 'agent',
        channelType: null,
        platformId: null,
        agentGroupId: 'ag-child',
      },
    ]);
    expect(debugSpy).toHaveBeenCalledWith('Destination map written', { sessionId: 'sess-1', count: 3 });
  });

  it('writes an empty projection when the group has no destinations', async () => {
    await writeDestinations('ag-empty', 'sess-2');
    expect(state.replaced).toEqual([[]]);
  });
});

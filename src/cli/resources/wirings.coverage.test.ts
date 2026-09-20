import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../modules/agent-to-agent/write-destinations.js', () => ({
  writeDestinations: vi.fn(),
}));

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { initTestDb, closeDb, getDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { ResponseFrame } from '../frame.js';
// Side-effect import: registers wirings-create.
import './wirings.js';

const host = { caller: 'host' as const };
const now = () => new Date().toISOString();

const declared: ChannelDefaults = {
  dm: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'strict' },
  mentions: 'platform',
};
registerChannelAdapter('covdecl', { factory: () => null, defaults: declared });

function create(args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: 'w', command: 'wirings-create', args }, host);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}

beforeEach(async () => {
  await runMigrations(await initTestDb({ fresh: true }));
  await createAgentGroup({ id: 'ag-1', name: 'One', folder: 'one', agent_provider: null, created_at: now() });
  await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
     VALUES ('mg-legacy', 'legacychan', 'p1', 'legacychan', 'legacy', 0, 'strict', ?),
            ('mg-decl', 'covdecl', 'p2', 'covdecl', 'declared', 0, 'strict', ?)`,
    now(),
    now(),
  );
});
afterEach(() => closeDb());

describe('wirings create resolution errors', () => {
  it('needs either --messaging-group-id or --channel-type + --platform-id', async () => {
    expect(errorOf(await create({ agent_group_id: 'ag-1' }))).toBe(
      'provide --messaging-group-id, or --channel-type and --platform-id to resolve it',
    );
    expect(errorOf(await create({ agent_group_id: 'ag-1', channel_type: 'legacychan' }))).toBe(
      'provide --messaging-group-id, or --channel-type and --platform-id to resolve it',
    );
  });

  it('needs either --agent-group-id or --agent-group, and the referenced agent must exist', async () => {
    expect(errorOf(await create({ messaging_group_id: 'mg-legacy' }))).toBe(
      'provide --agent-group-id or --agent-group <folder>',
    );
    expect(errorOf(await create({ messaging_group_id: 'mg-legacy', agent_group: 'nope' }))).toBe(
      'no agent group "nope" (by id or folder)',
    );
  });

  it('rejects enum violations on explicit engage flags before writing', async () => {
    expect(
      errorOf(await create({ messaging_group_id: 'mg-legacy', agent_group_id: 'ag-1', session_mode: 'bogus' })),
    ).toBe('session_mode must be one of: shared, per-thread, agent-shared');
    expect(await getDb().all('SELECT * FROM messaging_group_agents')).toEqual([]);
  });

  it('reports an unknown --messaging-group-id when no wiring exists for it yet', async () => {
    expect(errorOf(await create({ messaging_group_id: 'mg-missing', agent_group_id: 'ag-1' }))).toBe(
      'messaging group not found: mg-missing',
    );
  });

  it('on a declared channel, a dangling --agent-group-id fails when resolving the {name} default', async () => {
    // Explicit id skips the folder lookup; the declaration resolver then
    // needs the agent name and finds no row.
    expect(errorOf(await create({ messaging_group_id: 'mg-decl', agent_group_id: 'ag-ghost' }))).toBe(
      'agent group not found: ag-ghost',
    );
    expect(await getDb().all('SELECT * FROM messaging_group_agents')).toEqual([]);
  });

  it('resolves the agent by folder and creates the wiring once', async () => {
    const first = await create({ channel_type: 'legacychan', platform_id: 'p1', agent_group: 'one' });
    expect(first.ok).toBe(true);
    const again = await create({ channel_type: 'legacychan', platform_id: 'p1', agent_group: 'ag-1' });
    expect(again.ok && (again.data as { id: string }).id).toBe(first.ok && (first.data as { id: string }).id);
    expect(await getDb().all('SELECT * FROM messaging_group_agents')).toHaveLength(1);
  });
});

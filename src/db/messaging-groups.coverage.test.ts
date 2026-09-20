/**
 * Coverage-uplift tests for db/messaging-groups.ts targeting branches the
 * pre-existing db/messaging-groups-instance.test.ts and router/delivery
 * integration suites don't reach: getMessagingGroupForOwnDestination
 * without the agent_destinations module, updateMessagingGroup/
 * updateMessagingGroupAgent's empty-updates early return, delete helpers,
 * isMessagingGroupDetached, ensureAgentDestinationForWiring (missing mg,
 * no-op module-absent path, and the local-name collision retry), and the
 * remaining plain read helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './index.js';
import { getDb } from './connection.js';
import { createDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import {
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  ensureAgentDestinationForWiring,
  getMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupForOwnDestination,
  getMessagingGroupsByAgentGroup,
  isMessagingGroupDetached,
  updateMessagingGroup,
  updateMessagingGroupAgent,
} from './messaging-groups.js';
import type { MessagingGroup, MessagingGroupAgent } from '../types.js';

function now(): string {
  return new Date().toISOString();
}

function mg(overrides: Partial<MessagingGroup> & { id: string }): MessagingGroup {
  return {
    channel_type: 'slack',
    platform_id: `slack:${overrides.id}`,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
    ...overrides,
  };
}

function mga(
  overrides: Partial<MessagingGroupAgent> & { id: string; messaging_group_id: string; agent_group_id: string },
): MessagingGroupAgent {
  return {
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at: now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('getMessagingGroupForOwnDestination', () => {
  it('returns undefined when the agent_destinations module is not installed', async () => {
    await getDb().run('DROP TABLE agent_destinations');
    const result = await getMessagingGroupForOwnDestination('ag-1', 'slack', 'slack:C1');
    expect(result).toBeUndefined();
  });

  it('resolves the messaging group targeted by the sender-owned destination', async () => {
    await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    await createMessagingGroup(mg({ id: 'mg-own', platform_id: 'slack:C1' }));
    await createDestination({
      agent_group_id: 'ag-1',
      local_name: 'own',
      target_type: 'channel',
      target_id: 'mg-own',
      created_at: now(),
    });
    const result = await getMessagingGroupForOwnDestination('ag-1', 'slack', 'slack:C1');
    expect(result?.id).toBe('mg-own');
  });
});

describe('updateMessagingGroup', () => {
  it('is a no-op when the updates object is empty', async () => {
    await createMessagingGroup(mg({ id: 'mg-noop', name: 'Original' }));
    await updateMessagingGroup('mg-noop', {});
    const row = await getDb().get<{ name: string | null }>('SELECT name FROM messaging_groups WHERE id = ?', 'mg-noop');
    expect(row?.name).toBe('Original');
  });

  it('updates the provided fields', async () => {
    await createMessagingGroup(mg({ id: 'mg-upd', name: 'Old' }));
    await updateMessagingGroup('mg-upd', { name: 'New', is_group: 1 });
    const row = await getDb().get<{ name: string; is_group: number }>(
      'SELECT name, is_group FROM messaging_groups WHERE id = ?',
      'mg-upd',
    );
    expect(row).toEqual({ name: 'New', is_group: 1 });
  });
});

describe('deleteMessagingGroup', () => {
  it('removes the row', async () => {
    await createMessagingGroup(mg({ id: 'mg-del' }));
    await deleteMessagingGroup('mg-del');
    const row = await getDb().get('SELECT 1 FROM messaging_groups WHERE id = ?', 'mg-del');
    expect(row).toBeUndefined();
  });
});

describe('isMessagingGroupDetached', () => {
  it('is false when detached_at is unset and true once set', async () => {
    await createMessagingGroup(mg({ id: 'mg-detach' }));
    expect(await isMessagingGroupDetached('mg-detach')).toBe(false);
    await getDb().run('UPDATE messaging_groups SET detached_at = ? WHERE id = ?', now(), 'mg-detach');
    expect(await isMessagingGroupDetached('mg-detach')).toBe(true);
  });

  it('is false for a nonexistent id', async () => {
    expect(await isMessagingGroupDetached('mg-does-not-exist')).toBe(false);
  });
});

describe('ensureAgentDestinationForWiring', () => {
  it('is a no-op when the agent_destinations module is not installed', async () => {
    await createAgentGroup({ id: 'ag-nodest', name: 'A', folder: 'a-nodest', agent_provider: null, created_at: now() });
    await createMessagingGroup(mg({ id: 'mg-nodest' }));
    const wiring = mga({ id: 'mga-nodest', messaging_group_id: 'mg-nodest', agent_group_id: 'ag-nodest' });
    await getDb().run('DROP TABLE agent_destinations');
    await expect(ensureAgentDestinationForWiring(wiring)).resolves.toBeUndefined();
  });

  it('is a no-op when the messaging group no longer exists', async () => {
    await createAgentGroup({ id: 'ag-nomg', name: 'A', folder: 'a-nomg', agent_provider: null, created_at: now() });
    const wiring = mga({ id: 'mga-nomg', messaging_group_id: 'mg-does-not-exist', agent_group_id: 'ag-nomg' });
    await expect(ensureAgentDestinationForWiring(wiring)).resolves.toBeUndefined();
  });

  it('creates a destination row named after the messaging group', async () => {
    await createAgentGroup({ id: 'ag-dest', name: 'A', folder: 'a-dest', agent_provider: null, created_at: now() });
    await createMessagingGroup(mg({ id: 'mg-dest', name: 'General' }));
    const wiring = mga({ id: 'mga-dest', messaging_group_id: 'mg-dest', agent_group_id: 'ag-dest' });
    await ensureAgentDestinationForWiring(wiring);
    const row = await getDb().get<{ local_name: string }>(
      'SELECT local_name FROM agent_destinations WHERE agent_group_id = ? AND target_id = ?',
      'ag-dest',
      'mg-dest',
    );
    expect(row?.local_name).toBe('general');
  });

  it('is idempotent — a second call for the same wiring does not throw or duplicate', async () => {
    await createAgentGroup({ id: 'ag-idem', name: 'A', folder: 'a-idem', agent_provider: null, created_at: now() });
    await createMessagingGroup(mg({ id: 'mg-idem', name: 'General' }));
    const wiring = mga({ id: 'mga-idem', messaging_group_id: 'mg-idem', agent_group_id: 'ag-idem' });
    await ensureAgentDestinationForWiring(wiring);
    await ensureAgentDestinationForWiring(wiring);
    const rows = await getDb().all(
      'SELECT local_name FROM agent_destinations WHERE agent_group_id = ? AND target_id = ?',
      'ag-idem',
      'mg-idem',
    );
    expect(rows).toHaveLength(1);
  });

  it('appends a numeric suffix when the local name collides with a different target', async () => {
    await createAgentGroup({
      id: 'ag-collide',
      name: 'A',
      folder: 'a-collide',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup(mg({ id: 'mg-collide-1', name: 'General' }));
    await createMessagingGroup(mg({ id: 'mg-collide-2', name: 'General' }));
    await ensureAgentDestinationForWiring(
      mga({ id: 'mga-collide-1', messaging_group_id: 'mg-collide-1', agent_group_id: 'ag-collide' }),
    );
    await ensureAgentDestinationForWiring(
      mga({ id: 'mga-collide-2', messaging_group_id: 'mg-collide-2', agent_group_id: 'ag-collide' }),
    );
    const names = (
      await getDb().all<{ local_name: string }>(
        'SELECT local_name FROM agent_destinations WHERE agent_group_id = ? ORDER BY local_name',
        'ag-collide',
      )
    ).map((r) => r.local_name);
    expect(names).toEqual(['general', 'general-2']);
  });
});

describe('messaging_group_agents read/update/delete helpers', () => {
  beforeEach(async () => {
    await createAgentGroup({ id: 'ag-mga', name: 'A', folder: 'a-mga', agent_provider: null, created_at: now() });
    await createMessagingGroup(mg({ id: 'mg-mga' }));
    await createMessagingGroupAgent(
      mga({ id: 'mga-1', messaging_group_id: 'mg-mga', agent_group_id: 'ag-mga', priority: 5 }),
    );
  });

  it('getMessagingGroupAgents orders by priority desc', async () => {
    await createAgentGroup({ id: 'ag-mga-2', name: 'A2', folder: 'a-mga-2', agent_provider: null, created_at: now() });
    await createMessagingGroupAgent(
      mga({ id: 'mga-2', messaging_group_id: 'mg-mga', agent_group_id: 'ag-mga-2', priority: 10 }),
    );
    const rows = await getMessagingGroupAgents('mg-mga');
    expect(rows.map((r) => r.id)).toEqual(['mga-2', 'mga-1']);
  });

  it('getMessagingGroupAgentByPair finds the wiring for a (mg, agent) pair', async () => {
    const row = await getMessagingGroupAgentByPair('mg-mga', 'ag-mga');
    expect(row?.id).toBe('mga-1');
    expect(await getMessagingGroupAgentByPair('mg-mga', 'ag-nonexistent')).toBeUndefined();
  });

  it('getMessagingGroupAgent finds by id', async () => {
    expect((await getMessagingGroupAgent('mga-1'))?.messaging_group_id).toBe('mg-mga');
    expect(await getMessagingGroupAgent('no-such-id')).toBeUndefined();
  });

  it('updateMessagingGroupAgent is a no-op for empty updates and applies provided fields', async () => {
    await updateMessagingGroupAgent('mga-1', {});
    expect((await getMessagingGroupAgent('mga-1'))?.priority).toBe(5);
    await updateMessagingGroupAgent('mga-1', { priority: 99 });
    expect((await getMessagingGroupAgent('mga-1'))?.priority).toBe(99);
  });

  it('deleteMessagingGroupAgent removes the row', async () => {
    await deleteMessagingGroupAgent('mga-1');
    expect(await getMessagingGroupAgent('mga-1')).toBeUndefined();
  });

  it('getMessagingGroupsByAgentGroup reverse-looks-up wired messaging groups', async () => {
    const groups = await getMessagingGroupsByAgentGroup('ag-mga');
    expect(groups.map((g) => g.id)).toEqual(['mg-mga']);
    expect(await getMessagingGroupsByAgentGroup('ag-unwired')).toEqual([]);
  });
});

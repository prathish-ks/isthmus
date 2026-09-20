/**
 * Coverage-uplift tests for db/container-configs.ts targeting branches the
 * pre-existing container-configs.test.ts suite doesn't reach:
 * getAllContainerConfigs, updateContainerConfigScalars' invalid-column
 * throw and empty-updates no-op, updateContainerConfigJson's invalid-column
 * throw, and deleteContainerConfig.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { createAgentGroup } from './agent-groups.js';
import {
  deleteContainerConfig,
  ensureContainerConfig,
  getAllContainerConfigs,
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from './container-configs.js';

async function makeGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});
afterEach(async () => {
  await closeDb();
});

describe('getAllContainerConfigs', () => {
  it('returns every config row', async () => {
    await makeGroup('ag-1');
    await makeGroup('ag-2');
    await ensureContainerConfig('ag-1');
    await ensureContainerConfig('ag-2');
    const rows = await getAllContainerConfigs();
    expect(rows.map((r) => r.agent_group_id).sort()).toEqual(['ag-1', 'ag-2']);
  });

  it('returns an empty array when no config rows exist', async () => {
    expect(await getAllContainerConfigs()).toEqual([]);
  });
});

describe('updateContainerConfigScalars', () => {
  it('is a no-op when updates is empty', async () => {
    await makeGroup('ag-noop');
    await ensureContainerConfig('ag-noop');
    const before = await getContainerConfig('ag-noop');
    await updateContainerConfigScalars('ag-noop', {});
    const after = await getContainerConfig('ag-noop');
    expect(after?.updated_at).toBe(before?.updated_at);
  });

  it('throws for an unrecognized scalar column', async () => {
    await makeGroup('ag-bad');
    await ensureContainerConfig('ag-bad');
    await expect(updateContainerConfigScalars('ag-bad', { ['not_a_real_column' as never]: 'x' })).rejects.toThrow(
      'Invalid scalar column: not_a_real_column',
    );
  });
});

describe('updateContainerConfigJson', () => {
  it('throws for an unrecognized JSON column', async () => {
    await makeGroup('ag-badjson');
    await ensureContainerConfig('ag-badjson');
    await expect(updateContainerConfigJson('ag-badjson', 'not_a_json_column' as never, [])).rejects.toThrow(
      'Invalid JSON column: not_a_json_column',
    );
  });

  it('overwrites a recognized JSON column', async () => {
    await makeGroup('ag-json');
    await ensureContainerConfig('ag-json');
    await updateContainerConfigJson('ag-json', 'skills', ['skill-a']);
    const row = await getContainerConfig('ag-json');
    expect(JSON.parse(row!.skills)).toEqual(['skill-a']);
  });
});

describe('deleteContainerConfig', () => {
  it('removes the row', async () => {
    await makeGroup('ag-del');
    await ensureContainerConfig('ag-del');
    await deleteContainerConfig('ag-del');
    expect(await getContainerConfig('ag-del')).toBeUndefined();
  });
});

// Kept for parity with container-configs.test.ts's direct getDb usage pattern.
describe('sanity: getDb is usable after initTestDb', () => {
  it('reports the sqlite dialect', () => {
    expect(getDb().dialect).toBe('sqlite');
  });
});

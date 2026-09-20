/** Coverage tests for the agent_destinations helpers not driven by the routing tests. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../../db/index.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
  getDestinationByTarget,
  getDestinationReferencers,
  getDestinations,
  hasDestination,
  normalizeName,
} from './agent-destinations.js';
import { getMessagePolicy, setMessagePolicy } from './agent-message-policies.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  for (const id of ['ag-A', 'ag-B', 'ag-C']) {
    await createAgentGroup({ id, name: id, folder: id.toLowerCase(), agent_provider: null, created_at: now() });
  }
  await createDestination({
    agent_group_id: 'ag-A',
    local_name: 'b',
    target_type: 'agent',
    target_id: 'ag-B',
    created_at: now(),
  });
  await createDestination({
    agent_group_id: 'ag-A',
    local_name: 'room',
    target_type: 'channel',
    target_id: 'mg-1',
    created_at: now(),
  });
  await createDestination({
    agent_group_id: 'ag-C',
    local_name: 'bee',
    target_type: 'agent',
    target_id: 'ag-B',
    created_at: now(),
  });
  await createDestination({
    agent_group_id: 'ag-B',
    local_name: 'me',
    target_type: 'agent',
    target_id: 'ag-B',
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('agent_destinations helpers', () => {
  it('getDestinations lists the owner rows only', async () => {
    expect((await getDestinations('ag-A')).map((d) => d.local_name).sort()).toEqual(['b', 'room']);
    expect(await getDestinations('ag-none')).toEqual([]);
  });

  it('getDestinationByName / getDestinationByTarget resolve both directions', async () => {
    expect(await getDestinationByName('ag-A', 'b')).toMatchObject({ target_type: 'agent', target_id: 'ag-B' });
    expect(await getDestinationByName('ag-A', 'nope')).toBeUndefined();
    expect(await getDestinationByTarget('ag-A', 'channel', 'mg-1')).toMatchObject({ local_name: 'room' });
    expect(await getDestinationByTarget('ag-A', 'agent', 'mg-1')).toBeUndefined();
    expect(await hasDestination('ag-A', 'channel', 'mg-1')).toBe(true);
  });

  it('getDestinationReferencers lists distinct other groups pointing at the target, excluding itself', async () => {
    expect((await getDestinationReferencers('ag-B')).sort()).toEqual(['ag-A', 'ag-C']);
    expect(await getDestinationReferencers('ag-A')).toEqual([]);
  });

  it('deleteDestination on a channel row leaves agent message policies untouched', async () => {
    await setMessagePolicy('ag-A', 'ag-B', 'tg:dana', now());
    await deleteDestination('ag-A', 'room');
    expect(await getDestinationByName('ag-A', 'room')).toBeUndefined();
    expect(await getMessagePolicy('ag-A', 'ag-B')).toBeDefined();

    // Deleting a name that does not exist is a no-op.
    await deleteDestination('ag-A', 'missing');
    expect(await getDestinations('ag-A')).toHaveLength(1);
  });

  it('normalizeName lowercases, dashes, trims, and falls back to "unnamed"', () => {
    expect(normalizeName('  My Agent!! ')).toBe('my-agent');
    expect(normalizeName('***')).toBe('unnamed');
  });
});

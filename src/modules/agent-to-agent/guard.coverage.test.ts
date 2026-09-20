/**
 * Coverage tests for the agent-to-agent guard adapter: the actor-kind
 * denials, the missing-target denial, the grant-binding parse failures, and
 * the empty-resource fallback — driven directly through guard() against an
 * in-memory central DB.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { guard } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';
import { createDestination } from './db/agent-destinations.js';
import { a2aSend, agentsCreate } from './guard.js';

function now(): string {
  return new Date().toISOString();
}

function grantWithPayload(payload: string): PendingApproval {
  return { approval_id: 'appr-1', action: 'x', payload } as PendingApproval;
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-A', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
});

afterEach(async () => {
  await closeDb();
});

describe('agents.create', () => {
  it('denies non-agent actors outright', async () => {
    const d = await guard(agentsCreate, { actor: { kind: 'human', userId: 'tg:u' }, payload: { name: 'Scout' } });
    expect(d).toEqual({ effect: 'deny', reason: 'create_agent is a container-originated action.' });
  });

  it('grantCoversRequest binds on the approved name and treats an unparseable grant payload as no cover', () => {
    const input = { actor: { kind: 'agent' as const, agentGroupId: 'ag-A' }, payload: { name: 'Scout' } };
    expect(agentsCreate.grantCoversRequest!(grantWithPayload(JSON.stringify({ name: 'Scout' })), input)).toBe(true);
    expect(agentsCreate.grantCoversRequest!(grantWithPayload(JSON.stringify({ name: 'Other' })), input)).toBe(false);
    expect(agentsCreate.grantCoversRequest!(grantWithPayload('not json'), input)).toBe(false);
  });
});

describe('a2a.send', () => {
  it('denies non-agent actors', async () => {
    const d = await guard(a2aSend, {
      actor: { kind: 'host' },
      resource: { from: 'ag-A', to: 'ag-A' },
      payload: { id: 'm1' },
    });
    expect(d).toEqual({ effect: 'deny', reason: 'agent-to-agent send requires an agent actor' });
  });

  it('denies when the target agent group does not exist even though a destination row grants it', async () => {
    await createDestination({
      agent_group_id: 'ag-A',
      local_name: 'ghost',
      target_type: 'agent',
      target_id: 'ag-ghost',
      created_at: now(),
    });
    const d = await guard(a2aSend, {
      actor: { kind: 'agent', agentGroupId: 'ag-A' },
      resource: { from: 'ag-A', to: 'ag-ghost' },
      payload: { id: 'm-77' },
    });
    expect(d).toEqual({ effect: 'deny', reason: 'target agent group ag-ghost not found for message m-77' });
  });

  it('reads a missing resource as an empty target and denies for lack of a destination', async () => {
    const d = await guard(a2aSend, { actor: { kind: 'agent', agentGroupId: 'ag-A' }, payload: { id: 'm1' } });
    expect(d).toEqual({ effect: 'deny', reason: 'unauthorized agent-to-agent: ag-A has no destination for ' });
  });

  it('grantCoversRequest binds on the held target and treats an unparseable grant payload as no cover', () => {
    const input = {
      actor: { kind: 'agent' as const, agentGroupId: 'ag-A' },
      resource: { from: 'ag-A', to: 'ag-B' },
      payload: {},
    };
    expect(a2aSend.grantCoversRequest!(grantWithPayload(JSON.stringify({ platform_id: 'ag-B' })), input)).toBe(true);
    expect(a2aSend.grantCoversRequest!(grantWithPayload(JSON.stringify({ platform_id: 'ag-C' })), input)).toBe(false);
    expect(a2aSend.grantCoversRequest!(grantWithPayload('{oops'), input)).toBe(false);
  });
});

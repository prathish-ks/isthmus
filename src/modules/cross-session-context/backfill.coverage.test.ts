/**
 * Coverage-uplift tests for backfill.ts, closing gaps left by
 * backfill.test.ts:
 *  - parseContent's JSON.parse failure fallback (falsy c.text -> the row is
 *    skipped, both for the root candidate and for outbound candidates)
 *  - each leg of the root-row admission guard (text present, senderId
 *    !== 'system', sender !== 'system', and the "System instruction:" prefix
 *    filter) exercised in isolation
 *  - the `??` fallbacks for a root row's sender/senderId when absent
 *  - thread_id === null short-circuiting the task-session check
 *  - zero eligible rows across all siblings (newest.length === 0 -> no write)
 *  - the outer defensive try/catch (never throws; writes nothing on failure)
 *
 * Mirrors backfill.test.ts's mocking style (session-manager.js + db/sessions.js
 * mocked with in-memory fixtures) so it reuses the same harness conventions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const written: Array<Record<string, unknown>> = [];

let inboundRows: Array<{ timestamp: string; content: string }> = [];
let outboundRows: Array<{ timestamp: string; content: string }> = [];
let siblingSessions: Array<{ id: string; status: string; messaging_group_id: string | null }> = [];
let throwOnSiblingLookup = false;
/** When set, withExistingMailboxSession returns undefined for this exact
 *  sibling session id — simulating a sibling whose mailbox was never
 *  provisioned (the real implementation's `store.exists()` false path). */
let noMailboxForSessionId: string | null = null;

vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) => {
    if (sessionId === noMailboxForSessionId) return undefined;
    return fn({
      getConversationRoot: () => inboundRows[0],
      getTopLevelOutbound: () => outboundRows,
    });
  },
  writeSessionMessage: async (agentGroupId: string, sessionId: string, msg: Record<string, unknown>) => {
    written.push({ agentGroupId, sessionId, ...msg });
  },
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => {
    if (throwOnSiblingLookup) throw new Error('sibling lookup boom');
    return siblingSessions;
  },
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));

const { backfillNewSession } = await import('./backfill.js');

const AG = { id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: '' } as never;
const DM_MG = { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', is_group: 0 } as never;

function chat(text: string, sender = 'Gavriel', senderId = 'U1'): string {
  return JSON.stringify({ text, sender, senderId });
}

beforeEach(() => {
  written.length = 0;
  inboundRows = [];
  outboundRows = [];
  siblingSessions = [{ id: 'sess-old', status: 'active', messaging_group_id: 'mg-dm' }];
  throwOnSiblingLookup = false;
  noMailboxForSessionId = null;
});

describe('backfillNewSession — parseContent JSON fallback', () => {
  it('a non-JSON root row has no text and is silently skipped', async () => {
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: 'not json at all' }];
    outboundRows = [];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(0);
  });

  it('a non-JSON outbound row has no text and is silently skipped', async () => {
    inboundRows = [];
    outboundRows = [{ timestamp: '2026-08-01T19:14:00Z', content: 'also not json' }];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(0);
  });
});

describe('backfillNewSession — root-row admission guard, isolated legs', () => {
  const NEW_SESSION = { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never;

  it('excludes a root whose senderId is "system" even when sender is not', async () => {
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('hi there', 'Somebody', 'system') }];
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });

  it('excludes a root whose sender is "system" even when senderId is not', async () => {
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('hi there', 'system', 'U-other') }];
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });

  it('excludes a root whose text starts with "System instruction:" even from a normal sender', async () => {
    inboundRows = [
      { timestamp: '2026-08-01T19:10:00Z', content: chat('System instruction: run /welcome', 'Owner', 'owner-1') },
    ];
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });

  it('admits a normal root and fills sender/senderId defaults when absent from the payload', async () => {
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: JSON.stringify({ text: 'no sender fields here' }) }];
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(1);
    const content = JSON.parse(written[0]!.content as string) as Record<string, unknown>;
    expect(content.text).toBe('no sender fields here');
    expect(content.sender).toBe('user');
    expect(content.senderId).toBe('');
    expect(content.self).toBeUndefined();
  });
});

describe('backfillNewSession — thread_id null short-circuits the task check', () => {
  it('a session with thread_id null is never mistaken for a task session', async () => {
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('hello') }];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(1);
  });
});

describe('backfillNewSession — no eligible rows across any sibling', () => {
  it('writes nothing when every sibling contributes zero rows', async () => {
    inboundRows = [];
    outboundRows = [];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(0);
  });
});

describe('backfillNewSession — outer defensive try/catch', () => {
  it('never throws and writes nothing when sibling collection fails unexpectedly', async () => {
    throwOnSiblingLookup = true;
    await expect(
      backfillNewSession(
        AG,
        { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
        DM_MG,
      ),
    ).resolves.toBeUndefined();
    expect(written).toHaveLength(0);
  });
});

describe('collectSiblingTopLevel — unprovisioned sibling mailbox', () => {
  it('a sibling whose mailbox was never provisioned contributes zero rows (no throw)', async () => {
    siblingSessions = [{ id: 'sess-no-mailbox', status: 'active', messaging_group_id: 'mg-dm' }];
    noMailboxForSessionId = 'sess-no-mailbox';
    // Fixture content is irrelevant here — withExistingMailboxSession itself
    // returns undefined for this sibling, short-circuiting before either is read.
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('unreachable') }];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(0);
  });
});

describe('backfillNewSession — sort comparator, all three branches', () => {
  it('hits the ">" branch when a root timestamp is later than the outbound timestamp in the same sibling', async () => {
    // Single sibling contributing exactly 2 rows pre-sort: root at the LATER
    // timestamp (pushed first), outbound at the EARLIER timestamp (pushed
    // second) — forces the comparator's a.timestamp > b.timestamp arm.
    inboundRows = [{ timestamp: '2026-08-01T19:20:00Z', content: chat('root said later') }];
    outboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: JSON.stringify({ text: 'agent posted earlier' }) }];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(2);
    const texts = written.map((w) => (JSON.parse(w.content as string) as { text: string }).text);
    // Sorted ascending by timestamp despite push order: earlier first.
    expect(texts).toEqual(['agent posted earlier', 'root said later']);
  });

  it('hits the "=" branch when two siblings contribute rows at the exact same timestamp', async () => {
    // Two siblings, no outbound rows, so each contributes exactly its root —
    // 2 elements total, same timestamp (the mock fixtures are shared across
    // sibling ids), guaranteeing the comparator is invoked on an equal pair.
    siblingSessions = [
      { id: 'sess-old-a', status: 'active', messaging_group_id: 'mg-dm' },
      { id: 'sess-old-b', status: 'active', messaging_group_id: 'mg-dm' },
    ];
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('same instant') }];
    outboundRows = [];
    await backfillNewSession(
      AG,
      { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-dm', thread_id: null } as never,
      DM_MG,
    );
    expect(written).toHaveLength(2);
    for (const w of written) {
      expect((JSON.parse(w.content as string) as { text: string }).text).toBe('same instant');
    }
  });
});

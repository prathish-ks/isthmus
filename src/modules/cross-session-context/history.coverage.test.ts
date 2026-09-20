/**
 * Coverage-uplift tests for history.ts, closing gaps left by history.test.ts:
 *  - required-id validation (missing / empty)
 *  - the limit-parsing fallback (non-finite / non-positive -> default)
 *  - the agent-group-name `?? 'agent'` fallback
 *  - `withExistingMailboxSession` returning undefined (mailbox never
 *    provisioned) -> empty rows, no throw
 *  - parseText's non-JSON catch fallback, the `[action]` fallback when text
 *    is absent, the fully-empty fallback, and the sender `?? ''` fallback
 *  - the sort comparator's equal-timestamp (0) branch
 *  - formatHistoryLines's default `timezone` parameter
 *
 * Reuses history.test.ts's real-DB + real-mailbox harness (only DATA_DIR is
 * mocked) so these exercise the actual mailbox/session-manager code paths,
 * and adds a narrow partial mock of db/agent-groups.js to simulate a missing
 * agent group without violating the sessions table's FK constraint.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-history-cov' };
});

vi.mock('../../db/agent-groups.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/agent-groups.js')>('../../db/agent-groups.js');
  return {
    ...actual,
    getAgentGroup: (id: string) => (id === 'ag-ghost' ? Promise.resolve(undefined) : actual.getAgentGroup(id)),
  };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import type { CallerContext } from '../../cli/frame.js';
import { formatHistoryLines, sessionHistory } from './history.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-history-cov';
const AG = 'ag-hist';
const AG_GHOST = 'ag-ghost';
const SESS = 'sess-hist';
const SESS_UNPROVISIONED = 'sess-hist-unprovisioned';
const SESS_GHOST = 'sess-hist-ghost';

const HOST: CallerContext = { caller: 'host' };

async function writeInbound(id: string, timestamp: string, content: string): Promise<void> {
  await writeSessionMessage(AG, SESS, {
    id,
    kind: 'chat',
    timestamp,
    platformId: 'D1',
    channelType: 'slack',
    threadId: null,
    content,
  });
}

function chat(text: string, sender = 'Gavriel'): string {
  return JSON.stringify({ text, sender, senderId: 'slack:U1' });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Pixel',
    folder: 'pixel',
    agent_provider: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  // Real row so the FK on sessions.agent_group_id is satisfied; the
  // getAgentGroup mock above makes lookups against this id resolve to
  // undefined anyway, simulating "group vanished after the session was made".
  await createAgentGroup({
    id: AG_GHOST,
    name: 'Ghost',
    folder: 'ghost',
    agent_provider: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  initSessionFolder(AG, SESS);

  // Deliberately NOT initSessionFolder'd: mailbox files never provisioned.
  await createSession({
    id: SESS_UNPROVISIONED,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });

  await createSession({
    id: SESS_GHOST,
    agent_group_id: AG_GHOST,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  initSessionFolder(AG_GHOST, SESS_GHOST);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('sessionHistory — id validation', () => {
  it('throws when id is missing', async () => {
    await expect(sessionHistory({}, HOST)).rejects.toThrow('session id is required');
  });

  it('throws when id is an empty string', async () => {
    await expect(sessionHistory({ id: '' }, HOST)).rejects.toThrow('session id is required');
  });
});

describe('sessionHistory — limit fallback', () => {
  it('falls back to the default limit when limit is non-finite', async () => {
    for (let i = 0; i < 3; i++) {
      await writeInbound(`in-${i}`, `2026-08-01T10:0${i}:00.000Z`, chat(`msg ${i}`));
    }
    const rows = await sessionHistory({ id: SESS, limit: 'not-a-number' }, HOST);
    expect(rows).toHaveLength(3);
  });

  it('falls back to the default limit when limit is zero/non-positive', async () => {
    for (let i = 0; i < 3; i++) {
      await writeInbound(`in2-${i}`, `2026-08-01T11:0${i}:00.000Z`, chat(`msg ${i}`));
    }
    const rows = await sessionHistory({ id: SESS, limit: 0 }, HOST);
    expect(rows).toHaveLength(3);
  });
});

describe('sessionHistory — agent-group-name fallback', () => {
  it('renders outbound sender as "agent" when the agent group cannot be resolved', async () => {
    await writeOutboundDirect(AG_GHOST, SESS_GHOST, {
      id: 'out-ghost-1',
      kind: 'chat',
      platformId: 'D1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'reply from a vanished group' }),
    });
    const rows = await sessionHistory({ id: SESS_GHOST }, HOST);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('out');
    expect(rows[0].sender).toBe('agent');
  });
});

describe('sessionHistory — unprovisioned mailbox', () => {
  it('returns an empty array without throwing when the mailbox was never provisioned', async () => {
    const rows = await sessionHistory({ id: SESS_UNPROVISIONED }, HOST);
    expect(rows).toEqual([]);
  });
});

describe('sessionHistory — parseText edge cases', () => {
  it('falls back to the raw string as text with a null sender when content is not JSON', async () => {
    await writeInbound('in-raw', '2026-08-01T10:00:00.000Z', 'plain raw text, not json');
    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('plain raw text, not json');
    expect(rows[0].sender).toBe('');
  });

  it('renders "[action]" when text is absent but action is present', async () => {
    await writeInbound('in-action', '2026-08-01T10:00:00.000Z', JSON.stringify({ action: 'typing' }));
    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('[typing]');
  });

  it('renders an empty string when neither text nor action is present', async () => {
    await writeInbound('in-empty', '2026-08-01T10:00:00.000Z', JSON.stringify({ foo: 'bar' }));
    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('');
    expect(rows[0].sender).toBe('');
  });
});

describe('sessionHistory — sort comparator equal-timestamp branch', () => {
  it('keeps both rows when two entries share the exact same timestamp', async () => {
    const ts = '2026-08-01T10:00:00.000Z';
    await writeInbound('in-tie-1', ts, chat('first', 'Gavriel'));
    await writeInbound('in-tie-2', ts, chat('second', 'Gavriel'));
    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.text).sort()).toEqual(['first', 'second']);
  });
});

describe('formatHistoryLines — default timezone parameter', () => {
  it('renders without a timezone argument, falling back to the install TIMEZONE', async () => {
    await writeInbound('in-tz', '2026-08-01T10:00:00.000Z', chat('hello there'));
    const rows = await sessionHistory({ id: SESS }, HOST);
    const line = formatHistoryLines(rows);
    expect(line.endsWith('|in|chat|Gavriel|hello there')).toBe(true);
  });
});

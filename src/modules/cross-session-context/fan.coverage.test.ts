/**
 * Coverage-uplift tests for fan.ts, closing the gaps left by fan.test.ts:
 *  - parseContent's JSON.parse failure fallback (raw text passthrough)
 *  - per-target write-failure isolation inside fanEcho (one broken target
 *    logs and is skipped; siblings still get written)
 *  - the outer try/catch of fanInboundMessage / fanOutboundMessage (never
 *    throws; returns 0 on unexpected failure)
 *
 * Reuses the same fixtures/helpers style as fan.test.ts (real session
 * folders on disk + an in-memory central DB), plus a partial mock of
 * db/sessions.js so one agent-group id can be made to blow up
 * getSessionsByAgentGroup on demand, exercising the defensive outer catch
 * without disturbing any other test in this file.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-fan-cov' };
});

let throwForAgentGroup: string | null = null;
vi.mock('../../db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('../../db/sessions.js')>('../../db/sessions.js');
  return {
    ...actual,
    getSessionsByAgentGroup: (agentGroupId: string) => {
      if (agentGroupId === throwForAgentGroup) throw new Error('sessions lookup boom');
      return actual.getSessionsByAgentGroup(agentGroupId);
    },
  };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { echoRowId, fanInboundMessage, fanOutboundMessage } from './fan.js';
import { ECHO_CHANNEL_TYPE } from './config.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-fan-cov';
const AG = 'ag-1';
const NOW = new Date().toISOString();

function mg(id: string, platformId: string, isGroup: number, name: string | null): MessagingGroup {
  return {
    id,
    channel_type: 'slack',
    platform_id: platformId,
    instance: 'slack',
    name,
    is_group: isGroup,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: NOW,
  };
}

function session(
  id: string,
  agentGroupId: string,
  mgId: string | null,
  threadId: string | null,
  status: 'active' | 'closed' = 'active',
): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status,
    container_status: 'stopped',
    last_active: null,
    created_at: NOW,
  };
}

const DM_MG = mg('mg-dm', 'D456', 0, 'Gavriel');
const SRC_DM = session('s-dm', AG, 'mg-dm', null);
const DM_SIBLING = session('s-dm-t2', AG, 'mg-dm', '1723456.789');
const DM_SIBLING2 = session('s-dm-t3', AG, 'mg-dm', '1723456.999');

function readEchoRows(sessionId: string): Array<Record<string, unknown>> {
  const dbPath = inboundDbPath(AG, sessionId);
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM messages_in WHERE channel_type = ? ORDER BY seq').all(ECHO_CHANNEL_TYPE) as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  throwForAgentGroup = null;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: NOW });
  await createMessagingGroup(DM_MG);
  await createSession(SRC_DM);
  await createSession(DM_SIBLING);
  await createSession(DM_SIBLING2);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('fan.ts parseContent JSON fallback', () => {
  it('falls back to the raw string as text (and null sender/senderId) when content is not JSON', async () => {
    const written = await fanInboundMessage({
      session: SRC_DM,
      mg: DM_MG,
      messageId: 'msg-raw:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: 'plain text, not json at all',
      timestamp: NOW,
    });
    // Both siblings (s-dm-t2, s-dm-t3) are same-mg targets.
    expect(written).toBe(2);
    const rows = readEchoRows('s-dm-t2');
    expect(rows).toHaveLength(1);
    const content = JSON.parse(rows[0].content as string);
    expect(content.text).toBe('plain text, not json at all');
    // parsed.sender was null (parse failed) -> falls back to 'unknown'.
    expect(content.sender).toBe('unknown');
    expect(content.senderId).toBeNull();
  });
});

describe('fan.ts parseContent — valid JSON with a non-string/absent text field', () => {
  it('falls back to empty text (not the raw string) when JSON parses but has no text field', async () => {
    const written = await fanInboundMessage({
      session: SRC_DM,
      mg: DM_MG,
      messageId: 'msg-notext:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: JSON.stringify({ sender: 'Gavriel', senderId: 'slack:U1' }),
      timestamp: NOW,
    });
    // Empty text short-circuits fanInboundMessage before any write.
    expect(written).toBe(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
  });
});

describe('fanEcho — zero targets short-circuit', () => {
  it('returns 0 without writing when the source has no active same-mg siblings', async () => {
    const lonelyMg = mg('mg-lonely', 'D-lonely', 0, 'Solo');
    await createMessagingGroup(lonelyMg);
    const lonelySession = session('s-lonely', AG, 'mg-lonely', null);
    await createSession(lonelySession);

    const written = await fanInboundMessage({
      session: lonelySession,
      mg: lonelyMg,
      messageId: 'msg-lonely:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: JSON.stringify({ text: 'anybody there?', sender: 'Gavriel', senderId: 'slack:U1' }),
      timestamp: NOW,
    });
    expect(written).toBe(0);
  });
});

describe('fanOutboundMessage — messaging group cannot be resolved', () => {
  it('returns 0 when no messaging group matches the delivered channel/platform', async () => {
    const written = await fanOutboundMessage(
      {
        id: 'out-unresolved',
        kind: 'chat',
        platform_id: 'D-nowhere',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'into the void' }),
      },
      SRC_DM,
      { id: AG, name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: NOW },
    );
    expect(written).toBe(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
  });
});

describe('fanOutboundMessage — resolved mg but empty text', () => {
  it('returns 0 when the delivered message content has no text', async () => {
    const written = await fanOutboundMessage(
      {
        id: 'out-empty-text',
        kind: 'chat',
        platform_id: 'D456',
        channel_type: 'slack',
        content: JSON.stringify({ sender: 'Pixel' }),
      },
      SRC_DM,
      { id: AG, name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: NOW },
    );
    expect(written).toBe(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
  });
});

describe('fanEcho per-target write isolation', () => {
  it('a colliding row id on one target is caught and skipped; a fresh target still gets written', async () => {
    // Pre-seed s-dm-t2 with the exact row id fanInboundMessage would produce,
    // simulating a replay collision on that one target only.
    const collidingId = echoRowId('msg-collide:ag-1', 's-dm-t2');
    await writeSessionMessage(AG, 's-dm-t2', {
      id: collidingId,
      kind: 'chat',
      timestamp: NOW,
      channelType: ECHO_CHANNEL_TYPE,
      content: JSON.stringify({ text: 'pre-existing', sender: 'x', senderId: null }),
      trigger: false,
    });
    expect(readEchoRows('s-dm-t2')).toHaveLength(1);

    const written = await fanInboundMessage({
      session: SRC_DM,
      mg: DM_MG,
      messageId: 'msg-collide:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: JSON.stringify({ text: 'fresh content', sender: 'Gavriel', senderId: 'slack:U1' }),
      timestamp: NOW,
    });

    // s-dm-t3 (fresh) got written; s-dm-t2 (collision) was skipped and
    // logged, not counted, and its pre-existing row is untouched.
    expect(written).toBe(1);
    const t2Rows = readEchoRows('s-dm-t2');
    expect(t2Rows).toHaveLength(1);
    expect(JSON.parse(t2Rows[0].content as string).text).toBe('pre-existing');
    const t3Rows = readEchoRows('s-dm-t3');
    expect(t3Rows).toHaveLength(1);
    expect(JSON.parse(t3Rows[0].content as string).text).toBe('fresh content');
  });
});

describe('outer defensive try/catch (never throws, returns 0)', () => {
  const agentGroup = { id: AG, name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: NOW };

  it('fanInboundMessage swallows an unexpected failure and returns 0', async () => {
    throwForAgentGroup = 'ag-boom';
    const written = await fanInboundMessage({
      session: { ...SRC_DM, agent_group_id: 'ag-boom' },
      mg: DM_MG,
      messageId: 'msg-boom:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: JSON.stringify({ text: 'hi', sender: 'Gavriel', senderId: 'slack:U1' }),
      timestamp: NOW,
    });
    expect(written).toBe(0);
    // Nothing was written anywhere — the failure happened before any target write.
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
  });

  it('fanOutboundMessage swallows an unexpected failure and returns 0', async () => {
    throwForAgentGroup = 'ag-boom';
    const written = await fanOutboundMessage(
      {
        id: 'out-boom',
        kind: 'chat',
        platform_id: 'D456',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'dm reply' }),
      },
      { ...SRC_DM, agent_group_id: 'ag-boom' },
      agentGroup,
    );
    expect(written).toBe(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
  });
});

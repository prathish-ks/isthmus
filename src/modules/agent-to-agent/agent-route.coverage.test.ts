/**
 * Coverage tests for agent-route's remaining branches: forwardAttachedFiles'
 * guard rails (empty list, unsafe ids/names, missing or symlinked source
 * dir, inspection failure, missing file, file resolving outside the outbox),
 * the missing-target throw, content shapes that skip forwarding (non-JSON,
 * non-array / non-string files, pre-existing attachments), and the approval
 * card's body (non-JSON content, truncation, attachment list).
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const state = vi.hoisted(() => {
  const base = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  return { root: `${base}/nanoclaw-cov-a2a-route` };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('../approvals/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../approvals/index.js')>();
  return { ...actual, requestApproval: vi.fn().mockResolvedValue(undefined) };
});
vi.mock('../../config.js', async (importActual) => {
  const actual = await importActual<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: state.root };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder, sessionDir } from '../../session-manager.js';
import { requestApproval } from '../approvals/index.js';
import { forwardAttachedFiles, routeAgentMessage } from './agent-route.js';
import { createDestination } from './db/agent-destinations.js';
import { setMessagePolicy } from './db/agent-message-policies.js';

const A = 'ag-A';
const B = 'ag-B';

function now(): string {
  return new Date().toISOString();
}

function session(id: string, agentGroupId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

function readInbound(agentGroupId: string, sessionId: string): Array<{ id: string; content: string }> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  try {
    return db.prepare('SELECT id, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

let SA: Session;
let SB: Session;

function outbox(messageId: string, files: Record<string, string> = {}): string {
  const dir = path.join(sessionDir(A, SA.id), 'outbox', messageId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), bytes);
  return dir;
}

const target = (messageId: string) => ({ agentGroupId: B, sessionId: 'sess-B', messageId });

beforeEach(async () => {
  fs.rmSync(state.root, { recursive: true, force: true });
  fs.mkdirSync(state.root, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  vi.mocked(requestApproval).mockClear();
  await createAgentGroup({ id: A, name: 'Alpha', folder: 'a', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: B, name: 'Bravo', folder: 'b', agent_provider: null, created_at: now() });
  SA = session('sess-A', A);
  SB = session('sess-B', B);
  await createSession(SA);
  await createSession(SB);
  initSessionFolder(A, SA.id);
  initSessionFolder(B, SB.id);
  await createDestination({
    agent_group_id: A,
    local_name: 'b',
    target_type: 'agent',
    target_id: B,
    created_at: now(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(state.root, { recursive: true, force: true });
});

describe('forwardAttachedFiles — guard rails', () => {
  it('returns [] for an empty file list without touching the disk', () => {
    const existsSpy = vi.spyOn(fs, 'existsSync');
    expect(
      forwardAttachedFiles({ agentGroupId: A, sessionId: SA.id, messageId: 'm', filenames: [] }, target('t')),
    ).toEqual([]);
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('rejects an unsafe source message id', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const out = forwardAttachedFiles(
      { agentGroupId: A, sessionId: SA.id, messageId: '../escape', filenames: ['a.txt'] },
      target('t'),
    );
    expect(out).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith('agent-route: rejecting unsafe source outbox message id', {
      sourceMsgId: '../escape',
    });
  });

  it('skips when the source outbox dir is missing', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(
      forwardAttachedFiles({ agentGroupId: A, sessionId: SA.id, messageId: 'nope', filenames: ['a.txt'] }, target('t')),
    ).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'agent-route: source outbox dir missing, no files forwarded',
      expect.objectContaining({ sourceMsgId: 'nope' }),
    );
  });

  it('rejects a symlinked source outbox dir', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const realDir = path.join(state.root, 'elsewhere');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'a.txt'), 'x');
    const outboxRoot = path.join(sessionDir(A, SA.id), 'outbox');
    fs.mkdirSync(outboxRoot, { recursive: true });
    fs.symlinkSync(realDir, path.join(outboxRoot, 'linked'));

    expect(
      forwardAttachedFiles(
        { agentGroupId: A, sessionId: SA.id, messageId: 'linked', filenames: ['a.txt'] },
        target('t'),
      ),
    ).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'agent-route: rejecting unsafe source outbox dir',
      expect.objectContaining({ sourceMsgId: 'linked' }),
    );
  });

  it('skips when the source dir cannot be inspected', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    outbox('m-stat', { 'a.txt': 'x' });
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => {
      throw new Error('EACCES');
    });
    expect(
      forwardAttachedFiles(
        { agentGroupId: A, sessionId: SA.id, messageId: 'm-stat', filenames: ['a.txt'] },
        target('t'),
      ),
    ).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'agent-route: failed to inspect source outbox dir',
      expect.objectContaining({ sourceMsgId: 'm-stat' }),
    );
  });

  it('skips unsafe filenames, missing files, and files resolving outside the outbox; forwards the rest', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const dir = outbox('m-mix', { 'ok.txt': 'fine', 'escapee.txt': 'nope' });
    const realpath = fs.realpathSync;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) =>
      String(p).endsWith('escapee.txt')
        ? path.join(state.root, 'outside', 'escapee.txt')
        : realpath(p)) as typeof fs.realpathSync);

    const out = forwardAttachedFiles(
      {
        agentGroupId: A,
        sessionId: SA.id,
        messageId: 'm-mix',
        filenames: ['../evil', 'missing.txt', 'escapee.txt', 'ok.txt'],
      },
      target('t-mix'),
    );

    expect(out).toEqual([{ name: 'ok.txt', filename: 'ok.txt', type: 'file', localPath: 'inbox/t-mix/ok.txt' }]);
    expect(fs.readFileSync(path.join(sessionDir(B, SB.id), 'inbox', 't-mix', 'ok.txt'), 'utf8')).toBe('fine');
    expect(fs.existsSync(path.join(dir, 'ok.txt'))).toBe(true); // copied, not moved
    const warned = warnSpy.mock.calls.map((c) => c[0]);
    expect(warned).toContain('agent-route: rejecting unsafe attachment filename (path traversal attempt?)');
    expect(warned).toContain('agent-route: referenced file missing in source outbox, skipped');
    expect(warned).toContain('agent-route: rejecting source file outside source outbox dir');
  });
});

describe('routeAgentMessage — content shapes', () => {
  it('throws when the message has no target agent group', async () => {
    await expect(
      routeAgentMessage({ id: 'm0', platform_id: null, content: '{}', in_reply_to: null }, SA),
    ).rejects.toThrow('agent-to-agent message m0 is missing a target agent group id');
  });

  it('routes non-JSON content verbatim (no forwarding, zero forwarded files)', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    await routeAgentMessage({ id: 'm-raw', platform_id: B, content: 'just text', in_reply_to: null }, SA);
    const rows = readInbound(B, SB.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('just text');
    expect(infoSpy).toHaveBeenCalledWith('Agent message routed', expect.objectContaining({ forwardedFileCount: 0 }));
  });

  it('leaves content untouched when files is missing, not an array, empty, or has no string entries', async () => {
    for (const content of [
      JSON.stringify({ text: 'a' }),
      JSON.stringify({ text: 'b', files: 'report.pdf' }),
      JSON.stringify({ text: 'c', files: [] }),
      JSON.stringify({ text: 'd', files: [1, null] }),
    ]) {
      await routeAgentMessage({ id: `m-${content.length}`, platform_id: B, content, in_reply_to: null }, SA);
    }
    const rows = readInbound(B, SB.id);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.content)).toEqual([
      JSON.stringify({ text: 'a' }),
      JSON.stringify({ text: 'b', files: 'report.pdf' }),
      JSON.stringify({ text: 'c', files: [] }),
      JSON.stringify({ text: 'd', files: [1, null] }),
    ]);
  });

  it('merges forwarded files into pre-existing attachments and ignores non-string file entries', async () => {
    outbox('m-merge', { 'doc.txt': 'bytes' });
    const existing = { name: 'prior', type: 'file', localPath: 'inbox/x/prior' };
    await routeAgentMessage(
      {
        id: 'm-merge',
        platform_id: B,
        content: JSON.stringify({ text: 'see', files: ['doc.txt', 42], attachments: [existing] }),
        in_reply_to: null,
      },
      SA,
    );
    const parsed = JSON.parse(readInbound(B, SB.id)[0].content) as { attachments: Array<Record<string, unknown>> };
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0]).toEqual(existing);
    expect(parsed.attachments[1]).toMatchObject({ name: 'doc.txt', type: 'file' });
  });
});

describe('routeAgentMessage — approval card body', () => {
  beforeEach(async () => {
    await setMessagePolicy(A, B, 'telegram:dana', now());
  });

  function question(): string {
    return String(vi.mocked(requestApproval).mock.calls.at(-1)![0].question);
  }

  it('quotes non-JSON content as-is', async () => {
    await routeAgentMessage({ id: 'h1', platform_id: B, content: 'raw body', in_reply_to: null }, SA);
    expect(readInbound(B, SB.id)).toHaveLength(0);
    expect(question()).toContain('Agent "Alpha" wants to send a message to "Bravo":\n\nraw body');
    expect(question()).not.toContain('Attachments:');
  });

  it('truncates a long body and lists attachments; non-string text/files are dropped', async () => {
    const long = 'x'.repeat(1600);
    await routeAgentMessage(
      {
        id: 'h2',
        platform_id: B,
        content: JSON.stringify({ text: long, files: ['a.pdf', 7, 'b.png'] }),
        in_reply_to: null,
      },
      SA,
    );
    expect(question()).toContain(`${'x'.repeat(1500)}… (truncated)`);
    expect(question()).toContain('Attachments: a.pdf, b.png');

    await routeAgentMessage(
      { id: 'h3', platform_id: B, content: JSON.stringify({ text: 5, files: 'nope' }), in_reply_to: null },
      SA,
    );
    expect(question()).toContain('"Bravo":\n\n\n\nApprove, Reject');
  });
});

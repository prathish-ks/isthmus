/**
 * Coverage-uplift tests for session-manager.ts targeting branches the
 * pre-existing session-manager.test.ts / session-manager.attachments.test.ts
 * suites don't reach: resolveSession/resolveTaskSession race-retry paths,
 * writeSessionRouting's missing-session early return, readOutboxFiles'
 * safety-rejection branches, clearOutbox's safety-rejection branches, and
 * the markContainer* helpers.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-mgr-cov' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { createSession, getSession } from './db/sessions.js';
import * as sessionsDb from './db/sessions.js';
import {
  clearOutbox,
  heartbeatPath,
  initSessionFolder,
  markContainerIdle,
  markContainerRunning,
  markContainerStopped,
  readOutboxFiles,
  resolveSession,
  resolveTaskSession,
  sessionDir,
  withExistingMailboxSession,
  writeSessionMessage,
  writeSessionRouting,
} from './session-manager.js';
import type { Session } from './types.js';
import { log } from './log.js';

const TEST_DIR = '/tmp/nanoclaw-test-session-mgr-cov';
const AG = 'ag-cov';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Cov Agent', folder: 'cov-agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-cov',
    channel_type: 'telegram',
    platform_id: 'telegram:cov',
    name: 'Cov Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('resolveSession race-retry (isUniqueViolation path)', () => {
  it('agent-shared: returns the winner session when createSession loses a unique-constraint race', async () => {
    const winner: Session = {
      id: 'sess-winner',
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    await createSession(winner);

    const createSpy = vi
      .spyOn(sessionsDb, 'createSession')
      .mockRejectedValueOnce(Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }));

    const { session, created } = await resolveSession(AG, null, null, 'agent-shared');
    expect(created).toBe(false);
    expect(session.id).toBe('sess-winner');
    createSpy.mockRestore();
  });

  it('agent-shared: re-throws when no winner is found after the race', async () => {
    const err = Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(err);
    // No pre-existing session for this agent group — findSessionByAgentGroup returns undefined.
    await expect(resolveSession('ag-nonexistent-for-race', null, null, 'agent-shared')).rejects.toBe(err);
  });

  it('messaging-group mode: returns the winner session on a unique-constraint race', async () => {
    const winner: Session = {
      id: 'sess-winner-2',
      agent_group_id: AG,
      messaging_group_id: 'mg-cov',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    await createSession(winner);
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(
      Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );
    const { session, created } = await resolveSession(AG, 'mg-cov', null, 'shared');
    expect(created).toBe(false);
    expect(session.id).toBe('sess-winner-2');
  });

  it('re-throws non-unique-violation errors from createSession unchanged', async () => {
    const err = new Error('disk full');
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(err);
    await expect(resolveSession(AG, 'mg-cov', null, 'shared')).rejects.toBe(err);
  });
});

describe('resolveTaskSession', () => {
  it('returns an existing task session without creating a new one', async () => {
    const { session: first, created: firstCreated } = await resolveTaskSession(AG, 'my-series');
    expect(firstCreated).toBe(true);
    const { session: second, created: secondCreated } = await resolveTaskSession(AG, 'my-series');
    expect(secondCreated).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('returns the racing winner when createSession loses a unique-constraint race', async () => {
    // findSystemSession short-circuits before createSession is even called
    // once a session exists for the thread id, so pre-seed a session under
    // the task's thread id directly (bypassing resolveTaskSession) and then
    // call resolveTaskSession with createSession mocked to fail — it must
    // fall back to the pre-seeded row via the retry lookup.
    const threadId = `system:tasks:pending-series`;
    const preseeded: Session = {
      id: 'sess-preseeded',
      agent_group_id: AG,
      messaging_group_id: null,
      thread_id: threadId,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    };
    await createSession(preseeded);
    const findSpy = vi.spyOn(sessionsDb, 'findSystemSession').mockResolvedValueOnce(undefined);
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(
      Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
    );
    const { session, created } = await resolveTaskSession(AG, 'pending-series');
    expect(created).toBe(false);
    expect(session.id).toBe('sess-preseeded');
    findSpy.mockRestore();
  });

  it('re-throws when no racing winner is found', async () => {
    const err = Object.assign(new Error('constraint'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(err);
    await expect(resolveTaskSession(AG, 'never-wins-series')).rejects.toBe(err);
  });
});

describe('writeSessionRouting', () => {
  it('returns early when the session no longer exists', async () => {
    await expect(writeSessionRouting(AG, 'no-such-session')).resolves.toBeUndefined();
  });

  it('writes routing derived from the session messaging group', async () => {
    const { session } = await resolveSession(AG, 'mg-cov', null, 'shared');
    await expect(writeSessionRouting(AG, session.id)).resolves.toBeUndefined();
  });
});

describe('markContainer* helpers', () => {
  it('markContainerRunning / markContainerIdle / markContainerStopped update container_status', async () => {
    const { session } = await resolveSession(AG, 'mg-cov', null, 'shared');
    await markContainerRunning(session.id);
    expect((await getSession(session.id))?.container_status).toBe('running');
    await markContainerIdle(session.id);
    expect((await getSession(session.id))?.container_status).toBe('idle');
    await markContainerStopped(session.id);
    expect((await getSession(session.id))?.container_status).toBe('stopped');
  });
});

describe('misc small helpers', () => {
  it('heartbeatPath points at .heartbeat inside the session dir', () => {
    expect(heartbeatPath(AG, 'sess-x')).toBe(path.join(sessionDir(AG, 'sess-x'), '.heartbeat'));
  });

  it('withExistingMailboxSession returns undefined for a never-provisioned session', async () => {
    const result = await withExistingMailboxSession(AG, 'sess-never-provisioned', () => 'unreachable');
    expect(result).toBeUndefined();
  });

  it('resolveSession per-thread mode with no messaging group: rethrows a non-unique createSession error', async () => {
    const err = new Error('disk full');
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(err);
    await expect(resolveSession(AG, null, 'thread-x', 'per-thread')).rejects.toBe(err);
  });

  it('resolveTaskSession rethrows a non-unique-violation createSession error', async () => {
    const err = new Error('disk full');
    vi.spyOn(sessionsDb, 'createSession').mockRejectedValueOnce(err);
    await expect(resolveTaskSession(AG, 'boom-series')).rejects.toBe(err);
  });
});

describe('extractAttachmentFiles (via writeSessionMessage)', () => {
  it('leaves content untouched when it is not JSON', async () => {
    const SESS = 'sess-not-json';
    await writeSessionMessage(AG, SESS, {
      id: 'msg-not-json',
      kind: 'chat',
      timestamp: now(),
      content: 'plain text, not json',
    });
    // No throw, and nothing under inbox/ was created.
    const inboxDir = path.join(sessionDir(AG, SESS), 'inbox');
    expect(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []).toHaveLength(0);
  });

  it('leaves content untouched when attachments is not an array', async () => {
    const SESS = 'sess-no-attachments-array';
    await writeSessionMessage(AG, SESS, {
      id: 'msg-no-array',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi', attachments: 'nope' }),
    });
    const inboxDir = path.join(sessionDir(AG, SESS), 'inbox');
    expect(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : []).toHaveLength(0);
  });

  it('rejects an unsafe inbound message id and skips attachment extraction', async () => {
    const SESS = 'sess-unsafe-msgid';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await writeSessionMessage(AG, SESS, {
      id: '../escape-id',
      kind: 'chat',
      timestamp: now(),
      content: JSON.stringify({ text: 'hi', attachments: [{ name: 'a.txt', data: 'aGVsbG8=' }] }),
    });
    expect(warnSpy).toHaveBeenCalledWith('Rejecting unsafe inbound message id', { messageId: '../escape-id' });
  });

  it('saves a well-formed attachment to the inbox and rewrites content with localPath', async () => {
    const SESS = 'sess-happy-attach';
    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'photo.png', data: Buffer.from('bytes').toString('base64'), size: 5 }],
    });
    await writeSessionMessage(AG, SESS, {
      id: 'msg-happy',
      kind: 'chat',
      timestamp: now(),
      content,
    });
    const savedPath = path.join(sessionDir(AG, SESS), 'inbox', 'msg-happy', 'photo.png');
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('bytes');
  });

  it('falls back to a generated filename and warns when the attachment name is unsafe', async () => {
    const SESS = 'sess-unsafe-attach-name';
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: '../../evil.png', data: Buffer.from('bytes').toString('base64') }],
    });
    await writeSessionMessage(AG, SESS, {
      id: 'msg-unsafe-name',
      kind: 'chat',
      timestamp: now(),
      content,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Refused unsafe attachment filename, would escape inbox',
      expect.objectContaining({ messageId: 'msg-unsafe-name', rawName: '../../evil.png' }),
    );
    const inboxMsgDir = path.join(sessionDir(AG, SESS), 'inbox', 'msg-unsafe-name');
    expect(fs.readdirSync(inboxMsgDir)).toHaveLength(1);
  });

  it('skips (and warns) writing an attachment whose target file already exists', async () => {
    const SESS = 'sess-eexist-attach';
    // Pre-place the target file directly (simulating a prior write landing
    // at the same inbox/<messageId>/<filename> path) so the exclusive `wx`
    // write hits EEXIST on the very first attempt.
    const inboxMsgDir = path.join(sessionDir(AG, SESS), 'inbox', 'msg-dup');
    initSessionFolder(AG, SESS);
    fs.mkdirSync(inboxMsgDir, { recursive: true });
    fs.writeFileSync(path.join(inboxMsgDir, 'dup.txt'), 'first');

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const content = JSON.stringify({
      text: 'dup',
      attachments: [{ name: 'dup.txt', data: Buffer.from('second').toString('base64') }],
    });
    await writeSessionMessage(AG, SESS, { id: 'msg-dup', kind: 'chat', timestamp: now(), content });
    expect(warnSpy).toHaveBeenCalledWith(
      'Inbox attachment target already exists, refusing to overwrite',
      expect.objectContaining({ messageId: 'msg-dup', filename: 'dup.txt' }),
    );
    const savedPath = path.join(inboxMsgDir, 'dup.txt');
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('first');
  });

  it('rethrows a non-EEXIST error from the attachment write', async () => {
    const SESS = 'sess-attach-throw';
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (typeof p === 'string' && p.includes('inbox')) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return undefined as never;
    });
    const content = JSON.stringify({
      text: 'hi',
      attachments: [{ name: 'a.txt', data: Buffer.from('x').toString('base64') }],
    });
    await expect(
      writeSessionMessage(AG, SESS, {
        id: 'msg-throws-attach',
        kind: 'chat',
        timestamp: now(),
        content,
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    writeSpy.mockRestore();
  });
});

describe('readOutboxFiles safety rejections', () => {
  const SESS = 'sess-outbox-cov';

  beforeEach(() => {
    initSessionFolder(AG, SESS);
  });

  it('rejects an unsafe message id', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = readOutboxFiles(AG, SESS, '../escape', ['a.txt']);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith('Rejecting unsafe outbox message id', { messageId: '../escape' });
  });

  it('returns undefined when the outbox message dir does not exist', () => {
    const result = readOutboxFiles(AG, SESS, 'msg-missing', ['a.txt']);
    expect(result).toBeUndefined();
  });

  it('rejects a symlinked outbox message directory', () => {
    const outsideDir = path.join(TEST_DIR, 'outside-outbox');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-symlink');
    fs.symlinkSync(outsideDir, outboxMsgDir);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = readOutboxFiles(AG, SESS, 'msg-symlink', ['a.txt']);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Rejecting unsafe outbox directory',
      expect.objectContaining({ messageId: 'msg-symlink' }),
    );
  });

  it('logs and returns undefined when inspecting the outbox directory throws', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-inspect-throw');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw new Error('EACCES');
    });
    const result = readOutboxFiles(AG, SESS, 'msg-inspect-throw', ['a.txt']);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to inspect outbox directory',
      expect.objectContaining({ messageId: 'msg-inspect-throw' }),
    );
    lstatSpy.mockRestore();
  });

  it('skips unsafe filenames and reports files not found, returning undefined when nothing valid remains', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-1');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = readOutboxFiles(AG, SESS, 'msg-1', ['../escape.txt', 'does-not-exist.txt']);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Refused unsafe outbox filename, would escape outbox',
      expect.objectContaining({ filename: '../escape.txt' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Outbox file not found',
      expect.objectContaining({ filename: 'does-not-exist.txt' }),
    );
  });

  it('rejects a file whose resolved realpath falls outside the message directory', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-escape');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    const realFile = path.join(outboxMsgDir, 'sneaky.txt');
    fs.writeFileSync(realFile, 'hello');
    const origRealpath = fs.realpathSync.bind(fs) as typeof fs.realpathSync;
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (typeof p === 'string' && p.endsWith('sneaky.txt')) return '/somewhere/else/sneaky.txt';
      return origRealpath(p as string);
    }) as typeof fs.realpathSync);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = readOutboxFiles(AG, SESS, 'msg-escape', ['sneaky.txt']);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'Rejecting outbox file outside message directory',
      expect.objectContaining({ filename: 'sneaky.txt' }),
    );
    realpathSpy.mockRestore();
  });

  it('rejects a symlinked outbox file and a file outside the message directory, returns real files', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-2');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    const realFile = path.join(outboxMsgDir, 'real.txt');
    fs.writeFileSync(realFile, 'hello');
    const outsideTarget = path.join(TEST_DIR, 'outside-file.txt');
    fs.writeFileSync(outsideTarget, 'nope');
    const symlinkFile = path.join(outboxMsgDir, 'sym.txt');
    fs.symlinkSync(outsideTarget, symlinkFile);

    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const result = readOutboxFiles(AG, SESS, 'msg-2', ['real.txt', 'sym.txt']);
    expect(result).toHaveLength(1);
    expect(result?.[0].filename).toBe('real.txt');
    expect(warnSpy).toHaveBeenCalledWith(
      'Rejecting unsafe outbox file',
      expect.objectContaining({ filename: 'sym.txt' }),
    );
  });
});

describe('clearOutbox safety rejections', () => {
  const SESS = 'sess-clear-cov';

  beforeEach(() => {
    initSessionFolder(AG, SESS);
  });

  it('rejects an unsafe message id', () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    clearOutbox(AG, SESS, '../escape');
    expect(warnSpy).toHaveBeenCalledWith('Rejecting unsafe outbox cleanup message id', { messageId: '../escape' });
  });

  it('no-ops when the outbox dir does not exist', () => {
    expect(() => clearOutbox(AG, SESS, 'no-such-msg')).not.toThrow();
  });

  it('rejects a symlinked outbox directory', () => {
    const outsideDir = path.join(TEST_DIR, 'outside-clear');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-symlink');
    fs.symlinkSync(outsideDir, outboxMsgDir);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    clearOutbox(AG, SESS, 'msg-symlink');
    expect(warnSpy).toHaveBeenCalledWith(
      'Rejecting unsafe outbox cleanup directory',
      expect.objectContaining({ messageId: 'msg-symlink' }),
    );
    // The symlink itself must survive (not followed and rm'd).
    expect(fs.existsSync(outsideDir)).toBe(true);
  });

  it('rejects cleanup when the resolved realpath falls outside the session outbox root', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-escape-clear');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    const origRealpath = fs.realpathSync.bind(fs) as typeof fs.realpathSync;
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
      if (typeof p === 'string' && p.endsWith('msg-escape-clear')) return '/somewhere/else/msg-escape-clear';
      return origRealpath(p as string);
    }) as typeof fs.realpathSync);
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    clearOutbox(AG, SESS, 'msg-escape-clear');
    expect(warnSpy).toHaveBeenCalledWith(
      'Rejecting outbox cleanup outside session outbox',
      expect.objectContaining({ messageId: 'msg-escape-clear' }),
    );
    expect(fs.existsSync(outboxMsgDir)).toBe(true);
    realpathSpy.mockRestore();
  });

  it('removes a legitimate outbox message directory', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-real');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    fs.writeFileSync(path.join(outboxMsgDir, 'f.txt'), 'x');
    clearOutbox(AG, SESS, 'msg-real');
    expect(fs.existsSync(outboxMsgDir)).toBe(false);
  });

  it('logs and swallows when realpathSync throws mid-cleanup', () => {
    const outboxMsgDir = path.join(sessionDir(AG, SESS), 'outbox', 'msg-throws');
    fs.mkdirSync(outboxMsgDir, { recursive: true });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const realpathSpy = vi.spyOn(fs, 'realpathSync').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => clearOutbox(AG, SESS, 'msg-throws')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      'Outbox cleanup failed (message already delivered)',
      expect.objectContaining({ messageId: 'msg-throws' }),
    );
    realpathSpy.mockRestore();
  });
});

/**
 * Interactive module — ask_user_question button-click routing.
 *
 * Importing the module registers its response handler; the tests pull that
 * handler back out of the registry and drive it: table absent (module not
 * installed), unknown question id, session gone, and the happy path that
 * writes a question_response system message into the session and wakes the
 * container. Container-runner mocked; real central DB.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-interactive-cov' };
});

import { wakeContainer } from '../../container-runner.js';
import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../../db/index.js';
import { initSqliteTestDb } from '../../db/connection.js';
import { createPendingQuestion, deleteSession, getPendingQuestion } from '../../db/sessions.js';
import { getResponseHandlers, type ResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { writeSessionMessage } from '../../session-manager.js';
import './index.js';

const TEST_DIR = '/tmp/nanoclaw-test-interactive-cov';

function now(): string {
  return new Date().toISOString();
}

// The module registered exactly one handler at import time.
const handler: ResponseHandler = getResponseHandlers()[getResponseHandlers().length - 1];

function payload(overrides: Partial<ResponsePayload> = {}): ResponsePayload {
  return {
    questionId: 'q-1',
    value: 'yes',
    userId: 'telegram:alice',
    channelType: 'telegram',
    platformId: 'dm-alice',
    threadId: null,
    ...overrides,
  };
}

async function seedQuestion(id = 'q-1'): Promise<void> {
  await createPendingQuestion({
    question_id: id,
    session_id: 'sess-1',
    message_out_id: 'out-1',
    platform_id: 'tg-chat-9',
    channel_type: 'telegram',
    thread_id: 'T-7',
    title: 'Proceed?',
    options: [{ label: 'Yes', value: 'yes', selectedLabel: 'Yes', style: 'primary' }],
    created_at: now(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('interactive response handler', () => {
  it('is registered with core at import time', () => {
    expect(getResponseHandlers().length).toBeGreaterThan(0);
    expect(typeof handler).toBe('function');
  });

  it('does not claim anything when the pending_questions table is absent', async () => {
    await initSqliteTestDb(); // bare DB, no migrations → no module tables
    expect(await handler(payload())).toBe(false);
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  describe('with the schema installed', () => {
    beforeEach(async () => {
      await runMigrations(await initTestDb());
      await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
      await createSession({
        id: 'sess-1',
        agent_group_id: 'ag-1',
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: now(),
        created_at: now(),
      });
    });

    it('does not claim an unknown question id', async () => {
      expect(await handler(payload({ questionId: 'nope' }))).toBe(false);
      expect(writeSessionMessage).not.toHaveBeenCalled();
      expect(wakeContainer).not.toHaveBeenCalled();
    });

    it('claims and drops the question when its session is gone', async () => {
      await seedQuestion();
      // pending_questions cascades on session delete in some schemas; make the
      // orphan explicit by deleting the session with FK enforcement lifted.
      const { getDb } = await import('../../db/connection.js');
      await getDb().run('PRAGMA foreign_keys = OFF');
      await deleteSession('sess-1');
      await getDb().run('PRAGMA foreign_keys = ON');
      expect(await getPendingQuestion('q-1')).toBeDefined();

      expect(await handler(payload())).toBe(true);
      expect(await getPendingQuestion('q-1')).toBeUndefined();
      expect(writeSessionMessage).not.toHaveBeenCalled();
      expect(wakeContainer).not.toHaveBeenCalled();
    });

    it('routes the click into the session as a question_response, drops the row and wakes the container', async () => {
      await seedQuestion();
      expect(await handler(payload({ value: 'no' }))).toBe(true);

      expect(writeSessionMessage).toHaveBeenCalledTimes(1);
      const [agentGroupId, sessionId, msg] = vi.mocked(writeSessionMessage).mock.calls[0];
      expect(agentGroupId).toBe('ag-1');
      expect(sessionId).toBe('sess-1');
      expect(msg.id).toMatch(/^qr-q-1-\d+$/);
      expect(msg).toMatchObject({
        kind: 'system',
        platformId: 'tg-chat-9',
        channelType: 'telegram',
        threadId: 'T-7',
      });
      expect(JSON.parse(msg.content)).toEqual({
        type: 'question_response',
        questionId: 'q-1',
        selectedOption: 'no',
        userId: 'telegram:alice',
      });
      expect(await getPendingQuestion('q-1')).toBeUndefined();
      expect(wakeContainer).toHaveBeenCalledWith(expect.objectContaining({ id: 'sess-1' }));
    });

    it('records an empty user id when the click carries none', async () => {
      await seedQuestion();
      await handler(payload({ userId: null }));
      const msg = vi.mocked(writeSessionMessage).mock.calls[0][2];
      expect(JSON.parse(msg.content).userId).toBe('');
    });
  });
});

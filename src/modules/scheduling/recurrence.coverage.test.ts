/**
 * Coverage tests for handleRecurrence's failure paths: an unparseable cron
 * expression is logged and skipped (the sweep never crashes over one bad
 * series), and a failing run-log append during auto-pause is swallowed with
 * a warning. Drives a fake InboundMailbox so no session DB is needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundMailbox } from '../../mailbox/index.js';
import type { Session } from '../../types.js';

vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, TIMEZONE: 'UTC' };
});
// No agent group row → appendRunLog throws → the auto-pause note is swallowed.
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: () => undefined,
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ timezone: null }),
}));

import { log } from '../../log.js';
import { handleRecurrence, scriptBackoffMinutes } from './recurrence.js';

function fakeSession(): Session {
  return { id: 'sess-1', agent_group_id: 'ag-missing' } as Session;
}

interface FakeMailbox {
  mailbox: InboundMailbox;
  inserted: Array<Record<string, unknown>>;
  cleared: string[];
}

function fakeMailbox(
  recurring: Array<{ id: string; seriesId: string; recurrence: string; content: string }>,
  trailingFails: number,
): FakeMailbox {
  const inserted: Array<Record<string, unknown>> = [];
  const cleared: string[] = [];
  const mailbox = {
    getCompletedRecurring: () => recurring,
    trailingFailedRuns: () => trailingFails,
    insertTask: async (task: Record<string, unknown>) => {
      inserted.push(task);
    },
    clearRecurrence: (id: string) => {
      cleared.push(id);
    },
  } as unknown as InboundMailbox;
  return { mailbox, inserted, cleared };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('handleRecurrence — failure paths', () => {
  it('logs and skips a series whose cron expression cannot be parsed, continuing with the rest', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    const { mailbox, inserted, cleared } = fakeMailbox(
      [
        { id: 'bad', seriesId: 'bad', recurrence: 'not a cron', content: '{}' },
        { id: 'good', seriesId: 'good', recurrence: '0 9 * * *', content: '{}' },
      ],
      0,
    );

    await handleRecurrence(mailbox, fakeSession());

    expect(errSpy).toHaveBeenCalledWith(
      'Failed to compute next recurrence',
      expect.objectContaining({ messageId: 'bad', recurrence: 'not a cron' }),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ seriesId: 'good', recurrence: '0 9 * * *' });
    expect(cleared).toEqual(['good']);
  });

  it('auto-pauses a failing series even when the host run-log note cannot be written', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const { mailbox, inserted, cleared } = fakeMailbox(
      [{ id: 'flaky', seriesId: 'flaky', recurrence: '*/5 * * * *', content: '{"prompt":"x"}' }],
      8,
    );

    await handleRecurrence(mailbox, fakeSession());

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ seriesId: 'flaky', status: 'paused' });
    expect(cleared).toEqual(['flaky']);
    // appendRunLog threw (no agent group) → swallowed with the warn line.
    expect(warnSpy).toHaveBeenCalledWith(
      'Could not append host task note to run log',
      expect.objectContaining({ agentGroupId: 'ag-missing', seriesId: 'flaky' }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Task series auto-paused: script keeps failing',
      expect.objectContaining({ seriesId: 'flaky', scriptFails: 8 }),
    );
  });

  it('applies exponential backoff below the pause cap', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    const { mailbox, inserted } = fakeMailbox([{ id: 'm', seriesId: 'm', recurrence: '* * * * *', content: '{}' }], 3);
    const before = Date.now();
    await handleRecurrence(mailbox, fakeSession());

    expect(inserted).toHaveLength(1);
    const processAfter = new Date(inserted[0].processAfter as string).getTime();
    expect(processAfter).toBeGreaterThanOrEqual(before + scriptBackoffMinutes(3) * 60_000 - 1000);
    expect(infoSpy).toHaveBeenCalledWith(
      'Inserted next recurrence',
      expect.objectContaining({ scriptFails: 3, backoffMin: 8 }),
    );
  });
});

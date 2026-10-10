/**
 * `ncl dropped-messages` must expose every reason the router and access gate
 * actually record — and nothing they never write. handleUnknownSender
 * (src/modules/permissions/index.ts) records `unknown_sender_<policy>` for
 * strict, request_approval and decline_notify, but setAccessGate admits a
 * `public` group's sender before that function ever runs, so
 * `unknown_sender_public` is never written.
 */
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-dropped-messages' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-dropped-messages';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { recordDroppedMessage, getUnregisteredSenders } from '../../db/dropped-messages.js';
import { UNKNOWN_SENDER_POLICIES } from '../../types.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { dispatch } from '../dispatch.js';
import { getResource } from '../crud.js';
// Side-effect import: registers the `dropped-message` resource.
import { DROPPED_MESSAGE_REASONS } from './dropped-messages.js';

registerResourceHelpCommands();

describe('dropped-messages CLI reason enum', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    await closeDb();
  });

  it('lists every unknown_sender_* reason the host actually records, and not unknown_sender_public', () => {
    const column = getResource('dropped-messages')!.columns.find((c) => c.name === 'reason')!;
    expect(column.enum).toBe(DROPPED_MESSAGE_REASONS);
    expect(column.enum).toEqual([
      'no_agent_wired',
      'no_agent_engaged',
      'unknown_sender_strict',
      'unknown_sender_request_approval',
      'unknown_sender_decline_notify',
    ]);
    expect(column.enum).not.toContain('unknown_sender_public');
  });

  it('derives its unknown_sender_* reasons from UNKNOWN_SENDER_POLICIES, minus public', () => {
    expect(DROPPED_MESSAGE_REASONS).toEqual([
      'no_agent_wired',
      'no_agent_engaged',
      ...UNKNOWN_SENDER_POLICIES.filter((policy) => policy !== 'public').map((policy) => `unknown_sender_${policy}`),
    ]);
  });

  it('help lists unknown_sender_decline_notify as a reason value', async () => {
    const resp = await dispatch({ id: 'req-help', command: 'dropped-messages-help', args: {} }, { caller: 'host' });
    if (!resp.ok) throw new Error(resp.error.message);
    expect(String(resp.data)).toContain('unknown_sender_decline_notify');
  });

  it('describes the public-group exception in the resource description', () => {
    const description = getResource('dropped-messages')!.description;
    expect(description).toContain('unknown_sender_decline_notify');
    expect(description).toContain('a public group admits every sender');
  });

  it('round-trips a decline_notify drop the way handleUnknownSender records it', async () => {
    await recordDroppedMessage({
      channel_type: 'whatsapp',
      platform_id: 'dm-1',
      user_id: null,
      sender_name: 'Stray Sender',
      reason: 'unknown_sender_decline_notify',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
    });
    const rows = await getUnregisteredSenders();
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('unknown_sender_decline_notify');
    expect(getResource('dropped-messages')!.columns.find((c) => c.name === 'reason')!.enum).toContain(rows[0].reason);
  });
});

/**
 * Coverage tests for ensureUserDm's remaining branches: privacy-safe logging
 * variants, malformed namespaced ids, the Teams-style `kind` fallback when the
 * id prefix is not a registered adapter, and cache rows pointing at a deleted
 * messaging group.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from '../../channels/adapter.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { sqliteRaw } from '../../db/drivers/sqlite.js';
import { log } from '../../log.js';
import { getUserDm, upsertUserDm } from './db/user-dms.js';
import { createUser } from './db/users.js';
import { ensureUserDm } from './user-dm.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await teardownChannelAdapters();
  await closeDb();
});

async function mountAdapter(channelType: string, openDM?: (handle: string) => Promise<string>): Promise<void> {
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) adapter.openDM = openDM;
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

describe('ensureUserDm — edge branches', () => {
  it('returns null for an unknown user, omitting the id from logs under privacySafeLogs', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    expect(await ensureUserDm('cov:ghost', { privacySafeLogs: true })).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: user not found', undefined);

    expect(await ensureUserDm('cov:ghost')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: user not found', { userId: 'cov:ghost' });
  });

  it('returns null for ids that are not namespaced (no colon, empty prefix, empty handle)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await mountAdapter('covdm');
    for (const id of ['bare', ':handle', 'covdm:']) {
      await createUser({ id, kind: 'covdm', display_name: null, created_at: now() });
    }
    expect(await ensureUserDm('bare')).toBeNull();
    expect(await ensureUserDm(':handle', { privacySafeLogs: true })).toBeNull();
    expect(await ensureUserDm('covdm:')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: user id not namespaced', { userId: 'bare' });
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: user id not namespaced', undefined);
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: user id not namespaced', { userId: 'covdm:' });
  });

  it('Teams-style ids: unregistered prefix falls back to user.kind with the full id as the handle', async () => {
    const opened: string[] = [];
    await mountAdapter('covteams', async (handle) => {
      opened.push(handle);
      return `conv-${handle}`;
    });
    await createUser({ id: '29:abc', kind: 'covteams', display_name: 'Tee', created_at: now() });

    const mg = await ensureUserDm('29:abc');
    expect(mg).not.toBeNull();
    expect(mg!.channel_type).toBe('covteams');
    expect(mg!.platform_id).toBe('conv-29:abc');
    expect(mg!.name).toBe('Tee');
    expect(opened).toEqual(['29:abc']);
    expect((await getUserDm('29:abc', 'covteams'))?.messaging_group_id).toBe(mg!.id);
  });

  it('re-resolves when the cached row points at a deleted messaging group (privacy-safe log shape)', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await mountAdapter('covstale');
    await createUser({ id: 'covstale:u1', kind: 'covstale', display_name: null, created_at: now() });
    // Stale cache entry: user_dms row referencing a messaging_group id that does not exist.
    sqliteRaw(getDb()).pragma('foreign_keys = OFF');
    await upsertUserDm({
      user_id: 'covstale:u1',
      channel_type: 'covstale',
      messaging_group_id: 'mg-deleted',
      resolved_at: now(),
    });
    sqliteRaw(getDb()).pragma('foreign_keys = ON');

    const mg = await ensureUserDm('covstale:u1', { privacySafeLogs: true });
    expect(mg).not.toBeNull();
    expect(mg!.platform_id).toBe('u1');
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: cached row references missing messaging_group, re-resolving', {
      channelType: 'covstale',
    });
    expect((await getUserDm('covstale:u1', 'covstale'))?.messaging_group_id).toBe(mg!.id);

    // Same scenario without privacySafeLogs reports the ids.
    sqliteRaw(getDb()).pragma('foreign_keys = OFF');
    await upsertUserDm({
      user_id: 'covstale:u1',
      channel_type: 'covstale',
      messaging_group_id: 'mg-deleted-2',
      resolved_at: now(),
    });
    sqliteRaw(getDb()).pragma('foreign_keys = ON');
    await ensureUserDm('covstale:u1');
    expect(warnSpy).toHaveBeenCalledWith('ensureUserDm: cached row references missing messaging_group, re-resolving', {
      userId: 'covstale:u1',
      messagingGroupId: 'mg-deleted-2',
    });
  });

  it('openDM failure under privacySafeLogs omits the handle from the error log', async () => {
    const errSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await mountAdapter('covboom', async () => {
      throw new Error('nope');
    });
    await createUser({ id: 'covboom:u1', kind: 'covboom', display_name: null, created_at: now() });
    expect(await ensureUserDm('covboom:u1', { privacySafeLogs: true })).toBeNull();
    expect(errSpy).toHaveBeenCalledWith('ensureUserDm: adapter.openDM failed', { channelType: 'covboom' });
  });
});

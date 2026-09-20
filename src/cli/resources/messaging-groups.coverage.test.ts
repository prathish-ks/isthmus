import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ routeInbound: vi.fn() }));
vi.mock('../../router.js', async () => {
  const actual = await vi.importActual<typeof import('../../router.js')>('../../router.js');
  return { ...actual, routeInbound: (...args: unknown[]) => state.routeInbound(...args) };
});
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initTestDb, closeDb, getDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { ResponseFrame } from '../frame.js';
// Side-effect import: registers messaging-groups-* including `send`.
import './messaging-groups.js';

const host = { caller: 'host' as const };
const now = () => new Date().toISOString();

function send(args: Record<string, unknown>): Promise<ResponseFrame> {
  return dispatch({ id: 's', command: 'messaging-groups-send', args }, host);
}
function errorOf(resp: ResponseFrame): string {
  if (resp.ok) throw new Error('expected an error frame');
  return resp.error.message;
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.routeInbound.mockResolvedValue(undefined);
  await runMigrations(await initTestDb({ fresh: true }));
  await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
     VALUES ('mg-1', 'telegram', 'chat-1', 'telegram', 'chat', 0, 'strict', ?),
            ('mg-2', 'telegram', 'chat-2', 'tg-second', 'chat two', 0, 'strict', ?)`,
    now(),
    now(),
  );
});
afterEach(() => closeDb());

describe('messaging-groups send', () => {
  it('requires channel type, platform id and text together', async () => {
    for (const args of [
      { platform_id: 'chat-1', text: 'hi' },
      { channel_type: 'telegram', text: 'hi' },
      { channel_type: 'telegram', platform_id: 'chat-1' },
    ]) {
      expect(errorOf(await send(args))).toBe('--channel-type, --platform-id and --text are required');
    }
    expect(state.routeInbound).not.toHaveBeenCalled();
  });

  it('reports a missing messaging group (default instance = channel type)', async () => {
    expect(errorOf(await send({ channel_type: 'telegram', platform_id: 'chat-2', text: 'hi' }))).toBe(
      'no messaging group for telegram chat-2 — create + wire it first',
    );
    expect(state.routeInbound).not.toHaveBeenCalled();
  });

  it('routes an inbound chat event in-process with cli defaults for sender identity', async () => {
    const before = Date.now();
    const resp = await send({ 'channel-type': 'telegram', 'platform-id': 'chat-1', text: 'welcome!' });
    expect(resp).toEqual({ id: 's', ok: true, data: { sent: { channel_type: 'telegram', platform_id: 'chat-1' } } });
    expect(state.routeInbound).toHaveBeenCalledTimes(1);
    const event = state.routeInbound.mock.calls[0][0] as {
      channelType: string;
      instance: string;
      platformId: string;
      threadId: string;
      message: { id: string; kind: string; timestamp: string; content: string };
    };
    expect(event).toMatchObject({
      channelType: 'telegram',
      instance: 'telegram',
      platformId: 'chat-1',
      threadId: 'chat-1',
    });
    expect(event.message.id).toMatch(/^send-[0-9a-f-]{36}$/);
    expect(event.message.kind).toBe('chat');
    expect(new Date(event.message.timestamp).getTime()).toBeGreaterThanOrEqual(before);
    expect(JSON.parse(event.message.content)).toEqual({ text: 'welcome!', sender: 'cli', senderId: 'cli:local' });
  });

  it('honours an explicit --instance, --sender and --sender-id', async () => {
    const resp = await send({
      channel_type: 'telegram',
      platform_id: 'chat-2',
      instance: 'tg-second',
      text: 'hey',
      sender: 'Dana',
      'sender-id': 'telegram:42',
    });
    expect(resp.ok).toBe(true);
    const event = state.routeInbound.mock.calls[0][0] as { instance: string; message: { content: string } };
    expect(event.instance).toBe('tg-second');
    expect(JSON.parse(event.message.content)).toEqual({ text: 'hey', sender: 'Dana', senderId: 'telegram:42' });
  });
});

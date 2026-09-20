/**
 * Coverage-uplift tests for the CLI channel: socket lifecycle (stale-socket
 * cleanup, chmod failure, teardown with a live client), the single-client
 * supersede semantics, line parsing (non-JSON, empty text, routed vs plain,
 * reply_to / sender passthrough, address validation) and deliver().
 *
 * The adapter binds a real Unix socket under a per-process temp dir — never
 * a running install's data/cli.sock — and every connection is closed and the
 * directory removed in afterAll.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, InboundEvent, InboundMessage } from './adapter.js';

// vi.mock factories are hoisted above imports (so no `path` here): the socket
// dir is computed inline — short (Unix socket paths cap ~104 bytes on macOS)
// and per-process, under the OS temp dir.
const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: `${(process.env.TMPDIR || '/tmp').replace(/\/+$/, '')}/ncl-cli-cov-${process.pid}`,
}));
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

import './cli.js';
import {
  getChannelAdapterExact,
  initChannelAdapters,
  startChannelAdapter,
  teardownChannelAdapters,
} from './channel-registry.js';

const SOCK = path.join(TEST_DIR, 'cli.sock');

// Host-side handlers, swappable per test.
let onInbound: ChannelSetup['onInbound'] = () => {};
let onInboundEvent: ChannelSetup['onInboundEvent'] = () => {};

const setupFn = (): ChannelSetup => ({
  onInbound: (...args) => onInbound(...args),
  onInboundEvent: (event) => onInboundEvent(event),
  onMetadata() {},
  onAction() {},
});

/** A connected client that records every JSON line the server writes back. */
interface Client {
  socket: net.Socket;
  lines: string[];
  closed: Promise<void>;
  /** Resolve once at least `n` lines have arrived. */
  waitForLines(n: number): Promise<string[]>;
  send(obj: unknown): void;
  sendRaw(raw: string): void;
}

const openClients: Client[] = [];

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const waiters: Array<{ n: number; resolve: (lines: string[]) => void }> = [];
    let buffer = '';
    let onClosed: () => void = () => {};
    const closed = new Promise<void>((r) => {
      onClosed = r;
    });
    const socket = net.connect(SOCK, () => {
      const client: Client = {
        socket,
        lines,
        closed,
        waitForLines(n) {
          if (lines.length >= n) return Promise.resolve(lines.slice());
          return new Promise((r) => waiters.push({ n, resolve: r }));
        },
        send(obj) {
          socket.write(JSON.stringify(obj) + '\n');
        },
        sendRaw(raw) {
          socket.write(raw);
        },
      };
      openClients.push(client);
      resolve(client);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        lines.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
      for (const w of waiters.splice(0)) {
        if (lines.length >= w.n) w.resolve(lines.slice());
        else waiters.push(w);
      }
    });
    socket.on('close', () => onClosed());
    socket.once('error', reject);
  });
}

/** Send a plain chat line and resolve with the InboundMessage the host received. */
function chat(client: Client, text: unknown, extra: Record<string, unknown> = {}): Promise<InboundMessage> {
  return new Promise((resolve) => {
    onInbound = (_platformId, _threadId, message) => {
      resolve(message);
    };
    client.send({ text, ...extra });
  });
}

/** Send a routed line and resolve with the InboundEvent the host received. */
function routed(client: Client, payload: Record<string, unknown>): Promise<InboundEvent> {
  return new Promise((resolve) => {
    onInboundEvent = (event) => {
      resolve(event);
    };
    client.send(payload);
  });
}

const tick = () => new Promise((r) => setTimeout(r, 30));

function cli(): ChannelAdapter {
  const adapter = getChannelAdapterExact('cli');
  if (!adapter) throw new Error('cli adapter not active');
  return adapter;
}

beforeAll(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initChannelAdapters(setupFn);
});

afterAll(async () => {
  await teardownChannelAdapters();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  onInbound = () => {};
  onInboundEvent = () => {};
  for (const c of openClients.splice(0)) {
    if (!c.socket.destroyed) c.socket.destroy();
  }
  await tick();
  vi.restoreAllMocks();
});

describe('registration and deliver()', () => {
  it('registers as an always-on adapter with pattern/public defaults and no thread support', () => {
    const adapter = cli();
    expect(adapter.channelType).toBe('cli');
    expect(adapter.supportsThreads).toBe(false);
    expect(adapter.isConnected()).toBe(true);
    expect(adapter.defaults).toMatchObject({
      dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
      group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
      mentions: 'never',
    });
  });

  it('ignores a foreign platformId and no-ops when no terminal is connected', async () => {
    const adapter = cli();
    await expect(adapter.deliver('discord:1', null, { kind: 'chat', content: { text: 'x' } })).resolves.toBeUndefined();
    await expect(adapter.deliver('local', null, { kind: 'chat', content: { text: 'x' } })).resolves.toBeUndefined();
  });

  it('writes one JSON line per delivered message to the connected chat client', async () => {
    const client = await connect();
    const first = await chat(client, 'hello');
    expect(first.kind).toBe('chat');
    expect(first.id).toMatch(/^cli-\d+-[a-z0-9]+$/);
    expect(first.content).toEqual({ text: 'hello', sender: 'cli', senderId: 'cli:local' });

    const adapter = cli();
    await adapter.deliver('local', null, { kind: 'chat', content: { text: 'reply one' } });
    await adapter.deliver('local', null, { kind: 'chat', content: 'bare string content' });
    // Content without a text field is not deliverable to a terminal: nothing written.
    await adapter.deliver('local', null, { kind: 'chat', content: { type: 'card', card: {} } });
    await adapter.deliver('local', null, { kind: 'chat', content: undefined as unknown as string });

    const lines = await client.waitForLines(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ text: 'reply one' }, { text: 'bare string content' }]);
    await tick();
    expect(client.lines).toHaveLength(2);
  });

  it('logs and continues when the client socket write throws', async () => {
    const client = await connect();
    await chat(client, 'hello');
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const boom = new Error('EPIPE');
    const write = vi.spyOn(net.Socket.prototype, 'write').mockImplementation(() => {
      throw boom;
    });
    try {
      await expect(cli().deliver('local', null, { kind: 'chat', content: { text: 'x' } })).resolves.toBeUndefined();
    } finally {
      write.mockRestore();
    }
    expect(warn).toHaveBeenCalledWith('Failed to write to CLI client', { err: boom });
  });
});

describe('line parsing', () => {
  it('drops non-JSON lines with a warning and skips blank lines', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const inbound = vi.fn();
    onInbound = inbound;
    const client = await connect();
    client.sendRaw('not json at all\n\n   \n');
    await tick();
    expect(warn).toHaveBeenCalledWith('CLI: ignoring non-JSON line from client', { line: 'not json at all' });
    expect(inbound).not.toHaveBeenCalled();
  });

  it('ignores payloads whose text is missing, non-string or empty', async () => {
    const inbound = vi.fn();
    const inboundEvent = vi.fn();
    onInbound = inbound;
    onInboundEvent = inboundEvent;
    const client = await connect();
    client.send({});
    client.send({ text: 42 });
    client.send({ text: '' });
    client.send({ text: '', to: { channelType: 'x', platformId: 'y' } });
    await tick();
    expect(inbound).not.toHaveBeenCalled();
    expect(inboundEvent).not.toHaveBeenCalled();
  });

  it('reassembles lines split across chunks', async () => {
    const client = await connect();
    const received = new Promise<InboundMessage>((resolve) => {
      onInbound = (_p, _t, message) => resolve(message);
    });
    client.sendRaw('{"text":"spl');
    await tick();
    client.sendRaw('it up"}\n');
    expect((await received).content).toMatchObject({ text: 'split up' });
  });

  it('logs when the host onInbound handler throws', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const boom = new Error('router down');
    let threw: Promise<void> = Promise.resolve();
    onInbound = () => {
      threw = Promise.reject(boom);
      threw.catch(() => {});
      return threw;
    };
    const client = await connect();
    client.send({ text: 'hi' });
    await tick();
    expect(error).toHaveBeenCalledWith('CLI: onInbound threw', { err: boom });
  });
});

describe('routed (`to`-bearing) lines', () => {
  const client1 = () => connect();

  it('builds a full InboundEvent with reply_to, sender and senderId passthrough', async () => {
    const client = await client1();
    const event = await routed(client, {
      text: 'welcome',
      to: { channelType: 'discord', platformId: 'discord:@me:1', threadId: 'discord:@me:1:t', instance: 'discord-two' },
      reply_to: { channelType: 'cli', platformId: 'local', threadId: null },
      sender: 'Operator',
      senderId: 'cli:operator',
    });
    expect(event).toMatchObject({
      channelType: 'discord',
      instance: 'discord-two',
      platformId: 'discord:@me:1',
      threadId: 'discord:@me:1:t',
      replyTo: { channelType: 'cli', platformId: 'local', threadId: null, instance: undefined },
    });
    expect(event.message.kind).toBe('chat');
    expect(event.message.id).toMatch(/^cli-/);
    expect(JSON.parse(event.message.content as string)).toEqual({
      text: 'welcome',
      sender: 'Operator',
      senderId: 'cli:operator',
    });
  });

  it('defaults sender/senderId, nulls a non-string threadId and omits an invalid reply_to', async () => {
    const client = await client1();
    const event = await routed(client, {
      text: 'ping',
      to: { channelType: 'slack', platformId: 'slack:C1', threadId: 12345 },
      reply_to: { channelType: 'slack' }, // missing platformId ⇒ not an address
      sender: 7,
      senderId: null,
    });
    expect(event.threadId).toBeNull();
    expect(event.replyTo).toBeUndefined();
    expect(event.instance).toBeUndefined();
    expect(JSON.parse(event.message.content as string)).toEqual({ text: 'ping', sender: 'cli', senderId: 'cli:local' });
  });

  it('drops a non-URL-safe to.instance with a warning and routes to the default instance', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const client = await client1();
    const event = await routed(client, {
      text: 'x',
      to: { channelType: 'telegram', platformId: 'telegram:42', instance: 'bad/key' },
    });
    expect(event.instance).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('CLI: ignoring non-URL-safe to.instance, routing to the default instance', {
      instance: 'bad/key',
    });
  });

  it('treats a non-object or incomplete `to` as a plain chat line', async () => {
    const inboundEvent = vi.fn();
    onInboundEvent = inboundEvent;
    const client = await client1();
    const a = await chat(client, 'one', { to: 'discord' });
    expect(a.content).toMatchObject({ text: 'one' });
    const b = await chat(client, 'two', { to: { channelType: 'discord' } });
    expect(b.content).toMatchObject({ text: 'two' });
    const c = await chat(client, 'three', { to: { platformId: 'x', channelType: 99 } });
    expect(c.content).toMatchObject({ text: 'three' });
    expect(inboundEvent).not.toHaveBeenCalled();
  });

  it('logs when the host onInboundEvent handler throws', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const boom = new Error('no such wiring');
    onInboundEvent = async () => {
      throw boom;
    };
    const client = await client1();
    client.send({ text: 'x', to: { channelType: 'slack', platformId: 'slack:C1' } });
    await tick();
    expect(error).toHaveBeenCalledWith('CLI: onInboundEvent threw', { err: boom });
  });
});

describe('single-client chat semantics', () => {
  it('a newer chat client supersedes the older one; routed one-shots do not evict it', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const older = await connect();
    await chat(older, 'first');

    const newer = await connect();
    await chat(newer, 'second');

    const notice = await older.waitForLines(1);
    expect(JSON.parse(notice[0])).toEqual({ text: '[superseded by a newer client]' });
    await older.closed;
    // The server-side 'close' for the evicted socket lands one turn after the client sees it.
    await tick();
    expect(info).toHaveBeenCalledWith('CLI client connected');
    expect(info).toHaveBeenCalledWith('CLI client disconnected');

    // A routed admin connection is one-shot: the chat slot still belongs to `newer`.
    const admin = await connect();
    await routed(admin, { text: 'welcome', to: { channelType: 'slack', platformId: 'slack:C1' } });
    admin.socket.end();
    await tick();
    await cli().deliver('local', null, { kind: 'chat', content: { text: 'still yours' } });
    const got = await newer.waitForLines(1);
    expect(JSON.parse(got[0])).toEqual({ text: 'still yours' });
    expect(newer.socket.destroyed).toBe(false);
  });

  it('a disconnected chat client releases the slot so deliver() no-ops again', async () => {
    const client = await connect();
    await chat(client, 'hi');
    client.socket.destroy();
    await client.closed;
    await tick();
    const write = vi.spyOn(net.Socket.prototype, 'write');
    await cli().deliver('local', null, { kind: 'chat', content: { text: 'nobody home' } });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('socket lifecycle', () => {
  it('teardown ends a live chat client, closes the server and removes the socket file', async () => {
    const client = await connect();
    await chat(client, 'hi');
    await teardownChannelAdapters();
    await client.closed;
    expect(fs.existsSync(SOCK)).toBe(false);
    expect(getChannelAdapterExact('cli')).toBeUndefined();

    // Bring the channel back for the remaining tests via the hot-start seam.
    await expect(startChannelAdapter('cli')).resolves.toBe('started');
    expect(fs.existsSync(SOCK)).toBe(true);
  });

  it('a second teardown on an already-closed adapter is a harmless no-op', async () => {
    const adapter = cli();
    await teardownChannelAdapters();
    await expect(adapter.teardown()).resolves.toBeUndefined();
    expect(adapter.isConnected()).toBe(false);
    await expect(startChannelAdapter('cli')).resolves.toBe('started');
  });

  it('warns when the socket cannot be chmod-ed but keeps listening', async () => {
    await teardownChannelAdapters();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const boom = new Error('EPERM');
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw boom;
    });
    try {
      await expect(startChannelAdapter('cli')).resolves.toBe('started');
    } finally {
      chmod.mockRestore();
    }
    expect(warn).toHaveBeenCalledWith('Failed to chmod CLI socket (continuing)', { sock: SOCK, err: boom });
    const client = await connect();
    expect((await chat(client, 'still works')).content).toMatchObject({ text: 'still works' });
  });

  it('warns on a stale socket path it cannot unlink, then fails setup loudly when bind is impossible', async () => {
    await teardownChannelAdapters();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    // A non-empty directory at the socket path: unlinkSync fails with a
    // non-ENOENT code, and listen() then rejects.
    fs.mkdirSync(SOCK, { recursive: true });
    fs.writeFileSync(path.join(SOCK, 'keep'), '');
    try {
      await expect(startChannelAdapter('cli')).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith(
        'Failed to unlink stale CLI socket (will try to bind anyway)',
        expect.objectContaining({ sock: SOCK }),
      );
      expect(getChannelAdapterExact('cli')).toBeUndefined();
    } finally {
      fs.rmSync(SOCK, { recursive: true, force: true });
    }
    // A leftover regular file IS unlinked silently and the bind succeeds.
    fs.writeFileSync(SOCK, '');
    warn.mockClear();
    await expect(startChannelAdapter('cli')).resolves.toBe('started');
    expect(warn).not.toHaveBeenCalled();
    const client = await connect();
    expect((await chat(client, 'after recovery')).content).toMatchObject({ text: 'after recovery' });
  });
});

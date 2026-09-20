import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach, afterAll } from 'vitest';

import { DATA_DIR } from '../config.js';
import type { RequestFrame } from './frame.js';
import { DEFAULT_SOCKET_PATH, SocketTransport } from './socket-client.js';

// Unix socket paths are length-limited (104 bytes on macOS) — keep them short.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-sc-'));
let server: net.Server | null = null;
let n = 0;

function sockPath(): string {
  return path.join(tmp, `s${n++}.sock`);
}

/** Start a server whose per-connection behaviour is `onConn`; resolves to its path. */
function serve(onConn: (conn: net.Socket, received: (cb: (line: string) => void) => void) => void): Promise<string> {
  const p = sockPath();
  server = net.createServer((conn) => {
    let buf = '';
    const waiters: Array<(line: string) => void> = [];
    conn.on('data', (c) => {
      buf += c.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        for (const w of waiters.splice(0)) w(line);
      }
    });
    onConn(conn, (cb) => waiters.push(cb));
  });
  return new Promise((resolve) => server!.listen(p, () => resolve(p)));
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  }
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const req: RequestFrame = { id: 'req-1', command: 'groups-list', args: { limit: '5' } };

describe('SocketTransport.sendFrame', () => {
  it('writes the request as one JSON line and resolves with the response frame', async () => {
    let seen = '';
    const p = await serve((conn, received) => {
      received((line) => {
        seen = line;
        conn.write(JSON.stringify({ id: 'req-1', ok: true, data: [1, 2] }) + '\n');
        conn.end();
      });
    });
    const res = await new SocketTransport(p).sendFrame(req);
    expect(JSON.parse(seen)).toEqual(req);
    expect(res).toEqual({ id: 'req-1', ok: true, data: [1, 2] });
  });

  it('buffers partial chunks until the newline arrives', async () => {
    const p = await serve((conn, received) => {
      received(() => {
        const full = JSON.stringify({ id: 'req-1', ok: false, error: { code: 'forbidden', message: 'no' } });
        conn.write(full.slice(0, 10));
        setTimeout(() => {
          conn.write(full.slice(10) + '\n');
          conn.end();
        }, 20);
      });
    });
    const res = await new SocketTransport(p).sendFrame(req);
    expect(res).toEqual({ id: 'req-1', ok: false, error: { code: 'forbidden', message: 'no' } });
  });

  it('rejects with "malformed response" when the line is not JSON', async () => {
    const p = await serve((conn, received) => {
      received(() => {
        conn.write('this is not json\n');
        conn.end();
      });
    });
    await expect(new SocketTransport(p).sendFrame(req)).rejects.toThrow(/^malformed response from host: /);
  });

  it('rejects when the host closes the connection without responding', async () => {
    const p = await serve((conn, received) => {
      received(() => conn.end());
    });
    await expect(new SocketTransport(p).sendFrame(req)).rejects.toThrow(
      'host closed connection before sending response',
    );
  });

  it('rejects with the connection error when nothing listens on the socket path', async () => {
    const missing = sockPath();
    await expect(new SocketTransport(missing).sendFrame(req)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('settles exactly once even when a close follows the response', async () => {
    // A second event after settling (close after resolve) must not reject —
    // the promise result is the frame and stays the frame.
    const p = await serve((conn, received) => {
      received(() => {
        conn.write(JSON.stringify({ id: 'req-1', ok: true, data: null }) + '\n');
        conn.destroy();
      });
    });
    const t = new SocketTransport(p);
    const res = await t.sendFrame(req);
    expect(res).toEqual({ id: 'req-1', ok: true, data: null });
    await new Promise((r) => setTimeout(r, 20));
  });

  it('defaults to DATA_DIR/ncl.sock', () => {
    expect(DEFAULT_SOCKET_PATH).toBe(path.join(DATA_DIR, 'ncl.sock'));
  });
});

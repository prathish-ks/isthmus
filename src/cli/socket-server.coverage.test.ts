import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../log.js', () => ({ log: state.log }));
// The server's only job is framing + caller identity; the dispatcher is a collaborator.
vi.mock('./dispatch.js', () => ({ dispatch: (...args: unknown[]) => state.dispatch(...args) }));

import { startCliServer, stopCliServer } from './socket-server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-ss-'));
let n = 0;
const sockPath = () => path.join(tmp, `s${n++}.sock`);

/** Connect, write `text`, and collect everything the server sends until it closes. */
function exchange(p: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(p);
    let out = '';
    c.on('connect', () => c.write(text));
    c.on('data', (d) => (out += d.toString('utf8')));
    c.on('close', () => resolve(out));
    c.on('error', reject);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.dispatch.mockImplementation(async (req: { id: string; args: unknown }, ctx: unknown) => ({
    id: req.id,
    ok: true,
    data: { echo: req.args, ctx },
  }));
});

afterEach(() => stopCliServer());
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('startCliServer', () => {
  it('binds a 0600 socket and answers a well-formed frame with caller=host', async () => {
    const p = sockPath();
    await startCliServer(p);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(state.log.info).toHaveBeenCalledWith('ncl CLI server listening', { socketPath: p });

    const out = await exchange(p, JSON.stringify({ id: 'r1', command: 'groups-list', args: { a: 1 } }) + '\n');
    expect(JSON.parse(out)).toEqual({ id: 'r1', ok: true, data: { echo: { a: 1 }, ctx: { caller: 'host' } } });
    expect(state.dispatch).toHaveBeenCalledWith(
      { id: 'r1', command: 'groups-list', args: { a: 1 } },
      { caller: 'host' },
    );
  });

  it('removes a stale socket file left by a previous run before binding', async () => {
    const p = sockPath();
    fs.writeFileSync(p, 'stale');
    await startCliServer(p);
    expect(fs.statSync(p).isSocket()).toBe(true);
    expect(state.log.warn).not.toHaveBeenCalled();
  });

  it('warns when the stale path cannot be unlinked, then fails to bind', async () => {
    const p = sockPath();
    fs.mkdirSync(p); // a directory: unlink fails with something other than ENOENT
    await expect(startCliServer(p)).rejects.toThrow();
    expect(state.log.warn).toHaveBeenCalledWith(
      'Failed to unlink stale ncl socket (will try to bind anyway)',
      expect.objectContaining({ socketPath: p }),
    );
  });

  it('continues (with a warning) when chmod fails', async () => {
    const p = sockPath();
    const spy = vi.spyOn(fs, 'chmodSync').mockImplementationOnce(() => {
      throw new Error('chmod denied');
    });
    await startCliServer(p);
    spy.mockRestore();
    expect(state.log.warn).toHaveBeenCalledWith(
      'Failed to chmod ncl socket (continuing)',
      expect.objectContaining({ socketPath: p }),
    );
    // Still serving.
    const out = await exchange(p, JSON.stringify({ id: 'r2', command: 'help', args: {} }) + '\n');
    expect(JSON.parse(out).ok).toBe(true);
  });

  it('skips blank lines before the frame', async () => {
    const p = sockPath();
    await startCliServer(p);
    const out = await exchange(p, '\n   \n' + JSON.stringify({ id: 'r3', command: 'help', args: {} }) + '\n');
    expect(JSON.parse(out).id).toBe('r3');
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it('answers invalid JSON with a transport-error frame and never dispatches', async () => {
    const p = sockPath();
    await startCliServer(p);
    const out = await exchange(p, '{not json\n');
    const frame = JSON.parse(out);
    expect(frame.id).toBe('unknown');
    expect(frame.ok).toBe(false);
    expect(frame.error.code).toBe('transport-error');
    expect(frame.error.message).toMatch(/^bad frame: /);
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it('rejects JSON that is not a request frame (null, primitives, missing fields)', async () => {
    const p = sockPath();
    await startCliServer(p);
    for (const bad of ['null', '"str"', '42', '{"id":"x"}', '{"id":"x","command":"c","args":null}']) {
      const frame = JSON.parse(await exchange(p, bad + '\n'));
      expect(frame).toEqual({
        id: 'unknown',
        ok: false,
        error: { code: 'transport-error', message: 'bad frame: bad request shape' },
      });
    }
    expect(state.dispatch).not.toHaveBeenCalled();
  });
});

describe('stopCliServer', () => {
  it('is a no-op when no server is running, and closes a running one', async () => {
    await expect(stopCliServer()).resolves.toBeUndefined();
    const p = sockPath();
    await startCliServer(p);
    await stopCliServer();
    await expect(exchange(p, '{}\n')).rejects.toMatchObject({ code: expect.stringMatching(/ENOENT|ECONNREFUSED/) });
    // Idempotent: a second stop after close does nothing.
    await expect(stopCliServer()).resolves.toBeUndefined();
  });
});

/**
 * `ncl` binary entry point. The module runs `main()` on import, so every case
 * re-imports it with a fresh module graph, the transport and stdin reader
 * mocked, and `process.exit` replaced by a sentinel throw (the first exit
 * ends the run exactly like the real thing; the entry point's own
 * `main().catch` then reports the sentinel as an "unexpected error" — we
 * assert on the FIRST exit code and the output written before it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  sendFrame: vi.fn(),
  readStdin: vi.fn(),
}));

vi.mock('./socket-client.js', () => ({
  DEFAULT_SOCKET_PATH: '/nonexistent/ncl.sock',
  SocketTransport: class {
    sendFrame(...args: unknown[]) {
      return state.sendFrame(...args);
    }
  },
}));
vi.mock('./stdin-json.js', async () => {
  const actual = await vi.importActual<typeof import('./stdin-json.js')>('./stdin-json.js');
  return { ...actual, readStdinJsonArgs: (...args: unknown[]) => state.readStdin(...args) };
});

import { StdinJsonInputError } from './stdin-json.js';

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

type Run = { exits: number[]; stdout: string; stderr: string };

const origArgv = process.argv;
const origExit = process.exit;
const origStdoutWrite = process.stdout.write;
const origStderrWrite = process.stderr.write;
const origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

async function run(argv: string[], opts: { tty?: boolean } = {}): Promise<Run> {
  const r: Run = { exits: [], stdout: '', stderr: '' };
  process.argv = ['node', 'ncl', ...argv];
  Object.defineProperty(process.stdin, 'isTTY', { value: opts.tty ?? false, configurable: true });
  process.exit = ((code?: number) => {
    r.exits.push(code ?? 0);
    if (r.exits.length === 1) throw new ExitSignal(code ?? 0);
  }) as never;
  process.stdout.write = ((chunk: unknown, cb?: unknown) => {
    r.stdout += String(chunk);
    if (typeof cb === 'function') cb();
    return true;
  }) as never;
  process.stderr.write = ((chunk: unknown) => {
    r.stderr += String(chunk);
    return true;
  }) as never;

  vi.resetModules();
  await import('./client.js');
  await vi.waitFor(() => expect(r.exits.length).toBeGreaterThan(0));
  // Let main().catch settle so nothing leaks into the next case.
  await new Promise((res) => setImmediate(res));
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  process.argv = origArgv;
  process.exit = origExit;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  if (origIsTTY) Object.defineProperty(process.stdin, 'isTTY', origIsTTY);
  else delete (process.stdin as unknown as Record<string, unknown>).isTTY;
});

describe('ncl client entry point', () => {
  it('prints usage and exits 0 with no arguments, --help, or -h', async () => {
    for (const argv of [[], ['--help'], ['-h']]) {
      const r = await run(argv);
      expect(r.exits[0]).toBe(0);
      expect(r.stdout).toContain('Usage: ncl <resource> <verb>');
      expect(r.stdout).toContain('Run `ncl help`');
      expect(state.sendFrame).not.toHaveBeenCalled();
    }
  });

  it('reports a missing command (flags only) with usage and exit 2', async () => {
    const r = await run(['--json']);
    expect(r.exits[0]).toBe(2);
    expect(r.stderr).toContain('ncl: missing command');
    expect(r.stdout).toContain('Usage: ncl');
    expect(state.sendFrame).not.toHaveBeenCalled();
  });

  it('sends a request frame with a uuid id and prints the server-rendered human view verbatim', async () => {
    state.sendFrame.mockResolvedValue({ id: 'x', ok: true, data: [{ a: 1 }], human: 'TABLE' });
    const r = await run(['groups', 'list', '--limit', '5']);
    expect(state.sendFrame).toHaveBeenCalledTimes(1);
    const frame = state.sendFrame.mock.calls[0][0] as { id: string; command: string; args: unknown };
    expect(frame.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(frame.command).toBe('groups-list');
    expect(frame.args).toEqual({ limit: '5' });
    expect(r.stdout).toBe('TABLE\n');
    expect(r.exits[0]).toBe(0);
  });

  it('falls back to the client formatter when no human view is attached', async () => {
    state.sendFrame.mockResolvedValue({ id: 'x', ok: true, data: 'plain' });
    const r = await run(['help']);
    expect(r.stdout).toBe('plain\n');
    expect(r.exits[0]).toBe(0);
  });

  it('--json prints the raw frame (ignoring human) and still exits 0', async () => {
    const res = { id: 'x', ok: true, data: { k: 1 }, human: 'IGNORED' };
    state.sendFrame.mockResolvedValue(res);
    const r = await run(['groups', 'get', 'abc', '--json']);
    expect(r.stdout).toBe(JSON.stringify(res, null, 2) + '\n');
    expect(r.stdout).not.toContain('IGNORED\n');
    expect(r.exits[0]).toBe(0);
  });

  it('exits 1 on an error frame after printing it', async () => {
    state.sendFrame.mockResolvedValue({ id: 'x', ok: false, error: { code: 'forbidden', message: 'nope' } });
    const r = await run(['roles', 'grant']);
    expect(r.stdout).toBe('error (forbidden): nope\n');
    expect(r.exits[0]).toBe(1);
  });

  it('exits 2 with the transport hint when the host is unreachable', async () => {
    state.sendFrame.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const r = await run(['help']);
    expect(r.exits[0]).toBe(2);
    expect(r.stderr).toContain('ncl: cannot reach NanoClaw host (connect ECONNREFUSED)');
    expect(r.stderr).toContain('pnpm run dev');
  });

  it('exits 2 with a plain transport error for other failures', async () => {
    state.sendFrame.mockRejectedValue(new Error('malformed response from host: x'));
    const r = await run(['help']);
    expect(r.exits[0]).toBe(2);
    expect(r.stderr).toContain('ncl: transport error: malformed response from host: x');
  });

  describe('--stdin-json', () => {
    it('refuses a TTY stdin', async () => {
      const r = await run(['groups', 'create', '--stdin-json'], { tty: true });
      expect(r.exits[0]).toBe(2);
      expect(r.stderr).toContain('--stdin-json requires piped stdin');
      expect(state.readStdin).not.toHaveBeenCalled();
    });

    it('merges piped JSON with argv flags into the request args', async () => {
      state.readStdin.mockResolvedValue({ name: 'from-stdin', folder: 'f' });
      state.sendFrame.mockResolvedValue({ id: 'x', ok: true, data: null });
      const r = await run(['groups', 'create', '--stdin-json', '--folder', 'f']);
      expect(state.readStdin).toHaveBeenCalledWith(process.stdin, { folder: 'f' });
      expect(state.sendFrame.mock.calls[0][0]).toMatchObject({
        command: 'groups-create',
        args: { name: 'from-stdin', folder: 'f' },
      });
      expect(r.exits[0]).toBe(0);
    });

    it('reports a StdinJsonInputError and exits 2', async () => {
      state.readStdin.mockRejectedValue(new StdinJsonInputError('stdin JSON must be an object'));
      const r = await run(['groups', 'create', '--stdin-json']);
      expect(r.exits[0]).toBe(2);
      expect(r.stderr).toContain('ncl: stdin JSON must be an object');
      expect(state.sendFrame).not.toHaveBeenCalled();
    });

    it('rethrows other stdin failures to the top-level "unexpected error" handler', async () => {
      state.readStdin.mockRejectedValue(new Error('EPIPE boom'));
      const r = await run(['groups', 'create', '--stdin-json']);
      expect(r.exits[0]).toBe(2);
      expect(r.stderr).toContain('ncl: unexpected error: EPIPE boom');
      expect(state.sendFrame).not.toHaveBeenCalled();
    });
  });
});

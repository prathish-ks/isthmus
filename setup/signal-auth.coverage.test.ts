/**
 * Coverage for setup/signal-auth.ts — links this host to an existing Signal
 * account via signal-cli's QR-linking flow.
 *
 * `child_process` is fully mocked (`spawnSync` for the `--version` probe and
 * `listAccounts`, `spawn` for the long-running `link` child) so no real
 * signal-cli process is ever started. `qrcode` (a dependency the /add-signal
 * skill installs, not present in this trunk checkout) is mocked too, with a
 * controllable throw so both renderQr() branches (real QR art vs. its
 * defensive URL-only fallback) are exercised deterministically — relying on
 * the real absent-module import failure instead is not deterministic under
 * fake timers, since ESM module-resolution I/O does not run on the fake
 * timer clock.
 *
 * `vi.useFakeTimers()` drives the 500ms post-finish exit delay and the
 * 180s overall link timeout without real waits. Because `finish()`'s
 * deferred `process.exit()` fires from inside a raw `setTimeout` callback —
 * outside the Promise chain `run()` returns — a thrown ExitSignal there
 * surfaces as a *rejection of `vi.advanceTimersByTimeAsync()`*, not of
 * `run()`; `advanceTimers()` below catches that the same way `runSignalAuth`
 * catches it from `run()` itself.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown> & { step: string }>);
vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    emitted.push({ step, ...fields });
  }),
}));

const qrcodeState = vi.hoisted(() => ({ shouldThrow: false, art: 'XX\nXX' }));
vi.mock('qrcode', () => ({
  toString: vi.fn(async () => {
    if (qrcodeState.shouldThrow) throw new Error('qrcode render failed');
    return qrcodeState.art;
  }),
}));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const cp = vi.hoisted(() => ({
  versionProbe: { error: undefined as Error | undefined, status: 0 as number | null },
  listAccountsResult: { status: 0 as number | null, stdout: '[]' },
  lastChild: undefined as FakeChild | undefined,
  spawnCalls: [] as Array<{ cmd: string; args: string[] }>,
  spawnSyncCalls: [] as Array<{ cmd: string; args: string[] }>,
}));
vi.mock('child_process', () => ({
  spawnSync: vi.fn((cmd: string, args: string[] = [], _opts?: unknown) => {
    cp.spawnSyncCalls.push({ cmd, args });
    if (args[0] === '--version') return { error: cp.versionProbe.error, status: cp.versionProbe.status };
    if (args.includes('listAccounts'))
      return { status: cp.listAccountsResult.status, stdout: cp.listAccountsResult.stdout };
    return { status: 0, stdout: '' };
  }),
  spawn: vi.fn((cmd: string, args: string[] = [], _opts?: unknown) => {
    cp.spawnCalls.push({ cmd, args });
    const child = makeFakeChild();
    cp.lastChild = child;
    return child;
  }),
}));

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}
const origExit = process.exit;
let stdoutWrites: string[] = [];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  emitted.length = 0;
  qrcodeState.shouldThrow = false;
  qrcodeState.art = 'XX\nXX';
  cp.versionProbe = { error: undefined, status: 0 };
  cp.listAccountsResult = { status: 0, stdout: '[]' };
  cp.lastChild = undefined;
  cp.spawnCalls = [];
  cp.spawnSyncCalls = [];
  stdoutWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  vi.stubEnv('SIGNAL_CLI_PATH', '');
  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  stdoutSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function runSignalAuth(): Promise<{ exits: number[]; done: Promise<void> }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;
  const { run } = await import('./signal-auth.js');
  const done = run([]).catch((err: unknown) => {
    if (!(err instanceof ExitSignal)) throw err;
  });
  return { exits, done };
}

/**
 * Advance the fake timer clock, swallowing an ExitSignal thrown from inside a
 * timer callback (finish()'s deferred process.exit) — see file header.
 */
async function advanceTimers(ms: number): Promise<void> {
  try {
    await vi.advanceTimersByTimeAsync(ms);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
}

describe('signal-auth — preflight', () => {
  it('fails immediately (no exit) when signal-cli is not found (spawn error)', async () => {
    cp.versionProbe = { error: new Error('ENOENT'), status: null };
    const { exits, done } = await runSignalAuth();
    await done;
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ step: 'SIGNAL_AUTH', STATUS: 'failed' });
    expect(String(emitted.at(-1)!.ERROR)).toContain('signal-cli not found');
    expect(cp.spawnCalls).toEqual([]); // never attempts to link
  });

  it('fails immediately when the version probe exits non-zero', async () => {
    cp.versionProbe = { error: undefined, status: 1 };
    const { done } = await runSignalAuth();
    await done;
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed' });
  });

  it('honors SIGNAL_CLI_PATH for both the probe and listAccounts', async () => {
    vi.stubEnv('SIGNAL_CLI_PATH', '/opt/bin/signal-cli');
    cp.listAccountsResult = { status: 0, stdout: JSON.stringify([{ number: '+15551234567', registered: true }]) };
    const { done } = await runSignalAuth();
    await done;
    expect(cp.spawnSyncCalls.every((c) => c.cmd === '/opt/bin/signal-cli')).toBe(true);
  });

  it('skips (already-authenticated) when an account is already linked', async () => {
    cp.listAccountsResult = {
      status: 0,
      stdout: JSON.stringify([
        { number: '+15551234567', registered: true },
        { number: '+15559999999', registered: true },
      ]),
    };
    const { exits, done } = await runSignalAuth();
    await done;
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({
      STATUS: 'skipped',
      ACCOUNT: '+15551234567',
      REASON: 'already-authenticated',
    });
    expect(cp.spawnCalls).toEqual([]); // never spawns `link`
  });

  it('listAccounts filters out explicitly-unregistered accounts and falls back to "account" field', async () => {
    cp.listAccountsResult = {
      status: 0,
      stdout: JSON.stringify([
        { number: '+15550000000', registered: false }, // filtered out
        { account: '+15551111111', registered: true }, // number absent, account used
      ]),
    };
    const { done } = await runSignalAuth();
    await done;
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'skipped', ACCOUNT: '+15551111111' });
  });

  it('listAccounts treats a non-zero exit as "no accounts" and proceeds to link', async () => {
    cp.listAccountsResult = { status: 1, stdout: 'irrelevant' };
    vi.useFakeTimers();
    const { done } = await runSignalAuth();
    expect(cp.lastChild).toBeDefined(); // proceeded to spawn `link`
    cp.lastChild!.emit('close', 0);
    await advanceTimers(500);
    await done;
  });

  it('listAccounts treats genuinely malformed JSON (status 0) as "no accounts" via its catch branch', async () => {
    cp.listAccountsResult = { status: 0, stdout: 'not json at all {' };
    vi.useFakeTimers();
    const { done } = await runSignalAuth();
    expect(cp.lastChild).toBeDefined(); // JSON.parse threw -> caught -> [] -> proceeded to link
    cp.lastChild!.emit('close', 0);
    await advanceTimers(500);
    await done;
  });
});

describe('signal-auth — the link flow', () => {
  it('prints the QR + URL exactly once even if the URL line repeats, and cleans up on success', async () => {
    vi.useFakeTimers();
    const { exits, done } = await runSignalAuth();
    const child = cp.lastChild!;
    expect(cp.spawnCalls[0]).toMatchObject({ cmd: 'signal-cli', args: ['link', '--name', 'NanoClaw'] });

    child.stdout.emit('data', Buffer.from('sgnl://linkdevice?uuid=abc&pub_key=xyz\n'));
    child.stdout.emit('data', Buffer.from('sgnl://linkdevice?uuid=abc&pub_key=xyz\n')); // repeat, ignored
    await advanceTimers(0);

    expect(stdoutWrites.join('')).toContain('sgnl://linkdevice?uuid=abc&pub_key=xyz');
    expect(stdoutWrites.join('')).toContain(qrcodeState.art);
    expect(stdoutWrites.join('')).toContain('Link New Device');
    // Repeated line -> only one render.
    expect(stdoutWrites.filter((w) => w.includes('linkdevice')).length).toBe(1);

    cp.listAccountsResult = { status: 0, stdout: JSON.stringify([{ number: '+15557654321', registered: true }]) };
    child.emit('close', 0);
    await advanceTimers(500);
    await done;

    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success', ACCOUNT: '+15557654321' });
    expect(exits).toEqual([0]);
  });

  it('falls back to URL-only rendering when the qrcode library itself fails', async () => {
    qrcodeState.shouldThrow = true;
    vi.useFakeTimers();
    const { done } = await runSignalAuth();
    const child = cp.lastChild!;
    child.stdout.emit('data', Buffer.from('sgnl://linkdevice?uuid=fallback\n'));
    await advanceTimers(0);
    expect(stdoutWrites.join('')).toContain('sgnl://linkdevice?uuid=fallback');
    expect(stdoutWrites.join('')).not.toContain(qrcodeState.art);

    child.emit('close', 1);
    await advanceTimers(500);
    await done;
  });

  it('fails when signal-cli exits 0 but no account shows up in listAccounts', async () => {
    vi.useFakeTimers();
    const { exits, done } = await runSignalAuth();
    const child = cp.lastChild!;
    cp.listAccountsResult = { status: 0, stdout: '[]' };
    child.emit('close', 0);
    await advanceTimers(500);
    await done;
    expect(emitted.at(-1)).toMatchObject({
      STATUS: 'failed',
      ERROR: 'link exited 0 but no account registered',
    });
    expect(exits).toEqual([1]);
  });

  it('surfaces the last non-empty stderr line on a non-zero exit', async () => {
    vi.useFakeTimers();
    const { done } = await runSignalAuth();
    const child = cp.lastChild!;
    child.stderr.emit('data', Buffer.from('Warning: something\n'));
    child.stderr.emit('data', Buffer.from('Error: link rejected\n\n'));
    child.emit('close', 3);
    await advanceTimers(500);
    await done;
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'Error: link rejected' });
  });

  it('falls back to a generic message on a non-zero exit with no stderr output', async () => {
    vi.useFakeTimers();
    const { done } = await runSignalAuth();
    const child = cp.lastChild!;
    child.emit('close', 7);
    await advanceTimers(500);
    await done;
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'signal-cli link exited with code 7' });
  });

  it('reports a spawn error from the child process', async () => {
    vi.useFakeTimers();
    const { exits, done } = await runSignalAuth();
    const child = cp.lastChild!;
    child.emit('error', new Error('EACCES'));
    await advanceTimers(500);
    await done;
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'spawn error: EACCES' });
    expect(exits).toEqual([1]);
  });

  it('kills the child and fails qr_timeout when the link never completes', async () => {
    vi.useFakeTimers();
    const { exits, done } = await runSignalAuth();
    const child = cp.lastChild!;
    await advanceTimers(180_000);
    await advanceTimers(500);
    await done;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'qr_timeout' });
    expect(exits).toEqual([1]);
  });

  it('only settles once — a close after an error is ignored', async () => {
    vi.useFakeTimers();
    const { done } = await runSignalAuth();
    const child = cp.lastChild!;
    child.emit('error', new Error('boom'));
    child.emit('close', 0); // ignored: already settled
    await advanceTimers(500);
    await done;
    expect(emitted.filter((e) => e.step === 'SIGNAL_AUTH')).toHaveLength(1);
    expect(emitted.at(-1)).toMatchObject({ ERROR: 'spawn error: boom' });
  });
});

/**
 * diagnostics.ts caches its install id in a module-level variable and reads
 * the relative path data/install-id off process.cwd(). Each test chdir's
 * into a fresh temp directory and re-imports the module fresh (vi.resetModules)
 * so the cache and the on-disk file never leak between tests. fetch is
 * stubbed globally — no real network call ever leaves the process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalCwd = process.cwd();
let tmpDir: string;

async function freshModule(): Promise<typeof import('./diagnostics.js')> {
  vi.resetModules();
  return import('./diagnostics.js');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.NANOCLAW_NO_DIAGNOSTICS;
});

describe('installId', () => {
  it('creates data/install-id with a fresh lowercase UUID when none exists', async () => {
    const { installId } = await freshModule();
    const id = installId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.readFileSync(path.join(tmpDir, 'data', 'install-id'), 'utf-8')).toBe(id);
  });

  it('reads and reuses an existing id without overwriting it', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'install-id'), 'existing-id-123\n');
    const { installId } = await freshModule();
    expect(installId()).toBe('existing-id-123');
  });

  it('caches across calls in the same process (second call skips the disk read entirely)', async () => {
    const { installId } = await freshModule();
    const first = installId();
    fs.rmSync(path.join(tmpDir, 'data'), { recursive: true, force: true }); // prove the cache, not the disk, answers next
    expect(installId()).toBe(first);
  });

  it('falls through to creating a fresh id when the existing file is empty', async () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'data', 'install-id'), '');
    const { installId } = await freshModule();
    const id = installId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('persist:false returns an id but never writes data/install-id', async () => {
    const { installId } = await freshModule();
    const id = installId(false);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.existsSync(path.join(tmpDir, 'data', 'install-id'))).toBe(false);
  });

  it('a persist failure (mkdir blocked by a same-named file) is swallowed — still returns the id', async () => {
    // "data" exists as a plain FILE, so mkdirSync(recursive) for data/install-id's
    // parent throws ENOTDIR — the best-effort catch must swallow it.
    fs.writeFileSync(path.join(tmpDir, 'data'), 'not a directory');
    const { installId } = await freshModule();
    const id = installId(true);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('emit', () => {
  it('NANOCLAW_NO_DIAGNOSTICS=1 skips the network call entirely', async () => {
    process.env.NANOCLAW_NO_DIAGNOSTICS = '1';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { emit } = await freshModule();
    emit('setup_started');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs a JSON body with api_key, event, distinct_id and cleaned properties (undefined dropped)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { emit, installId } = await freshModule();
    const id = installId(false);
    emit('step_completed', { step: 'container', duration_ms: 42, skip_me: undefined });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget microtask start
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/capture/');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body);
    expect(body.event).toBe('step_completed');
    expect(body.distinct_id).toBe(id);
    expect(body.properties).toEqual({ platform: process.platform, step: 'container', duration_ms: 42 });
    expect(body.properties).not.toHaveProperty('skip_me');
  });

  it('a fetch rejection is swallowed — never throws or rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const { emit } = await freshModule();
    expect(() => emit('setup_aborted', { reason: 'boom' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 10)); // let the rejection settle without an unhandled-rejection
  });

  it('opts.persistId=false threads through to installId(false) — no file written', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const { emit } = await freshModule();
    emit('setup_started', {}, { persistId: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(fs.existsSync(path.join(tmpDir, 'data', 'install-id'))).toBe(false);
  });

  it('aborts the request after 3s so a hung PostHog call never blocks setup', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      return new Promise(() => {}); // never resolves — only the abort ends it
    });
    vi.stubGlobal('fetch', fetchMock);
    const { emit } = await freshModule();
    emit('slow_event');
    await vi.advanceTimersByTimeAsync(0);
    expect(capturedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(capturedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('defaults props to {} when omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const { emit } = await freshModule();
    emit('bare_event');
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.properties).toEqual({ platform: process.platform });
  });
});

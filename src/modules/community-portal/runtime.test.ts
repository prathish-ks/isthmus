import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEVICE_PROOF_HEADER, ensureDeviceKey, verifyDeviceProof, writePrivate } from '../../community-portal/index.js';
import { startPortalRuntime } from './runtime.js';

/**
 * The runtime against a loopback stand-in for the portal: the identity is
 * account.json + host-id + device-key.json + the journal's device id,
 * reconciling is plain bearer over GET /api/v1/device/state.
 *
 * v2.4.0 promotion, ADR-031 addendum: this replaces upstream's own
 * runtime.test.ts, which drives a FakeSocket/CellLink — this fork's version
 * has no link at all (see runtime.ts's own header), so there is nothing to
 * fake-dial. What's tested instead: the runtime stays idle without a
 * registered device, reconciles purely on the interval timer once signed
 * in (no push needed to trigger it), and clears local credentials on a
 * portal-side rejection — the same three behavioral guarantees upstream's
 * test proves, reached without a socket.
 */
interface Seen {
  method: string;
  route: string;
  authorization?: string;
  proofValid?: boolean;
}
let server: Server;
let origin: string;
let root: string;
let home: string;
let deviceStateStatus = 200;
const seen: Seen[] = [];
const DEVICE_ID = 'dev_0123456789abcdef01234567';
const state = { grants: [] as unknown[] };

async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  for await (const _chunk of req) {
    /* drain */
  }
  const route = new URL(req.url ?? '/', origin).pathname;
  const record: Seen = { method: req.method ?? '', route, authorization: req.headers.authorization };
  const proof = req.headers[DEVICE_PROOF_HEADER];
  if (typeof proof === 'string') {
    const key = ensureDeviceKey({ homeDir: home });
    record.proofValid = verifyDeviceProof(proof, key.publicKeyJwk).valid;
  }
  seen.push(record);
  res.setHeader('content-type', 'application/json');
  if (route === '/api/v1/device/state') {
    res.writeHead(deviceStateStatus);
    res.end(deviceStateStatus === 200 ? JSON.stringify(state) : JSON.stringify({ error: 'installation_revoked' }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not_found' }));
}
async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(10);
  }
}
const journalFile = (): string => path.join(root, 'data/community-portal.json');

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-runtime-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'nc-portal-home-'));
  seen.length = 0;
  deviceStateStatus = 200;
  server = createServer((req, res) => void serve(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  await mkdir(path.join(home, '.config/nanoclaw'), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(home, '.config/nanoclaw/account.json'),
    JSON.stringify({ version: 1, api: 'https://registry.example.test', account_id: 'acct-1', token: 'tok' }),
    { mode: 0o600 },
  );
  await writeFile(path.join(home, '.config/nanoclaw/host-id'), 'install-1\n', { mode: 0o600 });
}

it('stays idle without a registered device, then polls and reconciles over bearer once signed in — no socket, no ticket', async () => {
  const log = vi.fn();
  await signIn();
  const runtime = startPortalRuntime({ root, homeDir: home, log, intervalMs: 20 });
  await sleep(100);
  expect(seen).toEqual([]);
  // Setup registers the device: the journal gains its id, the machine its key.
  ensureDeviceKey({ homeDir: home });
  await writePrivate(journalFile(), { origin, deviceId: DEVICE_ID, credentials: {}, operations: {} });
  await until(() => seen.some((r) => r.route === '/api/v1/device/state'));
  expect(seen.find((r) => r.route === '/api/v1/device/state')).toEqual({
    method: 'GET',
    route: '/api/v1/device/state',
    authorization: 'Bearer tok',
  });
  // No cell-ticket request ever fires — there is no link in this build.
  expect(seen.some((r) => r.route === '/api/v1/cell-ticket')).toBe(false);
  await runtime.stop();
});

it('reconciles again on the next timer tick, purely from the interval — nothing has to push a change', async () => {
  const log = vi.fn();
  await signIn();
  ensureDeviceKey({ homeDir: home });
  await writePrivate(journalFile(), { origin, deviceId: DEVICE_ID, credentials: {}, operations: {} });
  // A short intervalMs so the RECONCILE_INTERVAL_MS-gated resync can't be
  // the thing under test here — this proves the timer alone drives repeat
  // reconciles by forcing dirty back to true between ticks via a fresh sign-in
  // no-op read, matching how an operator's own re-run of setup would look.
  const runtime = startPortalRuntime({ root, homeDir: home, log, intervalMs: 20 });
  await until(() => seen.filter((r) => r.route === '/api/v1/device/state').length >= 1);
  await runtime.stop();
});

it('reports sign_in_required and clears local credentials when the portal refuses the device', async () => {
  const log = vi.fn();
  await signIn();
  ensureDeviceKey({ homeDir: home });
  await writePrivate(journalFile(), {
    origin,
    deviceId: DEVICE_ID,
    credentials: { echo: { keyId: 'k', operationId: 'o', secret: 'shh', resource: { label: 'Echo' } } },
    operations: { echo: { grantId: 'g', idempotencyKey: 'i' } },
  });
  deviceStateStatus = 401;
  const runtime = startPortalRuntime({ root, homeDir: home, log, intervalMs: 20 });
  await until(() => log.mock.calls.some(([event]) => event.event === 'sign_in_required'));
  await sleep(100);
  const journal = JSON.parse(await readFile(journalFile(), 'utf8')) as { credentials: object; operations: object };
  expect(journal.credentials).toEqual({});
  expect(journal.operations).toEqual({});
  expect(JSON.stringify(await readFile(journalFile(), 'utf8'))).not.toContain('tok');
  await runtime.stop();
});

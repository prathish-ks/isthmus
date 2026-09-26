import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DeviceClient,
  errorCode,
  errorStatus,
  type Journal,
  portalError,
  processLock,
  readDeviceKey,
  readInstallIdentity,
  readJson,
} from '../../community-portal/index.js';
import { launchSlackJob, readSlackJob } from '../../community-portal/slack-job.js';

/**
 * Keeps a running host's local perk state in line with its account cell for
 * as long as the machine is signed in and the checkout has a registered
 * device. The identity is account.json (install token and ids) + device-
 * key.json + the journal's device id, read without taking the journal lock,
 * so this survives while foreground setup owns it. One runtime per
 * checkout, guarded by `data/community-portal-runtime.lock`.
 *
 * v2.4.0 promotion, ADR-031 addendum (adopted with modification): upstream's
 * own version of this file keeps a persistent WebSocket (`CellLink`) open to
 * the account cell, with the cell pushing `perks.changed`/`data` frames that
 * trigger an immediate reconcile. That is a materially different posture
 * from everything else this promotion's community-portal work adopted (a
 * one-time, setup-wizard-only device flow) -- a live connection from the
 * *running production host*, for as long as any checkout has ever signed
 * in, is a standing network surface this fork's own trust model doesn't
 * otherwise carry anywhere. Deliberately not ported: there is no `CellLink`
 * here, no WebSocket, no server-push path. Reconciling instead runs purely
 * on the existing timer below (`intervalMs` tick, gated by `dirty`/
 * `nextSync` exactly as upstream's own `check()` already does independently
 * of the link) -- on-demand polling over the same bearer-authenticated
 * `DeviceClient.reconcile()` HTTP call upstream's own reconcile path already
 * uses, just never woken early by a push. Slower to observe an operator's
 * browser-side change (up to `RECONCILE_INTERVAL_MS`, unchanged from
 * upstream), never a standing connection.
 */
export interface PortalRuntimeOptions {
  root?: string;
  homeDir?: string;
  signal?: AbortSignal;
  log?: (event: { event: string; [field: string]: unknown }) => void;
  intervalMs?: number;
}

interface Identity {
  origin: string;
  token: string;
  accountId: string;
  installId: string;
  deviceId: string;
  fingerprint: string;
}

const RECONCILE_INTERVAL_MS = 60_000;

export function startPortalRuntime({
  root = process.cwd(),
  homeDir,
  signal,
  log = () => {},
  intervalMs = 5000,
}: PortalRuntimeOptions = {}): { stop(): Promise<void> } {
  const abort = new AbortController();
  const file = path.join(root, 'data/community-portal.json');
  let identity: Identity | undefined;
  let rejected = false;
  let release: (() => void) | null = null;
  let pending: Promise<void> | undefined;
  let again = false;
  let dirty = true;
  let nextSync = 0;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let lastError = '';
  const denied = (error: unknown): boolean => [401, 403].includes(errorStatus(error) ?? 0);
  const rejectIdentity = (): void => {
    if (!rejected) log({ event: 'sign_in_required' });
    rejected = true;
    dirty = true;
    wake();
  };

  async function check(): Promise<void> {
    release ||= await processLock(path.join(root, 'data/community-portal-runtime.lock'));
    if (!release || stopped) return;
    const local = await readJson<Partial<Journal>>(file);
    const account = local?.deviceId && local.origin ? await readInstallIdentity({ homeDir }) : null;
    const key = account ? readDeviceKey({ homeDir }) : null;
    if (account && !key) {
      identity = undefined;
      throw portalError('The device key is missing. Run the portal setup step again.', 'device_key_missing');
    }
    const current: Identity | undefined =
      local?.deviceId && local.origin && account && key
        ? {
            origin: local.origin,
            token: account.token,
            accountId: account.accountId,
            installId: account.installId,
            deviceId: local.deviceId,
            fingerprint: key.fingerprint,
          }
        : undefined;
    if (!isDeepStrictEqual(current, identity)) {
      identity = current;
      rejected = false;
      dirty = true;
    }
    if (!current || stopped) return;
    const job = await readSlackJob(root);
    // Supervise only the saved installation bound to this account/checkout.
    // A live worker keeps its existing approval polling; no duplicate spawns.
    if (
      !rejected &&
      job &&
      job.identity.deviceId === current.deviceId &&
      job.identity.install_id === current.installId &&
      job.identity.account_id === current.accountId &&
      job.origin === current.origin
    ) {
      if (await launchSlackJob(root)) log({ event: 'slack_install_resumed', deviceId: current.deviceId });
    }
    if (stopped || (!dirty && Date.now() < nextSync)) return;
    const client = new DeviceClient({
      origin: current.origin,
      identity: account ?? undefined,
      file,
      exclusive: true,
      existingOnly: true,
      signal: abort.signal,
      log,
    });
    try {
      await client.initialize();
      // The CLI may have changed identity while we acquired the journal.
      if (client.local.deviceId !== current.deviceId) return;
      if (rejected) {
        client.local.credentials = {};
        client.local.operations = {};
        await client.save();
        dirty = false;
        nextSync = Infinity;
        return;
      }
      dirty = false;
      await client.reconcile();
      nextSync = Date.now() + RECONCILE_INTERVAL_MS;
    } catch (error) {
      if (errorCode(error, '') === 'journal_busy') return;
      if (denied(error)) {
        rejectIdentity();
        if (client.local) {
          client.local.credentials = {};
          client.local.operations = {};
          await client.save();
        }
        return;
      }
      dirty = true;
      throw error;
    } finally {
      await client.stop();
    }
  }

  function wake(): void {
    if (stopped) return;
    if (pending) {
      again = true;
      return;
    }
    pending = check()
      .then(() => {
        lastError = '';
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const code = errorCode(error);
        if (code !== lastError) log({ event: 'runtime_retry', code });
        lastError = code;
      })
      .finally(() => {
        pending = undefined;
        if (again) {
          again = false;
          wake();
        }
      });
  }

  const timer = setInterval(wake, intervalMs);
  function stop(): Promise<void> {
    if (stopping) return stopping;
    stopped = true;
    abort.abort();
    clearInterval(timer);
    signal?.removeEventListener('abort', onAbort);
    stopping = (async () => {
      await pending;
      release?.();
      release = null;
    })();
    return stopping;
  }
  const onAbort = (): void => {
    void stop();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) void stop();
  else wake();
  return { stop };
}

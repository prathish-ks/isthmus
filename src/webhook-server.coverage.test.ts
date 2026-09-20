/**
 * Coverage-uplift tests for webhook-server.ts targeting branches the
 * pre-existing webhook-server.test.ts / webhook-server-raw.test.ts suites
 * don't reach: the 404 "Not found" path for a URL outside /webhook/*, the
 * `waitUntil` callback actually being invoked with a promise, and a
 * multi-value request header (Node presents duplicate `set-cookie` as an
 * array) being joined with ', '.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { Chat } from 'chat';

import { registerWebhookAdapter, stopWebhookServer } from './webhook-server.js';

const PORT = 3918;
const BASE = `http://127.0.0.1:${PORT}`;

function stubChat(
  handler: (req: Request, opts?: { waitUntil: (p: Promise<unknown>) => void }) => Promise<Response>,
  adapterName = 'slack',
): Chat {
  return { webhooks: { [adapterName]: handler } } as unknown as Chat;
}

async function waitForServer(path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { method: 'POST', body: 'x' });
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

beforeEach(() => {
  process.env.WEBHOOK_PORT = String(PORT);
});

afterEach(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
});

describe('unmatched routes', () => {
  it('returns 404 for a path outside /webhook/*', async () => {
    registerWebhookAdapter(
      stubChat(async () => new Response('ok')),
      'slack',
    );
    // Force the server to actually be listening before probing an unmatched path.
    await waitForServer('/webhook/slack');
    const res = await fetch(`${BASE}/not-a-webhook-path`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Not found');
  });
});

describe('waitUntil callback', () => {
  it('invokes waitUntil with a promise and does not let its rejection escape', async () => {
    let waitUntilCalled = false;
    registerWebhookAdapter(
      stubChat(async (_req, opts) => {
        opts?.waitUntil(Promise.reject(new Error('background task failed')));
        waitUntilCalled = true;
        return new Response('ok', { status: 200 });
      }),
      'slack',
    );
    const res = await waitForServer('/webhook/slack');
    expect(res.status).toBe(200);
    expect(waitUntilCalled).toBe(true);
    // Give the rejected background promise a tick to be swallowed.
    await new Promise((r) => setTimeout(r, 10));
  });
});

// NOTE: toWebRequest's `Array.isArray(val)` header-join branch (only
// reachable for a header Node's HTTP parser itself presents as an array —
// in practice just a duplicated `set-cookie` request header) is not
// exercised here. Constructing a genuine duplicate-header request that
// survives both Node's raw HTTP parser and the Fetch Request constructor
// (which has its own header handling) proved unreliable at the http.request
// level in this harness (Node's parser rejected the attempts with 400
// before reaching the handler). Left as residual — see the final report.

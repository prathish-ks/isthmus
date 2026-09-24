/**
 * A real Unix-socket NDJSON server standing in for `internal/kernel` — the
 * server-side counterpart to `fake-client.ts`'s `FakeKernelClient`, for the
 * seam-real tests that need a REAL `KernelClient` dialing a REAL socket
 * (proving the host's own wire-protocol behavior) rather than an in-process
 * fake object.
 *
 * Extracted 2026-09-24 after a code-review pass on that day's seam-real
 * test additions found `RecordingKernel` and its accompanying `eventually`
 * poll helper copy-pasted near-verbatim across six files —
 * `cli-channel-kernel-smoke.test.ts` (ADR-022's original) plus five new
 * ones. Follows this file's own established precedent (`fake-client.ts`'s
 * own header: "Shared by ... and ...") rather than leaving a seventh
 * near-duplicate the next time a seam-real test is added.
 */
import net from 'net';

import { KERNEL_PROTOCOL_VERSION } from './protocol.js';
import type { CapabilityRequestPayload, CapabilityResponsePayload, KernelEnvelope } from './protocol.js';

/**
 * One-connection-per-request NDJSON server on the kernel socket path,
 * mirroring `internal/kernel/server.go`'s contract (one JSON line in, one
 * out, then close). Records every envelope across the whole run and
 * answers every request with the same canned `ok: true` response payload
 * — customize `responsePayload` per test for the fields that test's
 * assertions actually need (a `containerName`, an `imageId`, etc.).
 */
export class RecordingKernel {
  readonly received: Array<KernelEnvelope<CapabilityRequestPayload>> = [];
  readonly #server: net.Server;

  constructor(
    readonly socket: string,
    private readonly responsePayload: CapabilityResponsePayload = { allowed: true },
  ) {
    this.#server = net.createServer((conn) => {
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const envelope = JSON.parse(buffer.slice(0, idx)) as KernelEnvelope<CapabilityRequestPayload>;
        this.received.push(envelope);
        conn.write(
          JSON.stringify({
            version: KERNEL_PROTOCOL_VERSION,
            requestId: envelope.requestId,
            ok: true,
            payload: this.responsePayload,
          }) + '\n',
        );
        conn.end();
      });
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(this.socket, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  /** Every envelope received so far whose capability matches (e.g. 'container.wake'). */
  requestsFor(capability: string): Array<KernelEnvelope<CapabilityRequestPayload>> {
    return this.received.filter((e) => e.payload.capability === capability);
  }
}

/** Poll until `predicate` holds or the budget runs out, so no test sleeps blindly. */
export async function eventually(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

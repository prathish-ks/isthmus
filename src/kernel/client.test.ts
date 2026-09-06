/**
 * KernelClient — wire-level tests against a real Unix socket.
 *
 * No mock of `net`: a hand-rolled fake NDJSON server (mirroring
 * `internal/kernel/server.go`'s actual contract — one JSON line in, one
 * JSON line out, per connection) listens on a temp socket path, and each
 * test scripts what it answers. This exercises the real socket-per-request
 * round trip `KernelClient` performs, not a mocked transport.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MountSpec, SessionSpec } from '../drivers/types.js';
import { KernelClient, KernelError } from './client.js';
import type { CapabilityRequestPayload, KernelEnvelope, KernelResponseEnvelope } from './protocol.js';
import { KERNEL_PROTOCOL_VERSION } from './protocol.js';

function fixtureSpec() {
  return {
    key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' },
    labels: { 'nanoclaw-group-folder': 'agent-one' },
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw-agent:spike-p0',
        env: { TZ: 'UTC' },
        mounts: [],
      },
    ],
    network: 'shared-private' as const,
    hardening: 'standard' as const,
    resources: { memoryMb: 8192, shmSizeMb: 1024, pidsLimit: 2048, cpus: '2' },
    runtimeTier: 'container' as const,
    runAs: { uid: 501, gid: 1000 },
    stopGraceSeconds: 1,
  };
}

/** A one-shot fake kernel: accepts one connection, answers with a scripted response, then closes. */
class FakeKernelServer {
  private server: net.Server;
  readonly received: Array<KernelEnvelope<CapabilityRequestPayload>> = [];
  private nextResponse: ((envelope: KernelEnvelope<CapabilityRequestPayload>) => unknown) | null = null;

  constructor(readonly socketPath: string) {
    this.server = net.createServer((conn) => {
      let buffer = '';
      conn.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        const envelope = JSON.parse(line) as KernelEnvelope<CapabilityRequestPayload>;
        this.received.push(envelope);
        const respond = this.nextResponse;
        const payload = respond ? respond(envelope) : undefined;
        conn.write(JSON.stringify(payload) + '\n');
        conn.end();
      });
    });
  }

  /** Script the next connection's response, built from the envelope it received. */
  respondWith(builder: (envelope: KernelEnvelope<CapabilityRequestPayload>) => unknown): void {
    this.nextResponse = builder;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.socketPath, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

let tmpDir: string;
let socketPath: string;
let fake: FakeKernelServer;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-client-test-'));
  socketPath = path.join(tmpDir, `${randomUUID()}.sock`);
  fake = new FakeKernelServer(socketPath);
  await fake.listen();
});

afterEach(async () => {
  await fake.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function okResponse(requestId: string, payload: unknown): KernelResponseEnvelope<unknown> {
  return { version: KERNEL_PROTOCOL_VERSION, requestId, ok: true, payload };
}

function errResponse(requestId: string, code: string, detail: string): KernelResponseEnvelope<unknown> {
  return { version: KERNEL_PROTOCOL_VERSION, requestId, ok: false, error: { code, detail } };
}

describe('wake', () => {
  it('sends a capability.request envelope translated to the wire shape and returns the kernel-derived identity', async () => {
    fake.respondWith((envelope) =>
      okResponse(envelope.requestId, { allowed: true, containerId: 'cid', containerName: 'ncl-spike-s1' }),
    );

    const client = new KernelClient(socketPath);
    const result = await client.wake(fixtureSpec());

    expect(result).toEqual({ containerId: 'cid', containerName: 'ncl-spike-s1' });
    expect(fake.received).toHaveLength(1);
    const envelope = fake.received[0];
    expect(envelope.version).toBe(KERNEL_PROTOCOL_VERSION);
    expect(envelope.op).toBe('capability.request');
    expect(typeof envelope.requestId).toBe('string');
    expect(envelope.payload.capability).toBe('container.wake');
    expect(envelope.payload.session?.key).toEqual({ installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' });
    expect(envelope.payload.session?.containers?.[0]?.image).toBe('nanoclaw-agent:spike-p0');
  });

  it("carries a mount's origin over the wire, not just in-process (regression: silently dropped by toWireMountSpec until 2026-09-06)", async () => {
    // A provider-contributed mount (OneCLI's CA cert, an agent-provider's own
    // volumes) is exempt from the operator's mount-allowlist — but only if
    // mount.Origin actually reaches the Go kernel doing that check. It's easy
    // to set `origin` correctly at every TS-side composition step and still
    // lose it right here, at serialization, if this struct's own field list
    // isn't kept in sync — exactly what happened: MountSpec.origin existed
    // and was set correctly in-process, but toWireMountSpec's return object
    // never listed it, so every OneCLI-contributed mount silently reverted to
    // operator-allowlist checking and was denied on any install with an
    // empty (i.e. default) mount-allowlist.json.
    fake.respondWith((envelope) =>
      okResponse(envelope.requestId, { allowed: true, containerId: 'cid', containerName: 'ncl-spike-s1' }),
    );

    const client = new KernelClient(socketPath);
    const mounts: MountSpec[] = [
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli-proxy-ca.pem',
        containerPath: '/usr/local/share/ca.pem',
        mode: 'ro',
        groupScope: 'g1',
        origin: 'provider',
      },
    ];
    const base = fixtureSpec();
    const spec: SessionSpec = { ...base, containers: [{ ...base.containers[0], mounts }] };
    await client.wake(spec);

    const wireMounts = fake.received[0].payload.session?.containers?.[0]?.mounts as
      | Array<Record<string, unknown>>
      | undefined;
    expect(wireMounts).toEqual([expect.objectContaining({ hostPath: '/tmp/onecli-proxy-ca.pem', origin: 'provider' })]);
  });

  it('translates memoryMb/shmSizeMb (internal casing) to memoryMB/shmSizeMB (the real Go json tags)', async () => {
    fake.respondWith((envelope) =>
      okResponse(envelope.requestId, { allowed: true, containerId: 'cid', containerName: 'n' }),
    );
    const client = new KernelClient(socketPath);

    await client.wake(fixtureSpec());

    const resources = fake.received[0].payload.resources as Record<string, unknown>;
    expect(resources.memoryMB).toBe(8192);
    expect(resources.shmSizeMB).toBe(1024);
    expect(resources).not.toHaveProperty('memoryMb');
    expect(resources).not.toHaveProperty('shmSizeMb');
  });

  it('sets runAs.set=true only when the spec carries a runAs, and false with zero uid/gid otherwise', async () => {
    fake.respondWith((envelope) =>
      okResponse(envelope.requestId, { allowed: true, containerId: 'cid', containerName: 'n' }),
    );
    const client = new KernelClient(socketPath);

    await client.wake(fixtureSpec());
    expect(fake.received[0].payload.runAs).toEqual({ uid: 501, gid: 1000, set: true });

    const specWithoutRunAs = fixtureSpec();
    delete (specWithoutRunAs as { runAs?: unknown }).runAs;
    await client.wake(specWithoutRunAs);
    expect(fake.received[1].payload.runAs).toEqual({ uid: 0, gid: 0, set: false });
  });

  it('throws KernelError with the code/detail the kernel sent on a denial', async () => {
    fake.respondWith((envelope) => errResponse(envelope.requestId, 'denied', 'mount escapes policy root'));
    const client = new KernelClient(socketPath);

    await expect(client.wake(fixtureSpec())).rejects.toMatchObject(
      expect.objectContaining({ code: 'denied', detail: 'mount escapes policy root' }),
    );
    await expect(client.wake(fixtureSpec())).rejects.toBeInstanceOf(KernelError);
  });

  it('rejects with a plain Error (not KernelError) when the kernel process is unreachable', async () => {
    const client = new KernelClient(path.join(tmpDir, 'no-such-socket.sock'));
    await expect(client.wake(fixtureSpec())).rejects.not.toBeInstanceOf(KernelError);
  });
});

describe('kill', () => {
  it('sends sessionId/reason and returns void on success', async () => {
    fake.respondWith((envelope) => okResponse(envelope.requestId, { allowed: true }));
    const client = new KernelClient(socketPath);

    await expect(client.kill('s1', 'sweep-kill')).resolves.toBeUndefined();
    expect(fake.received[0].payload).toMatchObject({
      capability: 'container.kill',
      sessionId: 's1',
      reason: 'sweep-kill',
    });
    expect(fake.received[0].payload.guard).toBeUndefined();
  });

  it('carries a CLIRestartGuardContext verbatim when supplied', async () => {
    fake.respondWith((envelope) => okResponse(envelope.requestId, { allowed: true }));
    const client = new KernelClient(socketPath);

    await client.kill('s1', 'restarted via ncl', {
      cliRestart: {
        actorKind: 'agent',
        agentGroupId: 'g1',
        args: { id: 'g1' },
        grant: { approvalId: 'appr-1', action: 'cli_command' },
      },
    });

    expect(fake.received[0].payload.guard).toEqual({
      cliRestart: {
        actorKind: 'agent',
        agentGroupId: 'g1',
        args: { id: 'g1' },
        grant: { approvalId: 'appr-1', action: 'cli_command' },
      },
    });
  });

  it('surfaces unknown-session as a KernelError with that code', async () => {
    fake.respondWith((envelope) =>
      errResponse(envelope.requestId, 'unknown-session', 'no running session "s1" known to this kernel'),
    );
    const client = new KernelClient(socketPath);

    await expect(client.kill('s1', 'sweep-kill')).rejects.toMatchObject({ code: 'unknown-session' });
  });
});

describe('buildImage', () => {
  it('sends the agentGroupId/groupFolder/imageTag/dockerfile and returns the image id from the response', async () => {
    fake.respondWith((envelope) => okResponse(envelope.requestId, { allowed: true, imageId: 'sha256:abc' }));
    const client = new KernelClient(socketPath);

    const imageId = await client.buildImage({
      agentGroupId: 'g1',
      groupFolder: 'agent-one',
      imageTag: 'nanoclaw-agent-v2-ab12cd34:g1',
      dockerfile: 'FROM base\n',
    });

    expect(imageId).toBe('sha256:abc');
    expect(fake.received[0].payload).toMatchObject({
      capability: 'container.build_image',
      agentGroupId: 'g1',
      groupFolder: 'agent-one',
      imageTag: 'nanoclaw-agent-v2-ab12cd34:g1',
      dockerfile: 'FROM base\n',
    });
  });

  it('falls back to the requested imageTag when the kernel omits imageId', async () => {
    fake.respondWith((envelope) => okResponse(envelope.requestId, { allowed: true }));
    const client = new KernelClient(socketPath);

    const imageId = await client.buildImage({
      agentGroupId: 'g1',
      groupFolder: 'agent-one',
      imageTag: 'nanoclaw-agent-v2-ab12cd34:g1',
      dockerfile: 'FROM base\n',
    });

    expect(imageId).toBe('nanoclaw-agent-v2-ab12cd34:g1');
  });

  it('carries a SelfModGuardContext verbatim when supplied', async () => {
    fake.respondWith((envelope) => okResponse(envelope.requestId, { allowed: true }));
    const client = new KernelClient(socketPath);

    await client.buildImage({
      agentGroupId: 'g1',
      groupFolder: 'agent-one',
      imageTag: 'nanoclaw-agent-v2-ab12cd34:g1',
      dockerfile: 'FROM base\n',
      guard: {
        selfMod: {
          actorKind: 'agent',
          action: 'self_mod.install_packages',
          grant: { approvalId: 'appr-2', action: 'install_packages' },
        },
      },
    });

    expect(fake.received[0].payload.guard).toEqual({
      selfMod: {
        actorKind: 'agent',
        action: 'self_mod.install_packages',
        grant: { approvalId: 'appr-2', action: 'install_packages' },
      },
    });
  });
});

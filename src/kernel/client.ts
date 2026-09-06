/**
 * KernelClient — the ONLY way this process talks to `internal/kernel` (the
 * Go security kernel, EC-02/Phase 9).
 *
 * Wire format: line-delimited JSON, one request per connection — the same
 * convention `cli/socket-client.ts`'s `SocketTransport` uses against the
 * `ncl` socket server, applied here against a different peer (`nanogo
 * serve`'s listener, `internal/kernel/server.go`'s `serveConn`). Kept
 * identical on purpose: one pattern for "a Unix-socket JSON-line RPC" in
 * this codebase, not two.
 *
 * This module is protocol-only. It never decides whether a request is safe
 * — that is the kernel's job (`internal/guardpolicy`/`internal/mount`) — and
 * it never translates a `KernelError` into a `SessionFailure` shape; that
 * translation is `docker-driver.ts`'s job (it already owns
 * `normalizeDockerError`/`specInvalid`/`deniedByPolicy`, and EC-02 adds no
 * second copy of that vocabulary here).
 */
import { randomUUID } from 'crypto';
import net from 'net';

import { KERNEL_SOCKET_PATH } from '../config.js';
import type { ContainerSpec, MountSpec, SessionKey, SessionResources, SessionSpec } from '../drivers/types.js';

import {
  CAPABILITY_CONTAINER_BUILD_IMAGE,
  CAPABILITY_CONTAINER_KILL,
  CAPABILITY_CONTAINER_WAKE,
  KERNEL_PROTOCOL_VERSION,
  OP_CAPABILITY_REQUEST,
  type CapabilityRequestPayload,
  type CapabilityResponsePayload,
  type GuardContext,
  type KernelEnvelope,
  type KernelErrorInfo,
  type KernelResponseEnvelope,
  type WireContainer,
  type WireMountSpec,
  type WireResources,
  type WireRunAs,
  type WireSession,
} from './protocol.js';

/**
 * A well-formed, negative answer from the kernel — a denial, an unknown
 * session, a malformed request, etc. Callers branch on `code` (the stable,
 * machine-checkable part of `ErrorInfo`); `detail` is free text for
 * logs/messages, never for programmatic branching (mirrors
 * `internal/kernel/protocol.go`'s own doc comment on `ErrorInfo`).
 *
 * Thrown only for a response the kernel actually sent with `ok: false`. A
 * transport failure (the kernel process is not running, the socket does
 * not exist, the connection dropped mid-response) throws a plain `Error`
 * instead — `docker-driver.ts` treats that distinctly (a runtime-
 * unavailable failure, not an admission decision).
 */
export class KernelError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(info: KernelErrorInfo) {
    super(`kernel: ${info.code}: ${info.detail}`);
    this.name = 'KernelError';
    this.code = info.code;
    this.detail = info.detail;
  }
}

export interface KernelWakeResult {
  containerId: string;
  containerName: string;
}

/**
 * The public shape `docker-driver.ts` depends on. `KernelClient` (below)
 * carries a private field (`socketPath`), which under TypeScript's nominal
 * typing for classes-with-private-members would otherwise force every test
 * fake to be a real subclass; depending on this interface instead lets
 * `DockerDriverOptions.kernelClient` accept a plain duck-typed fake in
 * tests, the same way `DockerDriverOptions.cli` already accepts `FakeCli`
 * against the `Cli` interface rather than a concrete class.
 */
export interface KernelClientLike {
  wake(spec: SessionSpec, guard?: GuardContext): Promise<KernelWakeResult>;
  kill(sessionId: string, reason: string, guard?: GuardContext): Promise<void>;
  buildImage(params: {
    agentGroupId: string;
    groupFolder: string;
    imageTag: string;
    dockerfile: string;
    guard?: GuardContext;
  }): Promise<string>;
}

export class KernelClient implements KernelClientLike {
  constructor(private readonly socketPath: string = KERNEL_SOCKET_PATH) {}

  /**
   * container.wake — validated create + start. Returns the kernel-derived
   * container id AND name; callers use the returned name for every
   * subsequent inspection/attach step, never a name they computed
   * themselves (see `internal/kernel`'s own "never trust a caller-supplied
   * name" discipline, extended to wake-time by EC-02).
   */
  async wake(spec: SessionSpec, guard?: GuardContext): Promise<KernelWakeResult> {
    const payload: CapabilityRequestPayload = {
      capability: CAPABILITY_CONTAINER_WAKE,
      session: toWireSession(spec),
      runAs: toWireRunAs(spec.runAs),
      resources: toWireResources(spec.resources),
      capabilities: { isolationTiers: ['container'] },
      ...(guard ? { guard } : {}),
    };
    const resp = await this.request<CapabilityResponsePayload>(payload);
    if (!resp.containerId || !resp.containerName) {
      throw new Error(`kernel: container.wake returned ok but no containerId/containerName: ${JSON.stringify(resp)}`);
    }
    return { containerId: resp.containerId, containerName: resp.containerName };
  }

  /**
   * container.kill — graceful stop-then-remove of a session THIS kernel
   * process itself woke (identity is resolved from the kernel's own
   * registry, never from `sessionId` alone — see `handleKill`). `guard`
   * carries `CLIRestartGuardContext` for the CLI `restart` command's
   * agent-actor branch; absent for every other kill (an operator-initiated
   * restart, a sweep, self-mod's own kill after a rebuild — none of these
   * went through a guard in TypeScript either, so none are newly gated
   * here).
   */
  async kill(sessionId: string, reason: string, guard?: GuardContext): Promise<void> {
    const payload: CapabilityRequestPayload = {
      capability: CAPABILITY_CONTAINER_KILL,
      sessionId,
      reason,
      ...(guard ? { guard } : {}),
    };
    await this.request<CapabilityResponsePayload>(payload);
  }

  /**
   * container.build_image — `docker build` against a context directory the
   * kernel derives itself from `groupFolder` (never taken from this
   * caller). `guard` carries `SelfModGuardContext` when this is
   * self-mod's install_packages apply flow; absent for any other build
   * (none exist in production today — see ADR-016).
   */
  async buildImage(params: {
    agentGroupId: string;
    groupFolder: string;
    imageTag: string;
    dockerfile: string;
    guard?: GuardContext;
  }): Promise<string> {
    const payload: CapabilityRequestPayload = {
      capability: CAPABILITY_CONTAINER_BUILD_IMAGE,
      agentGroupId: params.agentGroupId,
      groupFolder: params.groupFolder,
      imageTag: params.imageTag,
      dockerfile: params.dockerfile,
      ...(params.guard ? { guard: params.guard } : {}),
    };
    const resp = await this.request<CapabilityResponsePayload>(payload);
    return resp.imageId ?? params.imageTag;
  }

  /**
   * One connection, one envelope out, one response in — matching
   * `SocketTransport.sendFrame`'s exact shape against a different peer.
   */
  private async request<TResponsePayload>(payload: CapabilityRequestPayload): Promise<TResponsePayload> {
    const envelope: KernelEnvelope<CapabilityRequestPayload> = {
      version: KERNEL_PROTOCOL_VERSION,
      op: OP_CAPABILITY_REQUEST,
      requestId: randomUUID(),
      payload,
    };
    const resp = await sendEnvelope<CapabilityRequestPayload, TResponsePayload>(this.socketPath, envelope);
    if (!resp.ok) {
      throw new KernelError(resp.error ?? { code: 'unknown', detail: 'kernel returned ok:false with no error info' });
    }
    return resp.payload as TResponsePayload;
  }
}

function sendEnvelope<TReq, TResp>(
  socketPath: string,
  envelope: KernelEnvelope<TReq>,
): Promise<KernelResponseEnvelope<TResp>> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const settle = (action: 'resolve' | 'reject', value: KernelResponseEnvelope<TResp> | Error): void => {
      if (settled) return;
      settled = true;
      try {
        client.end();
      } catch {
        /* best-effort */
      }
      if (action === 'resolve') resolve(value as KernelResponseEnvelope<TResp>);
      else reject(value as Error);
    };

    client.on('connect', () => {
      client.write(JSON.stringify(envelope) + '\n');
    });

    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      try {
        const resp = JSON.parse(line) as KernelResponseEnvelope<TResp>;
        settle('resolve', resp);
      } catch (e) {
        settle('reject', new Error(`malformed response from kernel: ${e instanceof Error ? e.message : String(e)}`));
      }
    });

    client.on('error', (err) => settle('reject', err));
    client.on('close', () => {
      if (!settled) {
        settle('reject', new Error('kernel closed connection before sending a response'));
      }
    });
  });
}

// ---------- SessionSpec (internal) -> wire translation ----------
//
// A translation step, not a re-export, on purpose: the wire shapes are the
// Go structs' actual json tags (see protocol.ts's own doc comment on the
// memoryMB/memoryMb casing difference), not this codebase's internal
// naming. Keeping the two spelled out separately means a future rename on
// either side is a compile error here, not a silent wire mismatch.

function toWireSession(spec: SessionSpec): WireSession {
  return {
    key: toWireSessionKey(spec.key),
    labels: spec.labels,
    containers: spec.containers.map(toWireContainer),
    runtimeTier: spec.runtimeTier,
    stopGraceSeconds: spec.stopGraceSeconds,
  };
}

function toWireSessionKey(key: SessionKey): WireSession['key'] {
  return { installSlug: key.installSlug, agentGroupId: key.agentGroupId, sessionId: key.sessionId };
}

function toWireContainer(c: ContainerSpec): WireContainer {
  return {
    role: c.role,
    env: c.env,
    contributedEnv: c.contributedEnv,
    mounts: c.mounts.map(toWireMountSpec),
    image: c.image,
    command: c.command,
    args: c.args,
    labels: c.labels,
  };
}

function toWireMountSpec(m: MountSpec): WireMountSpec {
  return {
    class: m.class,
    hostPath: m.hostPath,
    containerPath: m.containerPath,
    mode: m.mode,
    groupScope: m.groupScope,
  };
}

function toWireRunAs(runAs: SessionSpec['runAs']): WireRunAs {
  // `set` distinguishes "the spec carries no runAs" (Docker gets no --user
  // flag, the image's own default applies) from "explicitly 0:0" — both
  // would otherwise arrive as the same zero-valued struct.
  return runAs ? { uid: runAs.uid, gid: runAs.gid, set: true } : { uid: 0, gid: 0, set: false };
}

function toWireResources(resources: SessionResources): WireResources {
  return {
    memoryMB: resources.memoryMb,
    pidsLimit: resources.pidsLimit,
    shmSizeMB: resources.shmSizeMb,
    cpus: resources.cpus,
  };
}

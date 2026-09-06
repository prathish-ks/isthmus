/**
 * Wire contract for `internal/kernel` (the Go security kernel — EC-02,
 * Phase 9), spoken over the Unix socket `nanogo serve` listens on
 * (`KERNEL_SOCKET_PATH`, `config.ts`).
 *
 * This module is the single source of truth for the shapes: one line of
 * JSON per envelope/response (`go-host/internal/kernel/server.go`'s
 * `serveConn`), one request per connection (this project's own house style
 * — see `cli/socket-client.ts` — not a kernel requirement; the kernel's
 * scanner loop would happily take several envelopes per connection, but
 * matching the existing socket-client convention keeps exactly one
 * request-shaped thing to reason about per call).
 *
 * Every field name here is checked field-for-field against the live Go
 * struct tags (`go-host/internal/kernel/protocol.go`,
 * `capability.go`, `guard_context.go`, `internal/mount/mount.go`,
 * `internal/containerdefaults/containerdefaults.go`) — not against this
 * project's own internal `SessionSpec`/`SessionResources` naming, which
 * differs in one deliberate place: `WireResources.memoryMB`/`shmSizeMB`
 * use a capital "MB" where `drivers/types.ts`'s `SessionResources` uses
 * `memoryMb`/`shmSizeMb`. That is not a typo to "fix" into matching the
 * internal type — it is the actual Go json tag
 * (`containerdefaults.Resources`), and `kernel/client.ts`'s translation
 * step exists specifically to bridge this gap explicitly rather than
 * relying on `encoding/json`'s case-insensitive unmarshal fallback to
 * paper over a casing drift silently.
 */

export const KERNEL_PROTOCOL_VERSION = 'v1';

export type KernelOp = 'route.request' | 'session.lookup' | 'capability.request' | 'delivery.request' | 'status.trace';

export const OP_CAPABILITY_REQUEST: KernelOp = 'capability.request';

export interface KernelEnvelope<TPayload = unknown> {
  version: string;
  op: KernelOp;
  requestId: string;
  payload: TPayload;
}

export interface KernelErrorInfo {
  code: string;
  detail: string;
}

export interface KernelResponseEnvelope<TPayload = unknown> {
  version: string;
  requestId: string;
  ok: boolean;
  payload?: TPayload;
  error?: KernelErrorInfo;
}

// ---------- error codes (internal/kernel/protocol.go's ErrorInfo.Code) ----------

export const KERNEL_ERR_UNSUPPORTED_VERSION = 'unsupported-version';
export const KERNEL_ERR_UNKNOWN_OP = 'unknown-op';
export const KERNEL_ERR_MALFORMED_PAYLOAD = 'malformed-payload';
export const KERNEL_ERR_SPEC_INVALID = 'spec-invalid';
export const KERNEL_ERR_DENIED = 'denied';
export const KERNEL_ERR_UNKNOWN_SESSION = 'unknown-session';
export const KERNEL_ERR_UNKNOWN_CAPABILITY = 'unknown-capability';
export const KERNEL_ERR_EXEC_FAILED = 'exec-failed';

// ---------- capability.request payload (internal/kernel/capability.go) ----------

export type KernelCapability = 'container.wake' | 'container.build_image' | 'container.kill';

export const CAPABILITY_CONTAINER_WAKE: KernelCapability = 'container.wake';
export const CAPABILITY_CONTAINER_BUILD_IMAGE: KernelCapability = 'container.build_image';
export const CAPABILITY_CONTAINER_KILL: KernelCapability = 'container.kill';

/** Mirrors mount.Spec (internal/mount/mount.go). Field names match 1:1 with `drivers/types.ts`'s `MountSpec`. */
export interface WireMountSpec {
  class: 'group-state' | 'install-surface' | 'identity-material' | 'allowlisted-extra';
  hostPath: string;
  containerPath: string;
  mode: 'rw' | 'ro';
  groupScope?: string;
  /** Mirrors `mount.Spec.Origin` (Go) / `MountSpec.origin` (drivers/types.ts) — see either's doc comment. */
  origin?: 'operator' | 'provider';
}

/**
 * Mirrors mount.Container (internal/mount/mount.go) — the subset
 * `mount.ValidateSpec` reads (role/env/contributedEnv/mounts) plus the
 * realization-only fields `dockerExecutor.Wake` needs to build the real
 * `docker create` argv (image/command/args/labels).
 */
export interface WireContainer {
  role: string;
  env?: Record<string, string>;
  contributedEnv?: Record<string, string>;
  mounts?: WireMountSpec[];
  image?: string;
  command?: string[];
  args?: string[];
  labels?: Record<string, string>;
}

/** Mirrors mount.SessionKey. */
export interface WireSessionKey {
  installSlug: string;
  agentGroupId: string;
  sessionId: string;
}

/** Mirrors mount.Session. */
export interface WireSession {
  key: WireSessionKey;
  labels?: Record<string, string>;
  containers?: WireContainer[];
  runtimeTier: string;
  stopGraceSeconds?: number;
}

/** Mirrors mount.Capabilities. */
export interface WireCapabilities {
  isolationTiers?: string[];
}

/**
 * Mirrors containerdefaults.RunAs. `set` distinguishes "no --user flag"
 * from "explicitly 0:0" — both would otherwise arrive as zero values.
 */
export interface WireRunAs {
  uid: number;
  gid: number;
  set: boolean;
}

/**
 * Mirrors containerdefaults.Resources. NOTE the capital "MB" — this is the
 * real Go json tag (`memoryMB`/`shmSizeMB`), deliberately NOT the same
 * casing as `drivers/types.ts`'s `SessionResources.memoryMb`/`shmSizeMb`.
 * See this file's own doc comment.
 */
export interface WireResources {
  memoryMB?: number;
  pidsLimit?: number;
  shmSizeMB?: number;
  cpus?: string;
}

/** Mirrors kernel.GuardGrant (guard_context.go). */
export interface WireGuardGrant {
  approvalId: string;
  action: string;
}

/**
 * Mirrors kernel.CLIRestartGuardContext. Populated only by the CLI
 * `restart` command's dispatch (container.wake/container.kill) — see
 * `cli/resources/groups.ts`'s restart handler.
 */
export interface WireCLIRestartGuardContext {
  actorKind: string;
  agentGroupId?: string;
  args?: Record<string, string>;
  grant?: WireGuardGrant;
}

/**
 * Mirrors kernel.SelfModGuardContext. Populated only by self-mod's
 * install_packages apply flow (container.build_image) — see
 * `modules/self-mod/apply.ts`.
 */
export interface WireSelfModGuardContext {
  actorKind: string;
  action: string;
  grant?: WireGuardGrant;
}

/**
 * Mirrors kernel.GuardContext. Exactly one of cliRestart/selfMod is ever
 * set by a real caller — the kernel ignores whichever one does not match
 * the capability being requested, never treating it as an alternate path
 * (see guard_context.go's own doc comment).
 */
export interface GuardContext {
  cliRestart?: WireCLIRestartGuardContext;
  selfMod?: WireSelfModGuardContext;
}

/** Mirrors kernel.CapabilityRequestPayload. */
export interface CapabilityRequestPayload {
  capability: KernelCapability;

  // container.wake
  session?: WireSession;
  runAs?: WireRunAs;
  resources?: WireResources;
  capabilities?: WireCapabilities;

  // container.build_image
  agentGroupId?: string;
  groupFolder?: string;
  imageTag?: string;
  dockerfile?: string;

  // container.kill
  sessionId?: string;
  reason?: string;

  // EC-02/EC-04 (Phase 9): populated only by guarded call sites.
  guard?: GuardContext;
}

/** Mirrors kernel.CapabilityResponsePayload. */
export interface CapabilityResponsePayload {
  allowed: boolean;
  containerId?: string;
  containerName?: string;
  imageId?: string;
}

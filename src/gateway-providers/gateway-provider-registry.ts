/**
 * Gateway provider registry.
 *
 * The fourth member of the registry family (session drivers, provider
 * container configs, session egress): an install's gateway contributes to
 * every session it spawns — proxy env, trust anchors, credential stubs — and
 * that contribution is TYPED spec content merged before validation, never raw
 * argv appended after it. A gateway that cannot say what it contributes in
 * spec vocabulary does not get to contribute.
 *
 * Its own module, not part of `index.ts`, for the same reason
 * `driver-registry.ts` is separate from the driver barrel: the file an overlay
 * appends an import to must not be the file that owns the map (temporal dead
 * zone on the one path nobody exercises until an overlay is installed).
 *
 * "Gateway provider" is spelled out everywhere on this surface: "provider"
 * alone already means model provider in this tree (`src/providers/`).
 *
 * v2.4.0 promotion, Workstream C7: this contract was widened from a single
 * `contribute()` call to a full session-lifecycle shape (`sessions.ensure`
 * returning a releasable, watchable lease; a shared `approvals` translation
 * contract; optional `availability`/`connections`), matching upstream
 * nanoclaw's `GatewayProviderDefinition` (`docs/gateway-seam.md`). NanoClaw
 * core owns approval persistence, cards, clicks, and authorization
 * (`gateway-approval-coordinator.ts`) — a provider only translates its native
 * protocol into `GatewayApprovalRequest` and never decides anything itself.
 */
import type {
  ContainerSpec,
  DriverCapabilities,
  MountSpec,
  NetworkAccessIntent,
  SessionKey,
} from '../drivers/types.js';

/**
 * What a gateway contributes to one session, in spec vocabulary.
 *
 * - `env` lands on the agent's contributed lane (`ContainerSpec.contributedEnv`),
 *   filled after the model provider's contribution, so the gateway wins a key
 *   collision — the override the old raw-argv append got from Docker's
 *   last-wins rule, now stated as contract.
 * - `mounts` are ordinary MountSpecs: same classes, same admission as every
 *   other mount. Composition dedupes by containerPath with the gateway
 *   winning, so the spec a driver sees is collision-free.
 * - `containers` are auxiliary containers (a per-session proxy). Never role
 *   'agent'. Gated on the driver's `capabilities().auxiliaryContainers` before
 *   a spec is ever built.
 * - `labels` are provider-owned runtime lineage; reserved host labels cannot
 *   be overridden (composition keeps the last word on the canonical keys).
 * - `networkAccess` is the only network destination this session may use —
 *   an intent (`{ kind: 'host' | 'runtime' | 'session-container', ... }`),
 *   never a topology; the driver realizes it or rejects it
 *   (`drivers/index.ts`). Required, matching upstream: a gateway that cannot
 *   say what network its session needs does not get to run one.
 */
export interface GatewayContribution {
  env?: Record<string, string>;
  mounts?: MountSpec[];
  containers?: ContainerSpec[];
  labels?: Record<string, string>;
  networkAccess: NetworkAccessIntent;
}

export interface GatewaySessionInput {
  key: SessionKey;
  /** Adoption must never provision replacement identity for a surviving runtime. */
  disposition?: 'create' | 'adopt';
  /** Stable across host restarts and runtime adoption. */
  runtimeIdentity: string;
  /** The agent group's display name, for gateways that register an agent identity. */
  groupName: string;
  /** The runtime container this session runs in, as the driver named it; providers key per-session resources on it. */
  containerName: string;
  /**
   * The selected driver's capabilities. `sharedNetworkNamespace` decides the
   * proxy URL shape a contribution puts in the agent's env; a provider that
   * composes containers checks `auxiliaryContainers` and degrades or refuses.
   */
  capabilities: DriverCapabilities;
}

export function gatewayRuntimeIdentity(key: SessionKey): string {
  return `${key.installSlug}/${key.agentGroupId}/${key.sessionId}`;
}

/**
 * Result of idempotently ensuring one session. The signal stops observation
 * by this host. Per-session resources use awaited `release` to distinguish
 * runtime termination from host replacement.
 */
export interface GatewaySessionRelease {
  kind: 'session-ended' | 'host-detached';
  reason: string;
}

export interface GatewaySessionLease {
  contribution: GatewayContribution;
  /** Await cleanup. Host detachment preserves resources for the successor. */
  release?(event: GatewaySessionRelease): Promise<void>;
  onUnavailable?(report: (reason: string) => void): void;
}

export type GatewayApprovalDecision = 'approve' | 'deny' | 'unavailable';

/** Privacy-safe request presentation translated from a provider's native protocol. */
export interface GatewayApprovalRequest {
  /** Missing means explicit policy approval for compatibility with older adapters. */
  trigger?: 'default' | 'policy';
  /** Exact verified channel identity selected by the gateway policy. */
  approverUserId?: string;
  approverInstance?: string;
  /** Verified destination selected by the gateway policy adapter. */
  delivery?: { messagingGroupId: string; threadId?: string };
  /** Metadata only: never credentials, query strings, or request bodies. */
  destination?: { host: string; method?: string };
  /** Selected, bounded display fields may come from the request. Never pass raw bodies, headers, tokens or query strings. */
  summary?: {
    agent: string;
    action: string;
    resource: string;
    reason: string;
    details?: { label: string; value: string }[];
  };
  /** Policy-selected, privacy-reviewed fields. Rejected if oversized; never silently truncated. */
  displayFields?: Array<
    | { label: string; type: 'text' | 'long_text'; value: string }
    | { label: string; type: 'list'; value: string[]; overflow?: number }
  >;
  id: string;
  agentGroupId: string;
  sessionId?: string;
  runtimeIdentity?: string;
  createdAt: string;
  expiresAt?: string;
  title: string;
  question: string;
  audit?: Record<string, string | number | boolean | null>;
}

/** Core-owned installation scope for gateways whose native event stream is shared. */
export interface GatewayApprovalScope {
  /** Read live group membership. A rejected lookup is not permission to decide. */
  ownsAgentGroup(agentGroupId: string): Promise<boolean>;
}

/** A gateway-owned connection handoff. No credentials cross this boundary. */
export type GatewayConnectionResult =
  | { status: 'action_required'; action: 'operator_console' | 'oauth'; connect_url: string; message: string }
  | { status: 'unsupported'; message: string };

export interface GatewayProviderDefinition {
  /** Identity, for logs and selection — never a branch above the seam. */
  readonly kind: string;
  /** Shared approval health for separated host processes. Missing/expired leases must read false. */
  availability?: {
    /** Only the process owning the approval subscription publishes; refreshes a bounded lease. */
    publish(available: boolean): Promise<void>;
    read(): Promise<boolean>;
  };
  /** Read-only handoff: must not grant credentials or change network policy. */
  connections?: {
    connect(input: { agentGroupId: string; host: string }): Promise<GatewayConnectionResult>;
  };
  /** Only the selected gateway's skills and instructions reach an agent. */
  agentSkills: readonly string[];
  sessions: {
    /** Idempotently creates or reconnects whatever this session needs; same call for new and adopted sessions. */
    ensure(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease>;
    /** Called after surviving sessions have been considered for adoption. */
    reapOrphans?(): void | Promise<void>;
  };
  /** Required for every gateway. Ending while signal is active fails closed. */
  approvals: {
    /** Approval action names owned by an older adapter version and swept during migration. */
    legacyActions?: readonly string[];
    /** Persist decisions until acknowledged. Requires decide and listPending. */
    durable?: boolean;
    subscribe(
      decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>,
      signal: AbortSignal,
      resolved?: (requestId: string) => Promise<void>,
      /** Shared-stream adapters must filter ownership before translating or settling requests. */
      scope?: GatewayApprovalScope,
    ): Promise<void>;
    /** Optional restart recovery, when the gateway supports held-request enumeration or late decisions. */
    listPending?(): Promise<GatewayApprovalRequest[]>;
    decide?(requestId: string, decision: GatewayApprovalDecision): Promise<boolean>;
  };
}

/** Not a union: overlays bring their own kinds (see `DriverKind`). */
export type GatewayProviderKind = string;

export type GatewayProviderFactory = () => GatewayProviderDefinition;

const registry = new Map<GatewayProviderKind, GatewayProviderFactory>();

/**
 * Install a gateway provider under a kind. Overlays call this at module scope
 * from a file reached via `installed.ts`; a duplicate registration is a wiring
 * bug and throws rather than letting the last import silently win.
 */
export function registerGatewayProvider(kind: GatewayProviderKind, factory: GatewayProviderFactory): void {
  if (registry.has(kind)) {
    throw new Error(`Gateway provider already registered: ${kind}`);
  }
  registry.set(kind, factory);
}

export function getGatewayProviderFactory(kind: GatewayProviderKind): GatewayProviderFactory | undefined {
  return registry.get(kind);
}

/** The kinds this build can actually run — what the failure message reports. */
export function listGatewayProviderKinds(): GatewayProviderKind[] {
  return [...registry.keys()];
}

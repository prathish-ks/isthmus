/**
 * The normalized differential-testing result shape, per docs/parity-schema.md.
 *
 * A `ParityResult` only populates the axes a given fixture actually exercises
 * — see "The normalized ParityResult schema" in docs/parity-schema.md for why
 * this is a set of optional top-level keys rather than a null-filled shape.
 */

export type NormalizedId = string;
export type NormalizedRow = Record<string, unknown>;

export interface RoutingAxis {
  dispositions: Array<{
    agentGroupId: NormalizedId;
    outcome: 'engaged' | 'accumulated' | 'dropped';
    engageMode: 'pattern' | 'mention' | 'mention-sticky';
    accessOk: boolean;
    scopeOk: boolean;
  }>;
  messageOutcome: 'routed' | 'dropped';
  dropReason?: string;
  deliveryAddr?: { channelType: string; platformId: string; threadId: string | null };
  channelRegistrationEscalated: boolean;
}

export interface SessionAxis {
  sessionId: NormalizedId;
  created: boolean;
  sessionMode: 'shared' | 'per-thread' | 'agent-shared';
  containerStatus: 'stopped' | 'running' | 'idle';
  lastActiveTouched: boolean;
}

export interface DbStateAxis {
  tables: Record<string, NormalizedRow[]>;
}

export interface ContainerWakeAxis {
  attempted: boolean;
  outcome: boolean | null;
  spec?: {
    image: string;
    env: Record<string, string>;
    mounts: Array<{ class: string; containerPath: string; mode: 'rw' | 'ro'; groupScope: string }>;
    network: 'shared-private' | 'none';
    resources: { memoryMb?: number; cpus?: string; pidsLimit?: number; shmSizeMb?: number };
  };
  failure?: {
    kind:
      | 'spec-invalid'
      | 'denied-by-policy'
      | 'image-unavailable'
      | 'runtime-unavailable'
      | 'resources-exhausted'
      | 'started-then-died'
      | 'unknown';
    retryable: boolean;
  };
}

export interface DeliveryAxis {
  outcome: 'delivered' | 'retryable-failure' | 'permanent-failure';
  target: { channelType: string; platformId: string; threadId: string | null };
  attempts: number;
}

export interface GuardAxis {
  effect: 'allow' | 'hold' | 'deny';
  reasonCategory: string;
}

export interface ParityResult {
  scenario: string;
  routing?: RoutingAxis;
  session?: SessionAxis;
  dbState?: DbStateAxis;
  containerWake?: ContainerWakeAxis;
  delivery?: DeliveryAxis;
  guard?: GuardAxis;
}

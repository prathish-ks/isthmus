/**
 * Egress lockdown — force all agent traffic through the configured gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached at its declared alias, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 *
 * Generalized from a hardcoded OneCLI assumption to any gateway that
 * declares `GatewayProviderDefinition.egressGateway()` — v2.4.0 promotion,
 * ADR-033. `ensureEgressNetwork` no longer reads a fixed container name
 * from config; its caller resolves which gateway is actually configured.
 */
import { execFileSync } from 'child_process';

import { EGRESS_LOCKDOWN, EGRESS_NETWORK } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import type { NetworkAccessIntent } from './drivers/types.js';
import { log } from './log.js';

// Perimeter knobs (locked-down network, on/off flag) are read via config.ts
// so they honor .env under the shipped service, not just process.env.
export { EGRESS_NETWORK };

// Remembers the last access `ensureEgressNetwork` was actually given, so
// host-sweep.ts's periodic re-heal call — which has no gateway of its own to
// resolve — can keep calling `ensureEgressNetwork()` with no argument.
let selectedAccess: NetworkAccessIntent | undefined;

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress, or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Is the named gateway container currently attached to the egress network? */
function gatewayAttached(identity: string): boolean {
  try {
    // Newline-delimited, one name per line, compared with an exact match —
    // not space-joined + word-split. This is security-boundary code (a miss
    // here is a lockdown bypass): a container name containing a space would
    // mis-tokenize a space-joined list, splitting one name into several
    // tokens or merging adjacent ones into a false match.
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}}\n{{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split('\n').some((name) => name.trim() === identity);
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the given gateway attached (aliased
 * per `access.endpoint`). Idempotent + self-healing. Returns false when
 * lockdown is disabled, or when no access was resolvable (caller decides
 * whether that itself is an error — see `kernel-supervisor/index.ts`'s
 * startup check, which fails closed rather than calling this with nothing).
 * Throws EgressLockdownError when enabled and an access was given but it
 * can't be established, or when the access can't be realized as a Docker
 * network attachment at all (only a `kind: 'runtime'` target can) — fail
 * fast rather than spawn an agent with open egress.
 */
export function ensureEgressNetwork(access: NetworkAccessIntent | undefined = selectedAccess): boolean {
  if (!EGRESS_LOCKDOWN) return false;
  if (!access) return false;
  selectedAccess = access;

  if (access.target.kind !== 'runtime' || !access.target.identity) {
    throw new EgressLockdownError(
      `the configured gateway's egress target ("${access.target.kind}") is not a single Docker container this ` +
        `network can attach`,
    );
  }
  const identity = access.target.identity;

  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached(identity)) return true;

  if (
    dockerOk(['network', 'connect', '--alias', access.endpoint, EGRESS_NETWORK, identity]) &&
    gatewayAttached(identity)
  ) {
    log.info('Egress lockdown: gateway attached', {
      network: EGRESS_NETWORK,
      gateway: identity,
      endpoint: access.endpoint,
    });
    return true;
  }

  throw new EgressLockdownError(`the gateway "${identity}" could not be attached to "${EGRESS_NETWORK}"`);
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}

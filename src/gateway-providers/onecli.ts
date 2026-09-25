/**
 * OneCLI — the built-in, default gateway provider.
 *
 * v2.4.0 promotion, Workstream C7: restructured onto the full
 * `GatewayProviderDefinition` contract (`docs/gateway-seam.md`). Mandatory,
 * not optional — the host refuses to start with no gateway provider
 * registered, and this is the one baked into core (matches upstream's own
 * `gateway.json`: `{"kind": "onecli", "default": true}`).
 *
 * `sessions.ensure` is the same wiring the spawn path always did (ensure the
 * agent exists gateway-side, fetch the per-session container config, treat
 * "not applied" as a transient hard failure) — the contribution crosses into
 * the spec as TYPED env and mounts, merged before validation, instead of raw
 * docker flags appended after it. OneCLI's `ManualApprovalHandle` exposes no
 * release or availability signal, so the returned lease carries neither
 * `release` nor `onUnavailable`: those stay single-process-behavior, per
 * `docs/gateway-seam.md`'s own note that a gateway which doesn't declare a
 * capability keeps the pre-v2.4.0 default.
 *
 * `approvals.subscribe` wraps `onecli.configureManualApproval` — the SDK's
 * callback-based bridge, which has no native "ended" event — into the
 * generic `subscribe(decide, signal): Promise<void>` shape: the promise
 * settles only when `signal` aborts, matching the SDK's own capabilities.
 * `gateway-approval-coordinator.ts` owns everything about *how* an
 * approval reaches an admin; this file only translates OneCLI's native
 * `ApprovalRequest` into `GatewayApprovalRequest` and hands it to `decide`.
 *
 * The SDK's apply surface still emits argv for the session contribution, so
 * this provider parses it at the boundary. The grammar is closed and known
 * from the SDK source: with `addHostMapping: false` it emits exactly
 * `-e KEY=VALUE` pairs (proxy env, CA bundle pointers) and
 * `-v host:container[:ro]` mounts (the CA certificate, credential stub FILES
 * — stubs never ride env). Anything else refuses the spawn: nothing gets to
 * ride raw argv around the spec again. A typed SDK config surface is the
 * successor that deletes this parser.
 */
import { OneCLI, type ApprovalRequest } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import type { MountSpec, NetworkAccessIntent } from '../drivers/types.js';
import { log } from '../log.js';

import { getAgentGroup } from '../db/agent-groups.js';
import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayContribution,
} from './gateway-provider-registry.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * OneCLI runs on the install's own host, never in a driver-managed
 * container — `target.kind: 'host'` is a no-op for the kernel's network
 * executor (only `session-container` targets engage the private-network/
 * auxiliary-container machinery, `go-host/internal/kernel/exec.go`), so this
 * is documentation-shaped for OneCLI specifically, not behavior-changing.
 */
function onecliNetworkAccess(): NetworkAccessIntent {
  return { endpoint: ONECLI_URL, target: { kind: 'host' } };
}

/** Argv → typed contribution. Exported for its tests; the grammar is closed. */
export function contributionFromArgs(args: readonly string[], groupScope: string): GatewayContribution {
  const env: Record<string, string> = {};
  const mounts: MountSpec[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '-e' && value?.includes('=')) {
      const eq = value.indexOf('=');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (flag === '-v' && value) {
      const parts = value.split(':');
      if (parts.length >= 2 && parts.length <= 3 && (parts[2] === undefined || parts[2] === 'ro')) {
        mounts.push({
          class: 'allowlisted-extra',
          hostPath: parts[0],
          containerPath: parts[1],
          mode: parts[2] === 'ro' ? 'ro' : 'rw',
          groupScope,
          // Provider-stamped (OneCLI's own CA cert / credential stubs), never
          // the operator's mount-allowlist.json — exempt from that check.
          origin: 'provider',
        });
        continue;
      }
    }
    // Fail-closed on grammar drift: an SDK that starts emitting a flag this
    // parser cannot type must break the spawn loudly, not smuggle argv.
    throw new Error(`OneCLI gateway emitted argv this seam cannot type: '${flag} ${value ?? ''}'`);
  }
  return { env, mounts, networkAccess: onecliNetworkAccess() };
}

/**
 * The hosted gateway's structured request summary — not yet in the SDK's
 * ApprovalRequest type (observed on api.onecli.sh, 2026-07): the action
 * being performed plus labeled fields (To / Subject / Body for email sends).
 */
interface ApprovalSummary {
  action?: string;
  details?: { label: string; value: string }[];
}

const SUMMARY_VALUE_EXCERPT_CHARS = 900;

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* ${agentName}`];

  const summary = (request as ApprovalRequest & { summary?: ApprovalSummary }).summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* ${summary.action}`);
    // A render bug here must never decide the request: decide()'s own catch
    // returns 'deny', so stay defensive — coerce non-string values instead of
    // assuming the gateway's shape, and keep the card under Slack's 3000-char
    // section limit or delivery itself fails.
    let budget = 2600;
    for (const { label, value } of summary.details) {
      const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
      const cap = Math.min(SUMMARY_VALUE_EXCERPT_CHARS, Math.max(0, budget));
      if (cap === 0) {
        lines.push(`_…${summary.details.length} field(s) omitted for length — see the audit payload._`);
        break;
      }
      const v = raw.length > cap ? `${raw.slice(0, cap)}…` : raw;
      budget -= v.length + String(label).length + 8;
      // Multi-line values (message bodies) read better fenced; short labeled
      // fields (To, Subject) inline.
      if (v.includes('\n')) lines.push(`*${label}:*`, '```', v, '```');
      else lines.push(`*${label}:* ${v}`);
    }
  } else if (request.bodyPreview) {
    lines.push('```', request.bodyPreview.slice(0, SUMMARY_VALUE_EXCERPT_CHARS * 2), '```');
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  } else {
    lines.push(`_${request.method} ${request.host}${request.path}_`);
  }
  return lines.join('\n');
}

/**
 * OneCLI's native request → the seam's typed, provider-agnostic shape.
 * Exported for its tests. `agentGroupId` is the empty string, not a missing
 * value, when the request carries no origin group — `''` is this codebase's
 * existing sentinel for "no known scope" (see `MountPolicy.gatewayTrustRoot`),
 * and the coordinator's `pickApprover`/`pickApprovalDelivery` calls already
 * treat it identically to `null`.
 */
export function toGatewayApprovalRequest(
  request: ApprovalRequest,
  agentGroupId: string,
  agentName: string,
): GatewayApprovalRequest {
  return {
    // OneCLI's native approval events are explicit policy holds, never a
    // default network-traffic hold (`docs/gateway-seam.md`).
    trigger: 'policy',
    id: request.id,
    agentGroupId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    destination: { host: request.host, method: request.method },
    title: 'Credentials Request',
    question: buildQuestion(request, agentName),
    audit: {
      method: request.method,
      host: request.host,
      path: request.path,
      ...(request.bodyPreview ? { bodyPreview: request.bodyPreview } : {}),
    },
  };
}

registerGatewayProvider('onecli', () => ({
  kind: 'onecli',
  // The container skill (`container/skills/onecli-gateway`) that teaches an
  // agent how the proxy works — reserved for the selective-exposure filter
  // (`selectGatewayAgentSkills`) a second, competing gateway (Iron Proxy,
  // Workstream C8) will need; a no-op with one gateway registered.
  agentSkills: ['onecli-gateway'],
  sessions: {
    async ensure({ key, groupName }) {
      // OneCLI agent identifier is always the agent group id — stable across
      // sessions and reversible via getAgentGroup() for approval routing.
      await onecli.ensureAgent({ name: groupName, identifier: key.agentGroupId });
      const args: string[] = [];
      const applied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: key.agentGroupId });
      if (!applied) {
        throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
      }
      log.info('OneCLI gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
      return { contribution: contributionFromArgs(args, key.agentGroupId) };
    },
  },
  approvals: {
    async subscribe(decide, signal) {
      const handle = onecli.configureManualApproval(async (request: ApprovalRequest) => {
        try {
          // OneCLI's agent identifier is always the agent group id (set by
          // `ensure` above), so this is a lookup, not a derivation — and the
          // display name it resolves is what the card shows, not the SDK's
          // own (potentially stale or generic) agent.name.
          const originGroup = request.agent.externalId ? await getAgentGroup(request.agent.externalId) : undefined;
          const decision = await decide(
            toGatewayApprovalRequest(request, originGroup?.id ?? '', originGroup?.name ?? request.agent.name),
          );
          return decision === 'approve' ? 'approve' : 'deny';
        } catch (err) {
          log.error('Gateway approval translation failed', { id: request.id, err });
          return 'deny';
        }
      });
      // The SDK exposes no "ended" event — `configureManualApproval` is a
      // register-and-forget callback, so this promise settles only on an
      // intentional stop, never on its own. That is honest for what the SDK
      // can actually report, and it's why OneCLI declares no `availability`
      // capability: there is no health signal to publish.
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            handle.stop();
            resolve();
          },
          { once: true },
        );
      });
    },
  },
}));

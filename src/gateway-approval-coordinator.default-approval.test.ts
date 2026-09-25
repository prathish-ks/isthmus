/**
 * Default-model-traffic auto-approval (v2.4.0 promotion, Workstream C8 —
 * ADR-030's narrow `provider-contracts` scope).
 *
 * OneCLI's own requests are always `trigger: 'policy'` (confirmed in
 * `onecli.ts`'s own translation), so this path is unreachable through the
 * real OneCLI flow today — it exists for a future `'default'`-trigger
 * gateway (Iron Proxy). Tested here through a stub `GatewayProviderDefinition`
 * that calls `decide` directly with whatever request each case constructs,
 * rather than through a real provider's translation layer — this is the
 * coordinator's own decision logic under test, not any provider's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { startGatewayApprovalCoordinator, stopGatewayApprovalCoordinator } from './gateway-approval-coordinator.js';
import { getGatewayProviderFactory, registerGatewayProvider, type GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';
import { resetGatewayProvider } from './gateway-providers/index.js';

const AGENT_GROUP_ID = 'ag-default-approval';

function now(): string {
  return new Date().toISOString();
}

function baseRequest(overrides: Partial<GatewayApprovalRequest> = {}): GatewayApprovalRequest {
  return {
    id: 'req-1',
    agentGroupId: AGENT_GROUP_ID,
    createdAt: now(),
    title: 'Outbound request',
    question: 'Allow?',
    ...overrides,
  };
}

let decideFn: ((request: GatewayApprovalRequest) => Promise<string>) | null = null;
const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver() {
    return undefined;
  },
};

beforeEach(async () => {
  decideFn = null;
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Default Approval Test',
    folder: 'default-approval-test',
    agent_provider: null,
    created_at: now(),
  });
  // Default provider resolution (resolveProviderName) falls back to
  // 'claude' when neither the session nor the container config names one —
  // 'claude' is registered for real via provider-contracts/claude.ts's own
  // side-effect import, so this exercises the actual wiring, not a stub
  // contract.
  await ensureContainerConfig(AGENT_GROUP_ID);

  // A stub gateway whose subscribe() hands the coordinator's `decide`
  // straight back to the test, so each case drives it directly.
  if (!getGatewayProviderFactory('default-approval-stub')) {
    registerGatewayProvider('default-approval-stub', () => ({
      kind: 'default-approval-stub',
      agentSkills: [],
      sessions: {
        async ensure() {
          return { contribution: { networkAccess: { endpoint: '', target: { kind: 'host' } } } };
        },
      },
      approvals: {
        async subscribe(decide, signal) {
          decideFn = decide;
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        },
      },
    }));
  }
  resetGatewayProvider(null);
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'default-approval-stub';
  startGatewayApprovalCoordinator(fakeAdapter);
});

afterEach(async () => {
  stopGatewayApprovalCoordinator();
  resetGatewayProvider(null);
  delete process.env.NANOCLAW_GATEWAY_PROVIDER;
  await closeDb();
});

describe('default-model-traffic auto-approval', () => {
  it('auto-approves a default-trigger request to the resolved provider model domain, no card created', async () => {
    expect(decideFn).not.toBeNull();
    const decision = await decideFn!(
      baseRequest({ trigger: 'default', destination: { host: 'api.anthropic.com', method: 'POST' } }),
    );
    expect(decision).toBe('approve');
  });

  it('auto-approves the bare domain itself, not only subdomains', async () => {
    const decision = await decideFn!(
      baseRequest({ trigger: 'default', destination: { host: 'anthropic.com', method: 'GET' } }),
    );
    expect(decision).toBe('approve');
  });

  it('does not auto-approve a default-trigger request to an unrelated host', async () => {
    const decision = await decideFn!(
      baseRequest({ trigger: 'default', destination: { host: 'evil.example.com', method: 'POST' } }),
    );
    // Falls through to the normal card flow, which denies here (no approver
    // seeded) — the point under test is that it did NOT take the auto-
    // approve shortcut, not the specific denial reason.
    expect(decision).toBe('deny');
  });

  it('never auto-approves a policy-trigger request, even to a declared model domain', async () => {
    const decision = await decideFn!(
      baseRequest({ trigger: 'policy', destination: { host: 'api.anthropic.com', method: 'POST' } }),
    );
    expect(decision).toBe('deny');
  });

  it('never auto-approves when trigger is missing (older-adapter compatibility default)', async () => {
    const decision = await decideFn!(baseRequest({ destination: { host: 'api.anthropic.com', method: 'POST' } }));
    expect(decision).toBe('deny');
  });
});

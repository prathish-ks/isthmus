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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { getPendingApprovalsByAction } from './db/sessions.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import {
  GATEWAY_APPROVAL_ACTION,
  resolveGatewayApproval,
  startGatewayApprovalCoordinator,
  stopGatewayApprovalCoordinator,
} from './gateway-approval-coordinator.js';
import {
  getGatewayProviderFactory,
  registerGatewayProvider,
  type GatewayApprovalRequest,
} from './gateway-providers/gateway-provider-registry.js';
import { resetGatewayProvider } from './gateway-providers/index.js';
import { grantRole } from './modules/permissions/db/user-roles.js';
import { upsertUser } from './modules/permissions/db/users.js';

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

// Regression coverage for a real gap found during the v2.4.0 promotion's
// Workstream C6 security review: the contract's `approverUserId` ("Exact
// verified channel identity selected by the gateway policy") narrowed which
// user got the notification, but the persisted row never carried it — so
// isAuthorizedApprovalClick fell through to hasAdminPrivilege and let ANY
// admin for the group resolve a decision the gateway meant to restrict to
// one specific, already-verified identity. OneCLI never sets
// approverUserId (unreachable through the real OneCLI flow, same reason as
// the auto-approval suite above), so this is driven through the stub
// gateway directly.
describe('approverUserId is persisted to the approval row', () => {
  it('carries a gateway-named approver onto the row', async () => {
    await createMessagingGroup({
      id: 'mg-approver-persist',
      channel_type: 'slack',
      platform_id: 'D-named',
      name: 'Named approver DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    void decideFn!(
      baseRequest({ approverUserId: 'slack:named-approver', delivery: { messagingGroupId: 'mg-approver-persist' } }),
    );
    const rows = await vi.waitFor(async () => {
      const found = await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION);
      expect(found).toHaveLength(1);
      return found;
    });
    expect(rows[0].approver_user_id).toBe('slack:named-approver');
    await resolveGatewayApproval(rows[0].approval_id, 'approve');
  });

  it('stays null when the gateway names no specific approver (any admin may still decide)', async () => {
    await upsertUser({ id: 'slack:group-admin', kind: 'slack', display_name: 'Group Admin', created_at: now() });
    await grantRole({
      user_id: 'slack:group-admin',
      role: 'admin',
      agent_group_id: AGENT_GROUP_ID,
      granted_by: null,
      granted_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-no-approver-persist',
      channel_type: 'slack',
      platform_id: 'D-none',
      name: 'No named approver DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    void decideFn!(baseRequest({ delivery: { messagingGroupId: 'mg-no-approver-persist' } }));
    const rows = await vi.waitFor(async () => {
      const found = await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION);
      expect(found).toHaveLength(1);
      return found;
    });
    // pickApprover found the group-scoped admin and delivery succeeded —
    // proving this is a real persisted row, not a deny-before-write — yet
    // approver_user_id is null because the gateway named no one, which is
    // exactly what lets hasAdminPrivilege's "any admin for the group" stay
    // the authorization rule for this case.
    expect(rows[0].approver_user_id).toBeNull();
    await resolveGatewayApproval(rows[0].approval_id, 'approve');
  });
});

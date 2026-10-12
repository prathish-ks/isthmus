/**
 * Gateway approval coordinator — coverage of the full request lifecycle,
 * driven through the installed OneCLI provider (the only one registered in
 * this tree today).
 *
 * v2.4.0 promotion, Workstream C7: ported from
 * `modules/approvals/onecli-approvals.coverage.test.ts` behavior-for-
 * behavior — same scenarios, same timing, same fail-closed assertions.
 * Renamed to match the generic surface: `ga-` short ids (was `oa-`),
 * `GATEWAY_APPROVAL_ACTION` (was `ONECLI_ACTION`), generic log-message text.
 *
 * The @onecli-sh/sdk client is replaced with a stub that captures the
 * `configureManualApproval` callback so tests can drive it exactly the way
 * the gateway would: fire a request, watch the card go out, then resolve it
 * by an admin click or let the expiry timer fire. Real central DB, fake
 * delivery adapter (records deliveries and edits).
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalRequest } from '@onecli-sh/sdk';

import { getDb } from './db/connection.js';
import { initTestDb, closeDb, runMigrations } from './db/index.js';
import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig } from './db/container-configs.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  getPendingApprovalsByAction,
  transitionPendingApprovalStatus,
} from './db/sessions.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { resetGatewayProvider } from './gateway-providers/index.js';
import type { GatewayApprovalDecision, GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';
import { log } from './log.js';
import type { PendingApproval } from './types.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { upsertUserDm } from './modules/permissions/db/user-dms.js';
import { grantRole } from './modules/permissions/db/user-roles.js';

const sdk = vi.hoisted(() => ({
  configure: vi.fn(),
  stop: vi.fn(),
  callback: null as null | ((request: ApprovalRequest) => Promise<'approve' | 'deny'>),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval(cb: (request: ApprovalRequest) => Promise<'approve' | 'deny'>) {
      sdk.configure(cb);
      sdk.callback = cb;
      return { stop: sdk.stop };
    }
  },
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-gateway-approvals-cov' };
});

const {
  GATEWAY_APPROVAL_ACTION,
  editCardExpired,
  isDefaultApprovedModelHost,
  resolveGatewayApproval,
  startGatewayApprovalCoordinator,
  stopGatewayApprovalCoordinator,
} = await import('./gateway-approval-coordinator.js');
const { registerProviderHostContract, resetProviderHostContractForTesting } =
  await import('./provider-contracts/registry.js');

const TEST_DIR = '/tmp/nanoclaw-test-gateway-approvals-cov';
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';
const DM_INSTANCE = 'slack-b';

function now(): string {
  return new Date().toISOString();
}

interface Delivered {
  channelType: string;
  platformId: string;
  kind: string;
  content: Record<string, unknown>;
  instance: string | undefined;
}

let delivered: Delivered[];
let deliverImpl: () => Promise<string | undefined>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, kind, content, _files, instance) {
    delivered.push({ channelType, platformId, kind, content: JSON.parse(content), instance });
    return deliverImpl();
  },
};

function makeRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'req-uuid-1',
    method: 'POST',
    url: 'https://api.example.com/v1/send',
    host: 'api.example.com',
    path: '/v1/send',
    headers: {},
    bodyPreview: null,
    agent: { id: 'onecli-agent-1', name: 'SDK Agent Name', externalId: 'ag-1' },
    createdAt: now(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    timeoutSeconds: 60,
    ...overrides,
  };
}

/** Seed an owner with a cached DM on a named instance so pickApprovalDelivery resolves. */
async function seedApprover(): Promise<void> {
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    instance: DM_INSTANCE,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });
}

/** Fire the captured gateway callback and return the still-pending decision promise. */
function fire(request: ApprovalRequest): Promise<'approve' | 'deny'> {
  expect(sdk.callback).not.toBeNull();
  return sdk.callback!(request);
}

/** Wait until the card for a request has been delivered and its row persisted. */
async function awaitCard(): Promise<PendingApproval> {
  let row: PendingApproval | undefined;
  await vi.waitFor(async () => {
    const rows = await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION);
    expect(rows).toHaveLength(1);
    row = rows[0];
  });
  return row!;
}

/**
 * Fake-timer-safe variant: flushes microtasks without advancing the clock
 * (vi.waitFor would advance fake timers and could fire the expiry early).
 */
async function awaitCardFake(): Promise<PendingApproval> {
  for (let i = 0; i < 50; i++) {
    await vi.advanceTimersByTimeAsync(0);
    const rows = await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION);
    if (rows.length === 1) return rows[0];
  }
  throw new Error('card row never appeared');
}

beforeEach(async () => {
  vi.clearAllMocks();
  sdk.callback = null;
  delivered = [];
  deliverImpl = async () => 'pm-1';
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: 'ag-1',
    name: 'Group One',
    folder: 'group-one',
    agent_provider: null,
    created_at: now(),
  });
});

afterEach(async () => {
  stopGatewayApprovalCoordinator();
  vi.useRealTimers();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('start / stop lifecycle', () => {
  it('configures the SDK once and ignores a second start while running', () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(sdk.configure).toHaveBeenCalledTimes(1);
  });

  it('stop releases the SDK handle so a later start configures again', () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    stopGatewayApprovalCoordinator();
    expect(sdk.stop).toHaveBeenCalledTimes(1);
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(sdk.configure).toHaveBeenCalledTimes(2);
  });

  it('stop without a running handler is a no-op', () => {
    expect(() => stopGatewayApprovalCoordinator()).not.toThrow();
    expect(sdk.stop).not.toHaveBeenCalled();
  });

  it('sweeps rows left over from a previous process: card edited as host-restarted, row dropped', async () => {
    await createPendingApproval({
      approval_id: 'ga-stale001',
      request_id: 'req-old',
      action: GATEWAY_APPROVAL_ACTION,
      payload: '{}',
      created_at: now(),
      channel_type: DM_CHANNEL,
      platform_id: DM_PLATFORM,
      instance: 'slack-old',
      platform_message_id: 'pm-old',
      title: 'Credentials Request',
      question: 'old question',
      options_json: '[]',
    });

    startGatewayApprovalCoordinator(fakeAdapter);

    await vi.waitFor(async () => {
      expect(await getPendingApproval('ga-stale001')).toBeUndefined();
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content.operation).toBe('edit');
    expect(delivered[0].content.messageId).toBe('pm-old');
    expect(delivered[0].instance).toBe('slack-old');
    expect(String(delivered[0].content.text)).toContain('host restarted');
    expect((delivered[0].content.terminalCard as { resolution: string }).resolution).toContain('host restarted');
  });

  it('logs when the startup sweep itself fails instead of throwing', async () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await closeDb(); // getDb() now throws inside the sweep
    startGatewayApprovalCoordinator(fakeAdapter);
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('Gateway approval sweep failed', expect.anything());
    });
    errorSpy.mockRestore();
  });

  // Regression test for a fixed bug: stopping the handler while a request is
  // still in flight (awaiting an admin click or its expiry timer) used to
  // clear the timer and the pending map without ever resolving the promise
  // decide() returned to the provider callback — leaving that callback (and
  // the gateway's connection behind it) hanging forever instead of just
  // until the request's own timeout.
  it('stop resolves any in-flight request promise instead of leaving it hanging forever', async () => {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest());
    await awaitCard();

    let settled = false;
    void decision.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    stopGatewayApprovalCoordinator();

    await expect(decision).resolves.toBe('deny');
    expect(settled).toBe(true);
  });
});

describe('gateway callback → approval card', () => {
  it('denies when the handler has been stopped (no adapter bound)', async () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    const cb = sdk.callback!;
    stopGatewayApprovalCoordinator();
    expect(await cb(makeRequest())).toBe('deny');
    expect(delivered).toHaveLength(0);
  });

  it('denies when nobody is eligible to approve', async () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(await fire(makeRequest())).toBe('deny');
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)).toHaveLength(0);
  });

  it('denies when no approver has a reachable DM', async () => {
    // Owner exists but has no cached DM and no channel adapter to open one.
    await upsertUser({ id: 'slack:lonely', kind: 'slack', display_name: 'Lonely', created_at: now() });
    await grantRole({
      user_id: 'slack:lonely',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(await fire(makeRequest())).toBe('deny');
    expect(delivered).toHaveLength(0);
  });

  it('denies and records nothing when the card cannot be delivered', async () => {
    await seedApprover();
    deliverImpl = async () => {
      throw new Error('platform down');
    };
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(await fire(makeRequest())).toBe('deny');
    expect(delivered).toHaveLength(1);
    expect(await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)).toHaveLength(0);
  });

  // Regression test for a fixed bug: the card used to be delivered BEFORE
  // createPendingApproval wrote its row, so a DB failure there left a live
  // card with Approve/Reject buttons that couldn't resolve anything. The row
  // is now written first — a DB failure specifically at that insert must mean
  // no card ever goes out.
  it('never delivers the card when persisting the pending-approval row fails', async () => {
    await seedApprover();
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    await getDb().run('DROP TABLE pending_approvals');
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(await fire(makeRequest())).toBe('deny');
    expect(delivered).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('denies (fail closed) when the handler throws on a malformed request', async () => {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    const broken = makeRequest({ agent: undefined as unknown as ApprovalRequest['agent'] });
    expect(await fire(broken)).toBe('deny');
    expect(delivered).toHaveLength(0);
  });

  it('delivers the card to the approver DM on its owning instance and persists the row', async () => {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest({ bodyPreview: null }));
    const row = await awaitCard();

    expect(delivered).toHaveLength(1);
    const card = delivered[0];
    expect(card.channelType).toBe(DM_CHANNEL);
    expect(card.platformId).toBe(DM_PLATFORM);
    expect(card.instance).toBe(DM_INSTANCE);
    expect(card.kind).toBe('chat-sdk');
    expect(card.content.type).toBe('ask_question');
    expect(card.content.questionId).toBe(row.approval_id);
    expect(row.approval_id).toMatch(/^ga-[a-z0-9]{1,8}$/);
    expect(card.content.title).toBe('Credentials Request');
    expect(card.content.question).toBe('*Agent:* Group One\n_POST api.example.com/v1/send_');

    expect(row.request_id).toBe('req-uuid-1');
    expect(row.agent_group_id).toBe('ag-1');
    expect(row.instance).toBe(DM_INSTANCE);
    expect(row.platform_message_id).toBe('pm-1');
    expect(row.status).toBe('pending');
    expect(JSON.parse(row.payload)).toMatchObject({
      gatewayKind: 'onecli',
      nativeRequestId: 'req-uuid-1',
      method: 'POST',
      host: 'api.example.com',
      path: '/v1/send',
      approver: 'slack:admin-1',
    });

    expect(await resolveGatewayApproval(row.approval_id, 'approve')).toBe(true);
    expect(await decision).toBe('approve');
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
  });

  it('a Reject click resolves the gateway callback with deny', async () => {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest());
    const row = await awaitCard();
    expect(await resolveGatewayApproval(row.approval_id, 'reject')).toBe(true);
    expect(await decision).toBe('deny');
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
  });

  it('falls back to the SDK agent name and a null group when the request carries no external id', async () => {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    void fire(makeRequest({ agent: { id: 'x', name: 'SDK Agent Name', externalId: null } }));
    const row = await awaitCard();
    expect(row.agent_group_id).toBeNull();
    expect(String(delivered[0].content.question)).toContain('*Agent:* SDK Agent Name');
  });

  it('a null platform message id is persisted as NULL', async () => {
    await seedApprover();
    deliverImpl = async () => undefined;
    startGatewayApprovalCoordinator(fakeAdapter);
    void fire(makeRequest());
    const row = await awaitCard();
    expect(row.platform_message_id).toBeNull();
  });
});

describe('resolveGatewayApproval', () => {
  it('returns false for an id with no in-flight promise', async () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    expect(await resolveGatewayApproval('ga-nope', 'approve')).toBe(false);
  });

  it('returns false when the row is no longer pending, leaving the promise in flight', async () => {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    let settled = false;
    const decision = fire(makeRequest());
    void decision.then(() => {
      settled = true;
    });
    const row = await awaitCard();
    expect(await transitionPendingApprovalStatus(row.approval_id, 'pending', 'expired')).toBe(true);

    expect(await resolveGatewayApproval(row.approval_id, 'approve')).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect((await getPendingApproval(row.approval_id))?.status).toBe('expired');
  });
});

describe('expiry timer', () => {
  it('fires just before the gateway TTL: card edited as timed out, row dropped, callback denied', async () => {
    await seedApprover();
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest({ expiresAt: new Date(Date.now() + 3_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(0);
    const row = await awaitCardFake();
    expect(delivered).toHaveLength(1);

    // Timer is armed for expiresAt - now - 1s = 2s.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(await decision).toBe('deny');

    await vi.waitFor(async () => {
      expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    });
    expect(delivered).toHaveLength(2);
    const edit = delivered[1];
    expect(edit.content.operation).toBe('edit');
    expect(edit.content.messageId).toBe('pm-1');
    expect(edit.instance).toBe(DM_INSTANCE);
    expect(String(edit.content.text)).toContain('Timed out — no response');
    expect(edit.content.terminalCard).toEqual({
      title: 'Credentials Request',
      question: expect.stringContaining('*Agent:* Group One'),
      resolution: '⏱️ Timed out — no response',
    });
  });

  it('clamps an already-elapsed TTL to a 1s timer', async () => {
    await seedApprover();
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    let settled = false;
    const decision = fire(makeRequest({ expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    void decision.then(() => {
      settled = true;
    });
    await awaitCardFake();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(990);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(true);
    expect(await decision).toBe('deny');
  });

  it('skips the card edit when the row vanished before the timer fired', async () => {
    await seedApprover();
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest({ expiresAt: new Date(Date.now() + 3_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(0);
    const row = await awaitCardFake();
    await deletePendingApproval(row.approval_id);

    await vi.advanceTimersByTimeAsync(2_100);
    expect(await decision).toBe('deny');
    await vi.advanceTimersByTimeAsync(10);
    expect(delivered).toHaveLength(1);
  });

  it('skips the card edit when the row was already claimed by another transition', async () => {
    await seedApprover();
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest({ expiresAt: new Date(Date.now() + 3_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(0);
    const row = await awaitCardFake();
    await transitionPendingApprovalStatus(row.approval_id, 'pending', 'approved');

    await vi.advanceTimersByTimeAsync(2_100);
    expect(await decision).toBe('deny');
    await vi.advanceTimersByTimeAsync(10);
    expect(delivered).toHaveLength(1);
    expect((await getPendingApproval(row.approval_id))?.status).toBe('approved');
  });

  it('logs and keeps going when the expiry edit itself fails', async () => {
    await seedApprover();
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest({ expiresAt: new Date(Date.now() + 3_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(0);
    const row = await awaitCardFake();
    deliverImpl = async () => {
      throw new Error('edit failed');
    };

    await vi.advanceTimersByTimeAsync(2_100);
    expect(await decision).toBe('deny');
    await vi.waitFor(async () => {
      expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    });
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to edit expired gateway approval card',
      expect.objectContaining({ approvalId: row.approval_id }),
    );
    errorSpy.mockRestore();
  });

  it('logs when expiry bookkeeping itself fails (DB gone) and still denies', async () => {
    await seedApprover();
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    const decision = fire(makeRequest({ expiresAt: new Date(Date.now() + 3_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(0);
    const row = await awaitCardFake();
    await closeDb();

    await vi.advanceTimersByTimeAsync(2_100);
    expect(await decision).toBe('deny');
    await vi.advanceTimersByTimeAsync(10);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to mark gateway approval expired',
      expect.objectContaining({ approvalId: row.approval_id }),
    );
    expect(delivered).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('stop clears in-flight timers so no expiry edit is ever sent', async () => {
    await seedApprover();
    vi.useFakeTimers();
    startGatewayApprovalCoordinator(fakeAdapter);
    void fire(makeRequest({ expiresAt: new Date(Date.now() + 3_000).toISOString() }));
    await vi.advanceTimersByTimeAsync(0);
    await awaitCardFake();
    stopGatewayApprovalCoordinator();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toHaveLength(1);
  });
});

describe('editCardExpired', () => {
  function row(overrides: Partial<PendingApproval> = {}): PendingApproval {
    return {
      approval_id: 'ga-edit0001',
      session_id: null,
      request_id: 'req-1',
      action: GATEWAY_APPROVAL_ACTION,
      payload: '{}',
      created_at: now(),
      agent_group_id: null,
      channel_type: DM_CHANNEL,
      platform_id: DM_PLATFORM,
      instance: null,
      platform_message_id: 'pm-1',
      expires_at: null,
      status: 'pending',
      title: 'Credentials Request',
      question: 'Q?',
      options_json: '[]',
      approver_user_id: null,
      ...overrides,
    };
  }

  it('does nothing when no adapter is bound', async () => {
    await editCardExpired(row(), 'no response');
    expect(delivered).toHaveLength(0);
  });

  it('does nothing when the row has no platform message id or address', async () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    await editCardExpired(row({ platform_message_id: null }), 'no response');
    await editCardExpired(row({ channel_type: null }), 'no response');
    await editCardExpired(row({ platform_id: null }), 'no response');
    expect(delivered).toHaveLength(0);
  });

  it('joins title, question and resolution into the plain-text fallback, skipping empty parts', async () => {
    startGatewayApprovalCoordinator(fakeAdapter);
    await editCardExpired(row({ question: '' }), 'host restarted');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content.text).toBe('Credentials Request\n\n⏱️ Timed out — host restarted before resolution');
    expect(delivered[0].instance).toBe(DM_CHANNEL);
  });
});

describe('card question rendering', () => {
  async function questionFor(request: ApprovalRequest): Promise<string> {
    await seedApprover();
    startGatewayApprovalCoordinator(fakeAdapter);
    void fire(request);
    await awaitCard();
    return String(delivered[0].content.question);
  }

  it('renders a body preview fenced, capped, with the method line after it', async () => {
    const q = await questionFor(makeRequest({ bodyPreview: 'x'.repeat(2_000) }));
    const lines = q.split('\n');
    expect(lines[0]).toBe('*Agent:* Group One');
    expect(lines[1]).toBe('```');
    expect(lines[2]).toHaveLength(1_800);
    expect(lines[3]).toBe('```');
    expect(lines[4]).toBe('_POST api.example.com/v1/send_');
  });

  it('renders the hosted gateway summary: action, inline fields, fenced multi-line bodies, coerced values', async () => {
    const summary = {
      action: 'Send email',
      details: [
        { label: 'To', value: 'someone@example.com' },
        { label: 'Body', value: 'line one\nline two' },
        { label: 'Meta', value: { nested: true } },
        { label: 'Missing', value: undefined },
      ],
    };
    const q = await questionFor({ ...makeRequest(), summary } as ApprovalRequest);
    expect(q.split('\n')).toEqual([
      '*Agent:* Group One',
      '*Action:* Send email',
      '*To:* someone@example.com',
      '*Body:*',
      '```',
      'line one\nline two'.split('\n')[0],
      'line two',
      '```',
      '*Meta:* {"nested":true}',
      '*Missing:* undefined',
    ]);
  });

  it('stays under the Slack section limit: long values are excerpted and the tail is omitted', async () => {
    const summary = {
      details: [
        { label: 'A', value: 'a'.repeat(900) },
        { label: 'B', value: 'b'.repeat(900) },
        { label: 'C', value: 'c'.repeat(900) },
        { label: 'D', value: 'd'.repeat(50) },
      ],
    };
    const q = await questionFor({ ...makeRequest(), summary } as ApprovalRequest);
    const lines = q.split('\n');
    expect(lines[0]).toBe('*Agent:* Group One');
    expect(lines).not.toContain('*Action:* undefined');
    expect(lines[1]).toBe(`*A:* ${'a'.repeat(900)}`);
    expect(lines[2]).toBe(`*B:* ${'b'.repeat(900)}`);
    // Third value no longer fits in full — excerpted with an ellipsis.
    expect(lines[3].startsWith('*C:* ccc')).toBe(true);
    expect(lines[3].endsWith('…')).toBe(true);
    expect(lines[3].length).toBeLessThan(900);
    expect(lines[4]).toBe('_…4 field(s) omitted for length — see the audit payload._');
    expect(lines).toHaveLength(5);
    expect(q.length).toBeLessThan(3_000);
  });

  it('ignores an empty summary and falls back to the method line', async () => {
    const q = await questionFor({ ...makeRequest(), summary: { details: [] } } as ApprovalRequest);
    expect(q).toBe('*Agent:* Group One\n_POST api.example.com/v1/send_');
  });
});

// `#3964`'s core gap: ProviderHostContract.modelAuthorities is a declared
// field (added alongside the #3966 keyless local-model work), but nothing
// upstream of this check ever consulted it — a provider could declare an
// authority and have `decide()`'s auto-approve path silently ignore it. A
// declared-but-unenforced field is exactly the shape this project's own
// LAW-07 discipline treats as a gap, even with no live caller yet.
describe('isDefaultApprovedModelHost', () => {
  const FIXTURE = 'model-authority-fixture';

  afterEach(() => {
    resetProviderHostContractForTesting(FIXTURE);
  });

  it.each([
    ['models.example.test:8000', true],
    ['MODELS.EXAMPLE.TEST:8000', true],
    ['models.example.test:8001', false],
    ['models.example.test', false],
    ['sub.models.example.test:8000', false],
  ])('matches only the exact declared model authority: %s', (host, expected) => {
    registerProviderHostContract(FIXTURE, { seamVersion: 1, modelAuthorities: ['models.example.test:8000'] });
    expect(isDefaultApprovedModelHost(host, FIXTURE)).toBe(expected);
  });

  it('still matches a declared model domain when no authority is declared', () => {
    registerProviderHostContract(FIXTURE, { seamVersion: 1, modelDomains: ['api.example.com'] });
    expect(isDefaultApprovedModelHost('sub.api.example.com', FIXTURE)).toBe(true);
    expect(isDefaultApprovedModelHost('other.test', FIXTURE)).toBe(false);
  });
});

// Coordinator-level coverage for the same gap: isDefaultApprovedModelHost is
// only a helper — the actual security-sensitive enforcement is decide()'s own
// trigger check (only 'default' ever auto-approves; 'policy' always keeps a
// card, whatever the destination is). OneCLI's own adapter hardcodes
// trigger: 'policy' for every request, so it can never exercise the
// auto-approve branch — these two tests drive decide() directly through a
// fake gateway provider, the same seam a real second gateway (e.g. Iron
// Proxy) would use to set trigger: 'default'.
describe('decide() auto-approval via trigger', () => {
  const FIXTURE = 'model-authority-decide-fixture';
  const HOST = 'models.example.test:8000';

  afterEach(() => {
    resetProviderHostContractForTesting(FIXTURE);
    resetGatewayProvider(null);
  });

  function captureDecide(): { decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision> } {
    const captured: { decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision> } = {
      decide: async () => 'unavailable',
    };
    resetGatewayProvider({
      kind: 'fixture',
      agentSkills: [],
      sessions: {
        ensure: () => {
          throw new Error('not exercised by this test');
        },
      },
      approvals: {
        async subscribe(decide) {
          captured.decide = decide;
        },
      },
    });
    startGatewayApprovalCoordinator(fakeAdapter);
    return captured;
  }

  it('auto-approves a default-trigger request against a declared model authority, without a card', async () => {
    registerProviderHostContract(FIXTURE, { seamVersion: 1, modelAuthorities: [HOST] });
    await ensureContainerConfig('ag-1', FIXTURE);
    const { decide } = captureDecide();

    const decision = await decide({
      id: 'req-authority-default',
      trigger: 'default',
      agentGroupId: 'ag-1',
      destination: { host: HOST, method: 'POST' },
      createdAt: now(),
      title: 'Network credentials request',
      question: 'irrelevant — never rendered for an auto-approval',
    });

    expect(decision).toBe('approve');
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)).toEqual([]);
  });

  it('still delivers a card for a policy-trigger request against the same declared authority', async () => {
    registerProviderHostContract(FIXTURE, { seamVersion: 1, modelAuthorities: [HOST] });
    await ensureContainerConfig('ag-1', FIXTURE);
    await seedApprover();
    const { decide } = captureDecide();

    const decisionPromise = decide({
      id: 'req-authority-policy',
      trigger: 'policy',
      agentGroupId: 'ag-1',
      destination: { host: HOST, method: 'POST' },
      createdAt: now(),
      title: 'Network credentials request',
      question: 'POST models.example.test:8000',
    });

    const row = await awaitCard();
    expect(row.action).toBe(GATEWAY_APPROVAL_ACTION);
    await resolveGatewayApproval(row.approval_id, 'approve');
    await expect(decisionPromise).resolves.toBe('approve');
  });
});

// #4015: an opted-in, wire-attested-payload-free read can skip the card only
// when the active provider's own live credentialScope() answers 'none' —
// fast and explicitly. Every other outcome (no opt-in, a payload, a 'credential'
// answer, a thrown error, a slow lookup, or no credentialScope at all) must
// keep the card. These are the fail-closed paths the feature's whole safety
// rests on, so each is tested as its own case rather than inferred.
describe('decide() auto-approval: configured reads and uncredentialed reads', () => {
  const HOST = 'models.example.test:8000';

  afterEach(() => {
    vi.unstubAllEnvs();
    resetGatewayProvider(null);
  });

  function captureDecideWith(
    credentialScope?: (destination: { host: string; method?: string }) => Promise<'credential' | 'none'>,
  ): { decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision> } {
    const captured: { decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision> } = {
      decide: async () => 'unavailable',
    };
    resetGatewayProvider({
      kind: 'fixture',
      agentSkills: [],
      sessions: {
        ensure: () => {
          throw new Error('not exercised by this test');
        },
      },
      approvals: {
        async subscribe(decide) {
          captured.decide = decide;
        },
        ...(credentialScope ? { credentialScope } : {}),
      },
    });
    startGatewayApprovalCoordinator(fakeAdapter);
    return captured;
  }

  const request = (overrides: Partial<GatewayApprovalRequest> = {}): GatewayApprovalRequest => ({
    id: 'req-uncredentialed-1',
    trigger: 'default',
    agentGroupId: 'ag-1',
    destination: { host: HOST, method: 'GET', sendsPayload: false },
    createdAt: now(),
    title: 'Network credentials request',
    question: 'GET models.example.test:8000',
    ...overrides,
  });

  describe('permitsConfiguredGatewayRead', () => {
    // Deliberately no port — permitsConfiguredGatewayRead matches bare
    // hostnames (stripping only an explicit, redundant :443), unlike
    // modelAuthorities' exact host:port match tested elsewhere.
    const CONFIGURED_HOST = 'status.example.test';

    it('auto-approves a default-trigger GET to an operator-configured read-only host, no provider needed', async () => {
      vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', CONFIGURED_HOST);
      const { decide } = captureDecideWith();

      const decision = await decide(request({ destination: { host: CONFIGURED_HOST, method: 'GET' } }));

      expect(decision).toBe('approve');
      expect(delivered).toHaveLength(0);
    });

    it('still delivers a card for a policy-trigger request to that same configured host', async () => {
      vi.stubEnv('NANOCLAW_GATEWAY_READ_ONLY_HOSTS', CONFIGURED_HOST);
      await seedApprover();
      const { decide } = captureDecideWith();

      const decisionPromise = decide(
        request({ trigger: 'policy', destination: { host: CONFIGURED_HOST, method: 'GET' } }),
      );

      const row = await awaitCard();
      await resolveGatewayApproval(row.approval_id, 'approve');
      await expect(decisionPromise).resolves.toBe('approve');
    });
  });

  it('auto-approves when opted in, the read sends no payload, and credentialScope answers none', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    const { decide } = captureDecideWith(async () => 'none');

    const decision = await decide(request());

    expect(decision).toBe('approve');
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction(GATEWAY_APPROVAL_ACTION)).toEqual([]);
  });

  it('keeps the card when not opted in, even if credentialScope would answer none', async () => {
    await seedApprover();
    const scope = vi.fn(async () => 'none' as const);
    const { decide } = captureDecideWith(scope);

    const decisionPromise = decide(request());
    const row = await awaitCard();

    expect(scope).not.toHaveBeenCalled();
    await resolveGatewayApproval(row.approval_id, 'approve');
    await expect(decisionPromise).resolves.toBe('approve');
  });

  it('keeps the card when the request is not attested payload-free', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    await seedApprover();
    const scope = vi.fn(async () => 'none' as const);
    const { decide } = captureDecideWith(scope);

    const decisionPromise = decide(request({ destination: { host: HOST, method: 'GET', sendsPayload: true } }));
    const row = await awaitCard();

    expect(scope).not.toHaveBeenCalled();
    await resolveGatewayApproval(row.approval_id, 'approve');
    await expect(decisionPromise).resolves.toBe('approve');
  });

  it('keeps the card when credentialScope answers credential', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    await seedApprover();
    const { decide } = captureDecideWith(async () => 'credential');

    const decisionPromise = decide(request());
    const row = await awaitCard();
    await resolveGatewayApproval(row.approval_id, 'approve');

    await expect(decisionPromise).resolves.toBe('approve');
  });

  it('fails closed (keeps the card) when credentialScope throws', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    await seedApprover();
    const { decide } = captureDecideWith(async () => {
      throw new Error('iron control unreachable');
    });

    const decisionPromise = decide(request());
    const row = await awaitCard();
    await resolveGatewayApproval(row.approval_id, 'approve');

    await expect(decisionPromise).resolves.toBe('approve');
  });

  it('fails closed (keeps the card) when credentialScope never settles, after its own timeout', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    await seedApprover();
    const { decide } = captureDecideWith(() => new Promise(() => {}));

    const decisionPromise = decide(request());
    await vi.advanceTimersByTimeAsync(5_000);
    const row = await awaitCardFake();
    await resolveGatewayApproval(row.approval_id, 'approve');

    await expect(decisionPromise).resolves.toBe('approve');
  });

  it('keeps the card when the active provider declares no credentialScope at all', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    await seedApprover();
    const { decide } = captureDecideWith(); // OneCLI's real shape: no credentialScope

    const decisionPromise = decide(request());
    const row = await awaitCard();
    await resolveGatewayApproval(row.approval_id, 'approve');

    await expect(decisionPromise).resolves.toBe('approve');
  });

  it('never auto-approves via credentialScope for a policy-trigger request, whatever the destination', async () => {
    vi.stubEnv('NANOCLAW_GATEWAY_UNCREDENTIALED_READS', 'true');
    await seedApprover();
    const scope = vi.fn(async () => 'none' as const);
    const { decide } = captureDecideWith(scope);

    const decisionPromise = decide(request({ trigger: 'policy' }));
    const row = await awaitCard();

    expect(scope).not.toHaveBeenCalled();
    await resolveGatewayApproval(row.approval_id, 'approve');
    await expect(decisionPromise).resolves.toBe('approve');
  });
});

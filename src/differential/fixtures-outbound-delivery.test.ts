/**
 * P2-03 fixture: outbound-delivery.
 *
 * Separated from fixtures.test.ts because this scenario needs delivery.js
 * REAL (not mocked) — it exercises `deliverSessionMessages` directly, so
 * only container-runner.js/config.js are mocked here, matching the other
 * fixtures' container-spawn prevention but leaving the delivery poll's own
 * logic (drainSession, markDelivered, the retry/attempts bookkeeping) live.
 *
 * Verification deliberately stays at the observable-contract boundary (see
 * docs/parity-schema.md's design principle): rather than reading
 * messages_out's delivered-state columns directly — internal detail this
 * fixture doesn't need and whose exact shape isn't grounded here — the
 * "delivered, not re-delivered" contract is proven by calling
 * `deliverSessionMessages` a SECOND time and asserting the fake adapter is
 * not invoked again. That is exactly the externally-observable effect
 * `markDelivered` exists to produce.
 *
 * P2-04 batch 2 adds two more fixtures to this file (same mock set, real
 * delivery.js): delivery-permanent-failure and delivery-retry-then-recovers,
 * both driven by a REAL business-logic failure — a detached messaging group
 * (mg.detached_at, migration 022) — rather than a synthetic throwing adapter,
 * so the retry/give-up contract is characterized against actual code, not a
 * fabricated error.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { setMessagingGroupDetachedAt } from '../db/messaging-groups.js';
import { IdNormalizer } from './normalize.js';
import type { ParityResult } from './types.js';

// `vi.mock` factories run before any of the file's own top-level statements
// (mocks are hoisted above even module-graph evaluation of static imports
// below) — a plain `const TEST_DIR = ...` referenced from inside the
// `../config.js` factory would throw "Cannot access before initialization".
// `vi.hoisted` hoists ALONGSIDE `vi.mock`, so TEST_DIR exists by the time
// that factory runs.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: '/tmp/nanoclaw-differential-fixtures-outbound-delivery' }));

// Prevent actual Docker spawning — this fixture never wakes a container, but
// mocks it anyway for consistency with every other fixture in this suite and
// in case a future delivery hook path touches it indirectly.
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  // initTestDb() only runs migrations conditionally (`if (db.prepareTestSchema)`)
  // — an explicit runMigrations() afterward is what actually guarantees the
  // schema exists, mirroring src/modules/permissions/sender-approval.test.ts's
  // identical two-call pattern.
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('P2-03 fixture: outbound-delivery', () => {
  it('delivers a directly-written outbound message exactly once', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const { resolveSession, writeOutboundDirect } = await import('../session-manager.js');
    const { setDeliveryAdapter, deliverSessionMessages } = await import('../delivery.js');

    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    const fakeDeliver = vi.fn().mockResolvedValue('platform-msg-1');
    setDeliveryAdapter({ deliver: fakeDeliver });

    const message = {
      id: 'msg-out-1',
      kind: 'chat',
      platformId: 'chan-123', // matches mg-1's platform_id — origin-chat delivery, no agent_destinations needed
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ text: 'Hello from the agent' }),
    };
    await writeOutboundDirect('ag-1', session.id, message);

    await deliverSessionMessages(session); // first drain: should deliver exactly once
    await deliverSessionMessages(session); // second drain: must NOT re-deliver (proves markDelivered stuck)

    expect(fakeDeliver).toHaveBeenCalledTimes(1);
    const [deliveredChannel, deliveredPlatformId, deliveredThreadId, deliveredKind, deliveredContent] =
      fakeDeliver.mock.calls[0];

    const ids = new IdNormalizer();
    const result: ParityResult = {
      scenario: 'outbound-delivery',
      session: {
        sessionId: ids.normalize('SESSION', session.id)!,
        created: true,
        sessionMode: 'shared',
        containerStatus: session.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: session.last_active !== null,
      },
      delivery: {
        outcome: 'delivered',
        target: { channelType: deliveredChannel, platformId: deliveredPlatformId, threadId: deliveredThreadId },
        attempts: 1,
      },
    };

    expect(deliveredKind).toBe('chat');
    expect(deliveredContent).toBe(message.content); // exact round-trip, no re-encoding
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: delivery-permanent-failure', () => {
  it('a detached messaging group fails delivery permanently after MAX_DELIVERY_ATTEMPTS (3)', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    // Our own bot left this conversation — delivery.ts throws on the detached
    // check (before ever reaching the adapter), which is the real,
    // grounded cause driving this fixture rather than a synthetic throw.
    await setMessagingGroupDetachedAt('mg-1', now());

    const { resolveSession, writeOutboundDirect } = await import('../session-manager.js');
    const { setDeliveryAdapter, deliverSessionMessages } = await import('../delivery.js');
    // The `delivered` table is host-owned and lives in inbound.db, not
    // outbound.db (schema.ts: INBOUND_SCHEMA declares it — outbound.db only
    // holds messages_out/processing_ack/session_state/container_state).
    const { inboundDbPath } = await import('../mailbox/sqlite/paths.js');
    const Database = (await import('better-sqlite3')).default;

    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    const fakeDeliver = vi.fn().mockResolvedValue('platform-msg-1');
    setDeliveryAdapter({ deliver: fakeDeliver });

    const message = {
      id: 'msg-out-detached-1',
      kind: 'chat',
      platformId: 'chan-123', // matches mg-1's own address — hits the origin-chat branch, which still checks detached_at
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ text: 'Hello from the agent' }),
    };
    await writeOutboundDirect('ag-1', session.id, message);

    // MAX_DELIVERY_ATTEMPTS = 3 (delivery.ts, module-private): the first two
    // drains fail and retry; the third crosses the threshold and gives up.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(fakeDeliver).not.toHaveBeenCalled(); // never reached — the detached check throws first

    const inDb = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
    const delivered = inDb
      .prepare('SELECT message_out_id, status FROM delivered WHERE message_out_id = ?')
      .get(message.id) as { message_out_id: string; status: string } | undefined;
    inDb.close();

    const ids = new IdNormalizer();
    const result: ParityResult = {
      scenario: 'delivery-permanent-failure',
      session: {
        sessionId: ids.normalize('SESSION', session.id)!,
        created: true,
        sessionMode: 'shared',
        containerStatus: session.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: session.last_active !== null,
      },
      delivery: {
        outcome: 'permanent-failure',
        target: { channelType: 'discord', platformId: 'chan-123', threadId: null },
        attempts: 3,
      },
    };

    expect(delivered).toBeDefined();
    expect(delivered!.status).toBe('failed'); // markDeliveryFailed's own status value
    expect(result).toMatchSnapshot();
  });
});

describe('P2-04 batch2 fixture: delivery-retry-then-recovers', () => {
  it('a retryable failure that clears before the attempt ceiling still delivers', async () => {
    await createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-123',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    await setMessagingGroupDetachedAt('mg-1', now());

    const { resolveSession, writeOutboundDirect } = await import('../session-manager.js');
    const { setDeliveryAdapter, deliverSessionMessages } = await import('../delivery.js');
    // The `delivered` table is host-owned and lives in inbound.db — see the
    // identical note in the delivery-permanent-failure fixture above.
    const { inboundDbPath } = await import('../mailbox/sqlite/paths.js');
    const Database = (await import('better-sqlite3')).default;

    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');

    const fakeDeliver = vi.fn().mockResolvedValue('platform-msg-recovered');
    setDeliveryAdapter({ deliver: fakeDeliver });

    const message = {
      id: 'msg-out-recovers-1',
      kind: 'chat',
      platformId: 'chan-123',
      channelType: 'discord',
      threadId: null,
      content: JSON.stringify({ text: 'Hello from the agent' }),
    };
    await writeOutboundDirect('ag-1', session.id, message);

    // Attempt 1: still detached — fails, but under MAX_DELIVERY_ATTEMPTS (3),
    // so it stays retryable (no `delivered` row of either status yet).
    await deliverSessionMessages(session);

    const inDbMid = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
    const midRow = inDbMid.prepare('SELECT message_out_id FROM delivered WHERE message_out_id = ?').get(message.id);
    inDbMid.close();
    expect(midRow).toBeUndefined(); // genuinely mid-retry: neither delivered nor given up

    // The bot rejoins the channel before the next poll tick.
    await setMessagingGroupDetachedAt('mg-1', null);

    // Attempt 2: succeeds now that the group is reattached.
    await deliverSessionMessages(session);

    expect(fakeDeliver).toHaveBeenCalledTimes(1); // only the successful attempt reaches the adapter

    const inDb = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
    const delivered = inDb
      .prepare('SELECT message_out_id, status FROM delivered WHERE message_out_id = ?')
      .get(message.id) as { message_out_id: string; status: string } | undefined;
    inDb.close();

    const ids = new IdNormalizer();
    const result: ParityResult = {
      scenario: 'delivery-retry-then-recovers',
      session: {
        sessionId: ids.normalize('SESSION', session.id)!,
        created: true,
        sessionMode: 'shared',
        containerStatus: session.container_status as 'stopped' | 'running' | 'idle',
        lastActiveTouched: session.last_active !== null,
      },
      delivery: {
        outcome: 'delivered',
        target: { channelType: 'discord', platformId: 'chan-123', threadId: null },
        attempts: 2, // one failed (retryable) attempt, then the successful one
      },
    };

    expect(delivered).toBeDefined();
    expect(delivered!.status).toBe('delivered');
    expect(result).toMatchSnapshot();
  });
});

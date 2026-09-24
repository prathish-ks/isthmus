/**
 * `transitionPendingApprovalStatus`'s CAS (compare-and-swap) atomicity,
 * against a real DB — the 2026-09-24 boundary audit's lowest-risk finding,
 * included for completeness: every existing test of "a dead grant refuses"
 * (`src/guard/guard.test.ts`) mocks `getPendingApproval`, and the
 * `UPDATE ... WHERE status = ?` guard this whole "approve exactly once"
 * property rests on had never actually been raced.
 *
 * Node is single-threaded and `better-sqlite3` is synchronous, so this
 * cannot force genuine OS-level thread interleaving the way a real
 * concurrent-request race would — that's a property of THIS runtime, not a
 * weaker test. What it does prove, faithfully, against the real driver: two
 * "approve" resolutions issued back to back (`Promise.all`, the same shape
 * two overlapping webhook deliveries would produce) — only one observes
 * `status = 'pending'` and wins the transition; the second's `WHERE status
 * = 'pending'` matches zero rows and correctly reports no change. That is
 * the actual mechanism `response-handler.ts` depends on to guarantee a
 * held action never executes twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createPendingApproval, getPendingApproval, transitionPendingApprovalStatus } from '../db/sessions.js';
import type { PendingApproval } from '../types.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approval_id: 'appr-race-1',
    session_id: null,
    request_id: 'req-race-1',
    action: 'install_packages',
    payload: '{}',
    created_at: new Date().toISOString(),
    agent_group_id: null,
    channel_type: null,
    platform_id: null,
    instance: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'Install packages',
    question: 'Install packages?',
    options_json: '[]',
    approver_user_id: null,
    ...overrides,
  };
}

describe('transitionPendingApprovalStatus — approve exactly once', () => {
  it('exactly one of two concurrent pending→approved transitions succeeds', async () => {
    await createPendingApproval(approval());

    const [first, second] = await Promise.all([
      transitionPendingApprovalStatus('appr-race-1', 'pending', 'approved'),
      transitionPendingApprovalStatus('appr-race-1', 'pending', 'approved'),
    ]);

    // Exactly one true, one false — never both true (double-execution) and
    // never both false (the approval silently never resolves).
    expect([first, second].filter(Boolean)).toHaveLength(1);

    const row = await getPendingApproval('appr-race-1');
    expect(row?.status).toBe('approved');
  });

  it('a transition against an already-resolved row is a correctly-reported no-op, not an error', async () => {
    await createPendingApproval(approval());
    expect(await transitionPendingApprovalStatus('appr-race-1', 'pending', 'approved')).toBe(true);

    // The second "approve" click, arriving after resolution — the exact
    // scenario the CAS exists to make safe.
    const replayed = await transitionPendingApprovalStatus('appr-race-1', 'pending', 'approved');
    expect(replayed).toBe(false);

    const row = await getPendingApproval('appr-race-1');
    expect(row?.status).toBe('approved');
  });

  it('ten concurrent transitions on the same row: exactly one wins', async () => {
    // A larger fan-out than the pairwise case above, to make sure "exactly
    // one" isn't an artifact of only ever racing two calls.
    await createPendingApproval(approval({ approval_id: 'appr-race-fanout' }));

    const results = await Promise.all(
      Array.from({ length: 10 }, () => transitionPendingApprovalStatus('appr-race-fanout', 'pending', 'approved')),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

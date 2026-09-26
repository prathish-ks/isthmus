import type { Migration } from './index.js';

/**
 * Durable host-coordination state. v2.4.0 promotion, Workstream C9 (ADR-030):
 * ported from upstream, which introduces this schema calling every table
 * "shadow surface... the in-memory maps stay authoritative until a follow-up
 * flips authority." That framing is stale for `host_instances`/
 * `session_claims` specifically — reading `container-runner.ts`'s own
 * `claimSessionRun` (the function these tables exist to back) shows the flip
 * already happened in the same release: a claim held by a live peer host
 * (read via `getLiveHostInstance`) genuinely refuses a spawn, not merely a
 * dual-write. `delivery_attempts` and `wake_signals` remain unconsumed by
 * anything in this tree (their own upstream consumers — `reconcile-*.ts`,
 * `request-wake.ts` — are a separate, still-inert concern this promotion has
 * not adopted; see `docs/promotion-v2.4.0.md` Workstream B), so those two
 * tables are genuinely still shadow surface here, same as upstream.
 *
 * - `host_instances` — one row per live host process (lease). Lease expiry is
 *   compared as ISO-8601 strings; renewal is the host's heartbeat.
 * - `session_claims` — per-session incarnation fencing + durable stop intent.
 *   `incarnation` increments per container start; a compare-and-set on it is
 *   the spawn-dedup / stale-`finish()` fence. `stop_intent` outlives a host
 *   restart (`respawn_after_stop` replaces the volatile on-wake promise).
 * - `delivery_attempts` — outbound retry counts + backoff schedule, keyed by
 *   mailbox message id. `delivered` stays mailbox-side; only attempt
 *   bookkeeping lives here.
 * - `wake_signals` — durable "session has reason to wake" rows, written where
 *   mail is written and consumed by the wake path. Text ids (uuid) — no
 *   AUTOINCREMENT, the schema stays portable.
 */
export const migration024: Migration = {
  version: 24,
  name: 'host-coordination',
  async up(db) {
    await db.exec(`
      CREATE TABLE host_instances (
        instance_id TEXT PRIMARY KEY,
        install_id TEXT NOT NULL,
        hostname TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        stopped_at TEXT
      );

      CREATE TABLE session_claims (
        session_id TEXT PRIMARY KEY,
        incarnation INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        claimed_at TEXT,
        container_ref TEXT,
        stop_intent TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE delivery_attempts (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_at TEXT,
        last_error TEXT
      );
      CREATE INDEX idx_delivery_attempts_session ON delivery_attempts(session_id);

      CREATE TABLE wake_signals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        consumed_by TEXT
      );
      CREATE INDEX idx_wake_signals_session_pending ON wake_signals(session_id, consumed_at);
    `);
  },
};

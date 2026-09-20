/**
 * Coverage-uplift tests for mailbox/sqlite/session-db.ts targeting branches
 * the pre-existing session-db.test.ts suite doesn't reach: getContainerState's
 * happy path (a row actually present), and migrateDeliveredTable's two
 * ALTER-TABLE branches (columns genuinely missing, not already present).
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { getContainerState, migrateDeliveredTable } from './session-db.js';

describe('getContainerState', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('returns the row when container_state has a value', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(OUTBOUND_SCHEMA);
    db.prepare(
      `INSERT INTO container_state (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
       VALUES (1, 'Bash', 120000, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z')`,
    ).run();
    const state = getContainerState(db);
    expect(state).toEqual({
      current_tool: 'Bash',
      tool_declared_timeout_ms: 120000,
      tool_started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
    });
  });
});

describe('migrateDeliveredTable', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('adds platform_message_id and status columns when genuinely missing', () => {
    const db = new Database(':memory:');
    databases.push(db);
    // A pre-migration "delivered" table shape, missing both later columns.
    db.exec(`
      CREATE TABLE delivered (
        message_out_id TEXT PRIMARY KEY,
        delivered_at   TEXT NOT NULL
      );
    `);
    migrateDeliveredTable(db);
    const cols = new Set(
      (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('platform_message_id')).toBe(true);
    expect(cols.has('status')).toBe(true);

    db.prepare(
      "INSERT INTO delivered (message_out_id, delivered_at, platform_message_id, status) VALUES ('o-1', datetime('now'), 'pm-1', 'delivered')",
    ).run();
    const row = db.prepare("SELECT status FROM delivered WHERE message_out_id = 'o-1'").get() as { status: string };
    expect(row.status).toBe('delivered');
  });

  it('is a no-op when the columns already exist (baseline schema)', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(INBOUND_SCHEMA);
    db.exec(OUTBOUND_SCHEMA);
    // OUTBOUND_SCHEMA already ships `delivered` with both columns present.
    expect(() => migrateDeliveredTable(db)).not.toThrow();
  });
});

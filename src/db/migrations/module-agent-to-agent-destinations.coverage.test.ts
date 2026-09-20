/**
 * Coverage-uplift tests for
 * db/migrations/module-agent-to-agent-destinations.ts's backfill logic.
 * Like migration010, the standard test-DB bootstrap always runs this
 * migration against empty messaging_group_agents/messaging_groups tables
 * (it runs early, before any test seeds wirings), so the backfill loop and
 * its local-name collision-suffix branch are never exercised by the
 * pre-existing suite. Constructs the minimal pre-migration table shapes
 * directly and runs the migration's up() against real wiring rows.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';

// `Migration` is a union of the portable (DbDriver) and sqlite-only
// (Database.Database) shapes, so calling `.up()` through the union type
// requires an argument assignable to both — `DbDriver & Database`. This
// migration is declared `sqliteOnly: true` and its real `up()` only ever
// touches `Database.Database` methods, so narrow the type here rather than
// construct an unused DbDriver wrapper just to satisfy the union.
const up = moduleAgentToAgentDestinations.up as (db: Database.Database) => void;

function makeLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
    CREATE TABLE messaging_groups (
      id           TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      name         TEXT
    );
    CREATE TABLE messaging_group_agents (
      id                 TEXT PRIMARY KEY,
      agent_group_id     TEXT NOT NULL,
      messaging_group_id TEXT NOT NULL
    );
  `);
  return db;
}

function destinations(db: Database.Database, agentGroupId: string): Array<{ local_name: string; target_id: string }> {
  return db
    .prepare('SELECT local_name, target_id FROM agent_destinations WHERE agent_group_id = ? ORDER BY local_name')
    .all(agentGroupId) as Array<{ local_name: string; target_id: string }>;
}

describe('moduleAgentToAgentDestinations backfill', () => {
  it('creates one destination per existing wiring, named after the messaging group', () => {
    const db = makeLegacyDb();
    db.prepare("INSERT INTO agent_groups (id) VALUES ('ag-1')").run();
    db.prepare("INSERT INTO messaging_groups (id, channel_type, name) VALUES ('mg-1', 'slack', 'General')").run();
    db.prepare(
      "INSERT INTO messaging_group_agents (id, agent_group_id, messaging_group_id) VALUES ('mga-1', 'ag-1', 'mg-1')",
    ).run();

    up(db);

    expect(destinations(db, 'ag-1')).toEqual([{ local_name: 'general', target_id: 'mg-1' }]);
  });

  it('falls back to <channel_type>-<id prefix> when the messaging group has no name', () => {
    const db = makeLegacyDb();
    db.prepare("INSERT INTO agent_groups (id) VALUES ('ag-2')").run();
    db.prepare(
      "INSERT INTO messaging_groups (id, channel_type, name) VALUES ('mg-abcdefgh12', 'telegram', NULL)",
    ).run();
    db.prepare(
      "INSERT INTO messaging_group_agents (id, agent_group_id, messaging_group_id) VALUES ('mga-2', 'ag-2', 'mg-abcdefgh12')",
    ).run();

    up(db);

    expect(destinations(db, 'ag-2')).toEqual([{ local_name: 'telegram-mg-abcde', target_id: 'mg-abcdefgh12' }]);
  });

  it('appends a numeric suffix when two wirings normalize to the same local name for one agent', () => {
    const db = makeLegacyDb();
    db.prepare("INSERT INTO agent_groups (id) VALUES ('ag-3')").run();
    db.prepare("INSERT INTO messaging_groups (id, channel_type, name) VALUES ('mg-3a', 'slack', 'General')").run();
    db.prepare("INSERT INTO messaging_groups (id, channel_type, name) VALUES ('mg-3b', 'slack', 'General')").run();
    db.prepare(
      "INSERT INTO messaging_group_agents (id, agent_group_id, messaging_group_id) VALUES ('mga-3a', 'ag-3', 'mg-3a')",
    ).run();
    db.prepare(
      "INSERT INTO messaging_group_agents (id, agent_group_id, messaging_group_id) VALUES ('mga-3b', 'ag-3', 'mg-3b')",
    ).run();

    up(db);

    expect(destinations(db, 'ag-3')).toEqual([
      { local_name: 'general', target_id: 'mg-3a' },
      { local_name: 'general-2', target_id: 'mg-3b' },
    ]);
  });

  it('scopes name collisions per agent — two different agents may both use "general"', () => {
    const db = makeLegacyDb();
    db.prepare("INSERT INTO agent_groups (id) VALUES ('ag-4a'), ('ag-4b')").run();
    db.prepare("INSERT INTO messaging_groups (id, channel_type, name) VALUES ('mg-4', 'slack', 'General')").run();
    db.prepare(
      "INSERT INTO messaging_group_agents (id, agent_group_id, messaging_group_id) VALUES ('mga-4a', 'ag-4a', 'mg-4'), ('mga-4b', 'ag-4b', 'mg-4')",
    ).run();

    up(db);

    expect(destinations(db, 'ag-4a')).toEqual([{ local_name: 'general', target_id: 'mg-4' }]);
    expect(destinations(db, 'ag-4b')).toEqual([{ local_name: 'general', target_id: 'mg-4' }]);
  });

  it('creates the table with no rows when there are no existing wirings', () => {
    const db = makeLegacyDb();
    expect(() => up(db)).not.toThrow();
    const count = db.prepare('SELECT COUNT(*) AS c FROM agent_destinations').get() as { c: number };
    expect(count.c).toBe(0);
  });
});

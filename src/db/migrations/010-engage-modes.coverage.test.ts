/**
 * Coverage-uplift tests for db/migrations/010-engage-modes.ts's backfill
 * logic. The standard test-DB bootstrap (initTestDb + runMigrations) always
 * runs this migration against an EMPTY messaging_group_agents table (no
 * pre-existing wirings, since it runs early in the migration sequence
 * before any test seeds data) — the pre-existing suite therefore never
 * hits backfill()'s branches. Constructs a raw pre-migration-10 table
 * shape directly and runs migration010.up() against real legacy rows.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration010 } from './010-engage-modes.js';

// `Migration` is a union of the portable (DbDriver) and sqlite-only
// (Database.Database) shapes, so calling `.up()` through the union type
// requires an argument assignable to both — `DbDriver & Database`. This
// migration is declared `sqliteOnly: true` and its real `up()` only ever
// touches `Database.Database` methods, so narrow the type here rather than
// construct an unused DbDriver wrapper just to satisfy the union.
const up = migration010.up as (db: Database.Database) => void;

function makeLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messaging_group_agents (
      id              TEXT PRIMARY KEY,
      trigger_rules   TEXT,
      response_scope  TEXT
    );
  `);
  return db;
}

function row(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM messaging_group_agents WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('migration010 (engage-modes) backfill', () => {
  it('maps a non-empty trigger_rules.pattern to engage_mode=pattern', () => {
    const db = makeLegacyDb();
    db.prepare('INSERT INTO messaging_group_agents (id, trigger_rules, response_scope) VALUES (?, ?, ?)').run(
      'a',
      JSON.stringify({ pattern: 'hello.*' }),
      'public',
    );
    up(db);
    expect(row(db, 'a')).toMatchObject({
      engage_mode: 'pattern',
      engage_pattern: 'hello.*',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
    });
  });

  it('maps requiresTrigger=false to always-match pattern', () => {
    const db = makeLegacyDb();
    db.prepare('INSERT INTO messaging_group_agents (id, trigger_rules, response_scope) VALUES (?, ?, ?)').run(
      'b',
      JSON.stringify({ requiresTrigger: false }),
      null,
    );
    up(db);
    expect(row(db, 'b')).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });
  });

  it('maps response_scope=all to always-match pattern even without requiresTrigger', () => {
    const db = makeLegacyDb();
    db.prepare('INSERT INTO messaging_group_agents (id, trigger_rules, response_scope) VALUES (?, ?, ?)').run(
      'c',
      null,
      'all',
    );
    up(db);
    expect(row(db, 'c')).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });
  });

  it('falls back to engage_mode=mention when nothing else matches', () => {
    const db = makeLegacyDb();
    db.prepare('INSERT INTO messaging_group_agents (id, trigger_rules, response_scope) VALUES (?, ?, ?)').run(
      'd',
      null,
      'private',
    );
    up(db);
    expect(row(db, 'd')).toMatchObject({ engage_mode: 'mention', engage_pattern: null });
  });

  it('maps response_scope=allowlisted to sender_scope=known', () => {
    const db = makeLegacyDb();
    db.prepare('INSERT INTO messaging_group_agents (id, trigger_rules, response_scope) VALUES (?, ?, ?)').run(
      'e',
      null,
      'allowlisted',
    );
    up(db);
    expect(row(db, 'e')).toMatchObject({ sender_scope: 'known' });
  });

  it('falls through to conservative defaults on invalid trigger_rules JSON', () => {
    const db = makeLegacyDb();
    db.prepare('INSERT INTO messaging_group_agents (id, trigger_rules, response_scope) VALUES (?, ?, ?)').run(
      'f',
      '{ not valid json',
      null,
    );
    up(db);
    expect(row(db, 'f')).toMatchObject({ engage_mode: 'mention', engage_pattern: null, sender_scope: 'all' });
  });

  it('drops the legacy columns and backfills zero rows on an empty table', () => {
    const db = makeLegacyDb();
    up(db);
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('trigger_rules')).toBe(false);
    expect(cols.has('response_scope')).toBe(false);
    expect(cols.has('engage_mode')).toBe(true);
  });
});

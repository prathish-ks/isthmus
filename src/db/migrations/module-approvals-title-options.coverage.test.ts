/**
 * Coverage-uplift tests for
 * db/migrations/module-approvals-title-options.ts. In the standard test-DB
 * bootstrap, migration 003 always creates `pending_approvals` with `title`
 * and `options_json` already present (the current definition), so this
 * migration's ALTER always fails with "duplicate column" and the
 * pre-existing suite never reaches the success path (columns genuinely
 * missing) or the rethrow path (a real, unrelated SQL error).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';

// `Migration` is a union of the portable (DbDriver) and sqlite-only
// (Database.Database) shapes, so calling `.up()` through the union type
// requires an argument assignable to both — `DbDriver & Database`. This
// migration is declared `sqliteOnly: true` and its real `up()` only ever
// touches `Database.Database` methods, so narrow the type here rather than
// construct an unused DbDriver wrapper just to satisfy the union.
const up = moduleApprovalsTitleOptions.up as (db: Database.Database) => void;

describe('moduleApprovalsTitleOptions', () => {
  it('adds title and options_json when genuinely missing (old-install shape)', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY
      );
    `);
    up(db);
    const cols = new Set(
      (db.prepare("PRAGMA table_info('pending_approvals')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(cols.has('title')).toBe(true);
    expect(cols.has('options_json')).toBe(true);
    db.close();
  });

  it('is a no-op (swallows the error) when both columns already exist', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE pending_approvals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        options_json TEXT NOT NULL DEFAULT '[]'
      );
    `);
    expect(() => up(db)).not.toThrow();
    db.close();
  });

  it('rethrows an unrelated SQL error (table does not exist)', () => {
    const db = new Database(':memory:');
    // No pending_approvals table at all — the ALTER fails with "no such
    // table", which does not match the swallowed "duplicate column" /
    // "already exists" substrings, so the migration must rethrow.
    expect(() => up(db)).toThrow(/no such table/);
    db.close();
  });
});

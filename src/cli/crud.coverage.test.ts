import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Swappable DB handle: the real test DB by default, a scripted stub for the
// create-race branch (UNIQUE violation after the natural-key pre-check).
const dbOverride = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));
vi.mock('../db/connection.js', async () => {
  const actual = await vi.importActual<typeof import('../db/connection.js')>('../db/connection.js');
  return { ...actual, getDb: () => dbOverride.current ?? actual.getDb() };
});

import { initTestDb, closeDb, getDb, runMigrations } from '../db/index.js';
import { getResource, getResources, registerResource, validateArgs } from './crud.js';
import { lookup } from './registry.js';

const hostCtx = { caller: 'host' as const };

const preUpdateCalls: Array<{ updates: Record<string, unknown>; current: Record<string, unknown> }> = [];
registerResource({
  name: 'covitem',
  plural: 'covitems',
  table: 'covitems',
  description: 'Synthetic resource covering every generic handler branch.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'ID.', generated: true },
    { name: 'name', type: 'string', description: 'Name.', required: true, updatable: true },
    { name: 'kind', type: 'string', description: 'Kind.', enum: ['a', 'b'], default: 'a', updatable: true },
    { name: 'score', type: 'number', description: 'Score.', default: 0, updatable: true },
    { name: 'flag', type: 'boolean', description: 'Flag.', default: 0 },
    { name: 'alias', type: 'string', description: 'Alias.', defaultFrom: 'name' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'open', update: 'open', delete: 'open' },
  preUpdate: (updates, current) => {
    preUpdateCalls.push({ updates, current });
    if (updates.name === 'reject-me') throw new Error('preUpdate rejected');
  },
});

// No timestamp column and no listOrder → ordered by the id column; no preUpdate.
registerResource({
  name: 'covplain',
  plural: 'covplains',
  table: 'covplains',
  description: 'Plain resource.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'ID.', generated: true },
    { name: 'label', type: 'string', description: 'Label.', updatable: true },
  ],
  operations: { list: 'open', update: 'open' },
});

// Explicit listOrder wins over the derived default.
registerResource({
  name: 'covordered',
  plural: 'covordereds',
  table: 'covplains',
  description: 'Explicit order.',
  idColumn: 'id',
  listOrder: 'label DESC',
  columns: [
    { name: 'id', type: 'string', description: 'ID.', generated: true },
    { name: 'label', type: 'string', description: 'Label.' },
  ],
  operations: { list: 'open' },
});

const hooks = { postCreate: vi.fn(), postCommit: vi.fn() };
registerResource({
  name: 'covnat',
  plural: 'covnats',
  table: 'covnats',
  description: 'Natural-key resource.',
  idColumn: 'id',
  naturalKey: ['k'],
  columns: [
    { name: 'id', type: 'string', description: 'ID.', generated: true },
    { name: 'k', type: 'string', description: 'Natural key.', required: true },
    { name: 'u', type: 'string', description: 'Other unique column.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { create: 'open' },
  postCreate: (row) => hooks.postCreate({ ...row }),
  postCommit: (row) => hooks.postCommit({ ...row }),
});

registerResource({
  name: 'covstrict',
  plural: 'covstricts',
  table: 'covnats',
  description: 'Custom op with strict args.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    'do thing': {
      access: 'open',
      description: 'Do a thing.',
      args: [{ name: 'count', type: 'number', description: 'How many.', required: true }],
      handler: async (args) => ({ got: args }),
    },
    lenient: {
      access: 'open',
      description: 'Lenient op.',
      handler: async (args) => ({ got: args }),
    },
  },
});

beforeEach(async () => {
  dbOverride.current = null;
  preUpdateCalls.length = 0;
  hooks.postCreate.mockClear();
  hooks.postCommit.mockClear();
  const db = await initTestDb({ fresh: true });
  await runMigrations(db);
  await db.exec(
    `CREATE TABLE covitems (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, score INTEGER, flag INTEGER, alias TEXT, created_at TEXT NOT NULL);
     CREATE TABLE covplains (id TEXT PRIMARY KEY, label TEXT);
     CREATE TABLE covnats (id TEXT PRIMARY KEY, k TEXT UNIQUE, u TEXT UNIQUE, created_at TEXT NOT NULL);`,
  );
});

afterEach(async () => {
  dbOverride.current = null;
  await closeDb();
});

async function seedItems(): Promise<void> {
  const sql = 'INSERT INTO covitems (id, name, kind, score, flag, alias, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)';
  await getDb().run(sql, 'i1', 'one', 'a', 1, 1, 'one', '2026-01-01T00:00:00.000Z');
  await getDb().run(sql, 'i2', 'two', 'b', 2, 0, 'two', '2026-01-02T00:00:00.000Z');
  await getDb().run(sql, 'i3', 'three', 'a', 3, 0, 'three', '2026-01-03T00:00:00.000Z');
}

describe('resource registry', () => {
  it('getResources sorts by plural; getResource looks up one', () => {
    const plurals = getResources().map((r) => r.plural);
    expect(plurals).toEqual([...plurals].sort((a, b) => a.localeCompare(b)));
    expect(getResource('covitems')?.name).toBe('covitem');
    expect(getResource('nope')).toBeUndefined();
  });

  it('generic parseArgs normalizes dashed flags to underscores for every verb', () => {
    for (const verb of ['list', 'get', 'create', 'update', 'delete']) {
      expect(lookup(`covitems-${verb}`)!.parseArgs({ 'some-key': 'v', id: 'x' })).toEqual({ some_key: 'v', id: 'x' });
    }
    expect(lookup('covstricts-lenient')!.parseArgs({ 'a-b': 1 })).toEqual({ a_b: 1 });
    expect(lookup('covstricts-do-thing')!.action).toBe('covstricts.do.thing');
  });

  it('strict custom-op parseArgs appends the verb usage block to validation errors', () => {
    expect(() => lookup('covstricts-do-thing')!.parseArgs({})).toThrow(
      /^--count is required\n\nncl covstricts do thing\n\nDo a thing\./,
    );
    expect(lookup('covstricts-do-thing')!.parseArgs({ count: '3' })).toEqual({ count: 3 });
  });
});

describe('genericList', () => {
  beforeEach(seedItems);
  const list = (args: Record<string, unknown>) =>
    lookup('covitems-list')!.handler(args, hostCtx) as Promise<Array<{ id: string }>>;

  it('orders newest first by the timestamp column and honours --limit', async () => {
    expect((await list({})).map((r) => r.id)).toEqual(['i3', 'i2', 'i1']);
    expect((await list({ limit: '2' })).map((r) => r.id)).toEqual(['i3', 'i2']);
    expect((await list({ limit: 0 })).map((r) => r.id)).toEqual(['i3']); // clamps to >= 1
  });

  it('ignores id/limit keys and unknown keys as filters; applies string filters', async () => {
    expect((await list({ id: 'i1', bogus: 'x' })).map((r) => r.id)).toEqual(['i3', 'i2', 'i1']);
    expect((await list({ name: 'two' })).map((r) => r.id)).toEqual(['i2']);
    expect((await list({ kind: 'a', score: '3' })).map((r) => r.id)).toEqual(['i3']);
  });

  it('coerces boolean filters in every accepted spelling and rejects others', async () => {
    for (const truthy of [true, 'true', '1', 1])
      expect((await list({ flag: truthy })).map((r) => r.id)).toEqual(['i1']);
    for (const falsy of [false, 'false', '0', 0]) {
      expect((await list({ flag: falsy })).map((r) => r.id)).toEqual(['i3', 'i2']);
    }
    await expect(list({ flag: 'maybe' })).rejects.toThrow('--flag must be true or false');
    await expect(list({ score: 'NaN' })).rejects.toThrow('--score must be a number');
  });

  it('falls back to the id column when no timestamp column exists, and honours listOrder', async () => {
    await getDb().run('INSERT INTO covplains (id, label) VALUES (?, ?), (?, ?)', 'p2', 'alpha', 'p1', 'zeta');
    const plain = (await lookup('covplains-list')!.handler({}, hostCtx)) as Array<{ id: string }>;
    expect(plain.map((r) => r.id)).toEqual(['p1', 'p2']);
    const ordered = (await lookup('covordereds-list')!.handler({}, hostCtx)) as Array<{ id: string }>;
    expect(ordered.map((r) => r.id)).toEqual(['p1', 'p2']); // zeta before alpha
  });
});

describe('genericGet', () => {
  beforeEach(seedItems);
  const get = (args: Record<string, unknown>) => lookup('covitems-get')!.handler(args, hostCtx);

  it('requires an id, reports missing rows, and returns the visible columns', async () => {
    await expect(get({})).rejects.toThrow('covitem id is required');
    await expect(get({ id: 'zz' })).rejects.toThrow('covitem not found: zz');
    expect(await get({ id: 'i2' })).toEqual({
      id: 'i2',
      name: 'two',
      kind: 'b',
      score: 2,
      flag: 0,
      alias: 'two',
      created_at: '2026-01-02T00:00:00.000Z',
    });
  });
});

describe('genericCreate', () => {
  const create = (args: Record<string, unknown>) =>
    lookup('covitems-create')!.handler(args, hostCtx) as Promise<Record<string, unknown>>;

  it('rejects enum violations and missing required columns', async () => {
    await expect(create({ name: 'x', kind: 'zzz' })).rejects.toThrow('kind must be one of: a, b');
    await expect(create({ kind: 'a' })).rejects.toThrow('--name is required');
  });

  it('generates id/created_at, coerces numbers, and fills static and defaultFrom defaults', async () => {
    const row = await create({ name: 'n', score: '7' });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.created_at).toMatch(/Z$/);
    expect(row).toMatchObject({ name: 'n', kind: 'a', score: 7, flag: 0, alias: 'n' });
    const stored = await getDb().get('SELECT * FROM covitems WHERE id = ?', row.id);
    expect(stored).toEqual(row);
  });

  it('natural-key create runs postCreate inside the transaction and postCommit after it', async () => {
    const row = await lookup('covnats-create')!.handler({ k: 'k1', u: 'u1' }, hostCtx);
    expect(hooks.postCreate).toHaveBeenCalledWith(expect.objectContaining({ k: 'k1' }));
    expect(hooks.postCommit).toHaveBeenCalledWith(expect.objectContaining({ k: 'k1' }));
    // Re-running returns the existing row and skips both hooks.
    hooks.postCreate.mockClear();
    hooks.postCommit.mockClear();
    const again = await lookup('covnats-create')!.handler({ k: 'k1', u: 'other' }, hostCtx);
    expect(again).toEqual(row);
    expect(hooks.postCreate).not.toHaveBeenCalled();
    expect(hooks.postCommit).not.toHaveBeenCalled();
  });

  it('a UNIQUE violation on a non-natural-key column is rethrown (no race row to return)', async () => {
    await lookup('covnats-create')!.handler({ k: 'k1', u: 'shared' }, hostCtx);
    await expect(lookup('covnats-create')!.handler({ k: 'k2', u: 'shared' }, hostCtx)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    expect(hooks.postCommit).toHaveBeenCalledTimes(1);
  });

  it('a natural-key race (row appears between pre-check and INSERT) returns the winner', async () => {
    const winner = { id: 'w', k: 'k9', u: null, created_at: 'ts' };
    let gets = 0;
    const stub = {
      get: vi.fn(async () => (gets++ === 0 ? undefined : winner)),
      run: vi.fn(async () => {
        throw Object.assign(new Error('dup'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }),
      transaction: async (fn: () => Promise<unknown>) => fn(),
    };
    dbOverride.current = stub;
    const out = await lookup('covnats-create')!.handler({ k: 'k9' }, hostCtx);
    expect(out).toBe(winner);
    expect(stub.get).toHaveBeenCalledTimes(2);
    expect(hooks.postCreate).not.toHaveBeenCalled();
    expect(hooks.postCommit).not.toHaveBeenCalled();
  });

  it('non-unique errors inside the transaction are rethrown untouched', async () => {
    const boom = new Error('disk on fire');
    dbOverride.current = {
      get: vi.fn(async () => undefined),
      run: vi.fn(async () => {
        throw boom;
      }),
      transaction: async (fn: () => Promise<unknown>) => fn(),
    };
    await expect(lookup('covnats-create')!.handler({ k: 'k9' }, hostCtx)).rejects.toBe(boom);
  });
});

describe('genericUpdate', () => {
  beforeEach(seedItems);
  const update = (args: Record<string, unknown>) => lookup('covitems-update')!.handler(args, hostCtx);

  it('validates id, enums, and the non-empty update set', async () => {
    await expect(update({})).rejects.toThrow('covitem id is required');
    await expect(update({ id: 'i1', kind: 'zzz' })).rejects.toThrow('kind must be one of: a, b');
    await expect(update({ id: 'i1', alias: 'not-updatable' })).rejects.toThrow(
      'nothing to update — provide at least one of: --name, --kind, --score',
    );
  });

  it('runs preUpdate with the current row and rejects missing rows before touching anything', async () => {
    await expect(update({ id: 'zz', name: 'n' })).rejects.toThrow('covitem not found: zz');
    expect(preUpdateCalls).toHaveLength(0);
    await expect(update({ id: 'i1', name: 'reject-me' })).rejects.toThrow('preUpdate rejected');
    expect(preUpdateCalls[0].current).toMatchObject({ id: 'i1', name: 'one' });
    expect((await getDb().get<{ name: string }>('SELECT name FROM covitems WHERE id = ?', 'i1'))!.name).toBe('one');
  });

  it('applies number coercion and returns the fresh row', async () => {
    const row = await update({ id: 'i1', score: '42', name: 'uno' });
    expect(row).toMatchObject({ id: 'i1', name: 'uno', score: 42, kind: 'a' });
  });

  it('reports not-found from the UPDATE itself when there is no preUpdate hook', async () => {
    await expect(lookup('covplains-update')!.handler({ id: 'missing', label: 'x' }, hostCtx)).rejects.toThrow(
      'covplain not found: missing',
    );
  });
});

describe('genericDelete', () => {
  beforeEach(seedItems);
  const del = (args: Record<string, unknown>) => lookup('covitems-delete')!.handler(args, hostCtx);

  it('requires an id, reports missing rows, and deletes exactly one row', async () => {
    await expect(del({})).rejects.toThrow('covitem id is required');
    await expect(del({ id: 'zz' })).rejects.toThrow('covitem not found: zz');
    expect(await del({ id: 'i2' })).toEqual({ deleted: 'i2' });
    const left = await getDb().all<{ id: string }>('SELECT id FROM covitems ORDER BY id');
    expect(left.map((r) => r.id)).toEqual(['i1', 'i3']);
  });
});

describe('validateArgs', () => {
  const defs = [
    { name: 'on', type: 'boolean' as const, description: 'b' },
    { name: 'n', type: 'number' as const, description: 'n', default: 5 },
    { name: 'j', type: 'json' as const, description: 'j' },
    { name: 's', type: 'string' as const, description: 's', enum: ['x', 'y'] },
  ];

  it('accepts boolean spellings, applies defaults, parses JSON, and coerces strings', () => {
    expect(validateArgs(defs, { on: 'false' })).toEqual({ on: false, n: 5 });
    expect(validateArgs(defs, { on: '0' })).toEqual({ on: false, n: 5 });
    expect(validateArgs(defs, { on: false })).toEqual({ on: false, n: 5 });
    expect(validateArgs(defs, { on: true, n: '2', j: '{"a":1}', s: 'x' })).toEqual({
      on: true,
      n: 2,
      j: { a: 1 },
      s: 'x',
    });
    // Already-parsed JSON (from --stdin-json) passes through.
    expect(validateArgs(defs, { j: { b: 2 } })).toEqual({ j: { b: 2 }, n: 5 });
  });

  it('rejects bad booleans, numbers, JSON, enums, value-less flags, and unknown flags', () => {
    expect(() => validateArgs(defs, { on: 'maybe' })).toThrow('--on must be true or false, got "maybe"');
    expect(() => validateArgs(defs, { n: 'abc' })).toThrow('--n must be a number, got "abc"');
    expect(() => validateArgs(defs, { j: '{bad' })).toThrow('--j must be valid JSON');
    expect(() => validateArgs(defs, { s: 'z' })).toThrow('--s must be one of: x, y');
    expect(() => validateArgs(defs, { s: true })).toThrow('--s requires a value');
    expect(() => validateArgs(defs, { nope_flag: 1 })).toThrow('unknown flag --nope-flag');
  });

  it('tolerates dispatcher-injected keys by default and only allowExtra when given', () => {
    expect(validateArgs(defs, { id: 'x', agent_group_id: 'g', group: 'g' })).toMatchObject({ id: 'x' });
    expect(() => validateArgs(defs, { id: 'x' }, { allowExtra: ['other'] })).toThrow('unknown flag --id');
    expect(validateArgs(defs, { other: 1 }, { allowExtra: ['other'] })).toMatchObject({ other: 1 });
  });
});

import { describe, it, expect } from 'vitest';

import type { ResourceDef } from './crud.js';
import { flagName, indent, listVerbs, renderVerbHelp, summaryLine } from './help-render.js';

const res: ResourceDef = {
  name: 'widget',
  plural: 'widgets',
  table: 'widgets',
  description: 'Widget resource.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'display_name', type: 'string', description: 'Name.\nSecond paragraph.', required: true, updatable: true },
    { name: 'mode', type: 'string', description: 'Mode.', enum: ['a', 'b'], default: 'a' },
    { name: 'weight', type: 'number', description: 'Weight.', default: 0, updatable: true },
    { name: 'note', type: 'string', description: 'Note.', default: null },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  customOperations: {
    poke: { access: 'open', description: 'Poke it.\nMore detail.', handler: async () => null },
    'config update': {
      access: 'approval',
      description: 'Update config.',
      args: [{ name: 'dry_run', type: 'boolean', description: 'Preview only.' }],
      examples: ['ncl widgets config update --dry-run\n  # multi\n\n  # blank kept'],
      handler: async () => null,
    },
  },
};

describe('helpers', () => {
  it('flagName dashes underscores; summaryLine takes the first line; indent pads only non-empty lines', () => {
    expect(flagName({ name: 'display_name' })).toBe('--display-name');
    expect(summaryLine('first\nsecond')).toBe('first');
    expect(summaryLine('only')).toBe('only');
    expect(indent('a\n\nb', '  ')).toBe('  a\n\n  b');
  });

  it('listVerbs orders generics first then custom operations', () => {
    expect(listVerbs(res)).toEqual(['list', 'get', 'create', 'update', 'delete', 'poke', 'config update']);
    expect(listVerbs({ ...res, operations: { get: 'open' }, customOperations: undefined })).toEqual(['get']);
  });
});

describe('renderVerbHelp', () => {
  it('returns undefined for unknown verbs and for generics the resource does not expose', () => {
    expect(renderVerbHelp(res, 'nope')).toBeUndefined();
    expect(renderVerbHelp({ ...res, operations: { list: 'open' } }, 'delete')).toBeUndefined();
  });

  it('renders list help with non-generated columns as optional filters plus --limit', () => {
    const out = renderVerbHelp(res, 'list')!;
    expect(out.split('\n')[0]).toBe('ncl widgets list');
    expect(out).toContain('List widgets. Flags below act as equality filters.');
    expect(out).toContain('--display-name');
    expect(out).not.toMatch(/--display-name.*required/);
    expect(out).toContain('--limit');
    expect(out).toContain('default: 200');
    expect(out).not.toContain('--id');
  });

  it('renders get / delete help with <id> and no flags', () => {
    const get = renderVerbHelp(res, 'get')!;
    expect(get).toBe('ncl widgets get <id>\n\nGet a widget by ID.');
    const del = renderVerbHelp(res, 'delete')!;
    expect(del).toBe('ncl widgets delete <id> [approval]\n\nDelete a widget by ID.');
  });

  it('renders create help with required/default/values tags, dropping null defaults', () => {
    const out = renderVerbHelp(res, 'create')!;
    expect(out.split('\n')[0]).toBe('ncl widgets create [approval]');
    expect(out).toContain('Create a new widget.');
    expect(out).toMatch(/--display-name\s+Name\. \(required\)/);
    expect(out).toMatch(/--mode\s+Mode\. \(default: a, values: a \| b\)/);
    expect(out).toMatch(/--weight\s+Weight\. \(default: 0\)/);
    expect(out).toMatch(/--note\s+Note\.$/);
    expect(out).not.toContain('Second paragraph');
  });

  it('renders update help with only updatable columns', () => {
    const out = renderVerbHelp(res, 'update')!;
    expect(out.split('\n')[0]).toBe('ncl widgets update <id> [approval]');
    expect(out).toContain('Provide at least one updatable flag.');
    expect(out).toContain('--display-name');
    expect(out).toContain('--weight');
    expect(out).not.toContain('--mode');
  });

  it('renders a custom op without declared args as description only', () => {
    expect(renderVerbHelp(res, 'poke')).toBe('ncl widgets poke\n\nPoke it.\nMore detail.');
  });

  it('renders a custom op with args and examples, indenting example blocks', () => {
    const out = renderVerbHelp(res, 'config update')!;
    expect(out).toContain('ncl widgets config update [approval]');
    expect(out).toContain('Flags:');
    expect(out).toMatch(/--dry-run\s+Preview only\./);
    expect(out).toContain('Examples:\n  ncl widgets config update --dry-run\n    # multi\n\n    # blank kept');
  });
});

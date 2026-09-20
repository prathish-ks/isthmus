/**
 * `ncl help` and `ncl <resource> help [<verb>]` against the real resource
 * registry (the commands barrel), for host, group-scoped, and global-scoped
 * callers.
 */
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const TEST_DIR = vi.hoisted(() => `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/ncl-cov-C-help-${process.pid}`);

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn(),
}));

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getResources } from '../crud.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { GROUP_SCOPE_RESOURCES, lookup } from '../registry.js';
// Registers every resource plus `help` and `<plural>-help`.
import './index.js';
import { registerResourceHelpCommands } from './help.js';

const host: CallerContext = { caller: 'host' };
const agent = (agentGroupId: string): CallerContext => ({
  caller: 'agent',
  agentGroupId,
  sessionId: 'sess',
  messagingGroupId: 'mg',
});

async function text(command: string, args: Record<string, unknown>, ctx: CallerContext): Promise<string> {
  const resp = await dispatch({ id: 'h', command, args }, ctx);
  if (!resp.ok) throw new Error(`${resp.error.code}: ${resp.error.message}`);
  return resp.data as string;
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb({ fresh: true }));
  for (const [id, scope] of [
    ['ag-group', 'group'],
    ['ag-global', 'global'],
  ] as const) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(id);
    await updateContainerConfigScalars(id, { cli_scope: scope });
  }
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ncl help', () => {
  it('lists every resource with its verbs, the general commands, and the footer (host)', async () => {
    const out = await text('help', {}, host);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Resources:');
    for (const r of getResources()) {
      expect(out).toContain(`  ${r.plural.padEnd(20)} ${r.description}`);
    }
    expect(out).toMatch(/messaging-groups {5}.*\n {23}verbs: list, get, create, update, delete, send/);
    expect(out).toMatch(/\n {2}groups {15}.*\n {23}verbs: list, get, update, create, delete, restart/);
    expect(out).toContain('\nCommands:\n  help                 List available resources and commands.');
    expect(lines.at(-1)).toBe('Run `ncl <resource> help` for detailed field information.');
    expect(out).not.toContain('CLI scope: group');
  });

  it('for a group-scoped agent, announces the scope and shows only whitelisted resources', async () => {
    const out = await text('help', {}, agent('ag-group'));
    expect(out.startsWith('CLI scope: group (--id and group args are auto-filled to your agent group)\n\n')).toBe(true);
    const listed = [...out.matchAll(/^ {2}(\S+) {2,}/gm)].map((m) => m[1]).filter((n) => n !== 'help');
    expect(new Set(listed)).toEqual(GROUP_SCOPE_RESOURCES);
    expect(out).not.toContain('messaging-groups');
  });

  it('for a global-scoped agent, shows everything without the scope banner', async () => {
    const out = await text('help', {}, agent('ag-global'));
    expect(out).not.toContain('CLI scope: group');
    expect(out).toContain('messaging-groups');
    expect(out).toContain('roles');
  });

  it('is reachable through the positional-join fallback and carries a human rendering', async () => {
    const resp = await dispatch({ id: 'h', command: 'help', args: { help: true } }, host);
    expect(resp.ok).toBe(true);
    if (resp.ok) expect(resp.human).toBe('List available resources and commands.');
  });
});

describe('ncl <resource> help', () => {
  it('renders verbs with <id> hints, access tags, and field tags for a host caller', async () => {
    const out = await text('messaging-groups-help', {}, host);
    expect(out.split('\n')[0]).toMatch(/^messaging-groups: Messaging group — /);
    expect(out).toContain(
      'Verbs:\n  list\n  get <id>\n  create [approval]\n  update <id> [approval]\n  delete <id> [approval]',
    );
    expect(out).toContain('  send [approval] — Inject a message into a messaging group');
    expect(out).toContain(
      'Run `ncl messaging-groups help <verb>` (or add --help to any command) for flags and examples.',
    );
    expect(out).toMatch(/--id\s+UUID\. \(auto\)/);
    expect(out).toMatch(/--channel-type\s+.*\(required\)/);
    expect(out).toMatch(/--instance\s+.*\(updatable\)/);
    expect(out).toMatch(/--is-group\s+.*\(updatable, default: 0\)/);
    expect(out).toMatch(
      /--unknown-sender-policy\s+.*\(updatable, default: strict, values: strict \| request_approval \| decline_notify \| public\)/,
    );
    expect(out).not.toContain('auto-filled');
  });

  it('for a group-scoped agent on groups, notes the auto-fill, drops <id> hints, and tags auto-filled fields', async () => {
    // The dispatcher auto-fills --id with the caller's group; help must not
    // read that as a verb request.
    const out = await text('groups-help', {}, agent('ag-group'));
    expect(out).toContain(
      'Note: --id and group args are auto-filled to your agent group. You do not need to pass them.',
    );
    expect(out).toContain('Verbs:\n  list\n  get\n  update [approval]');
    expect(out).toMatch(/--id\s+UUID\. \(auto-filled, auto\)/);
  });

  it('for a group-scoped agent on members, keeps <id> hints but tags the group field', async () => {
    const out = await text('members-help', {}, agent('ag-group'));
    expect(out).toContain('Note: --id and group args');
    expect(out).toContain('  list\n  add [approval]');
    expect(out).toMatch(/--agent-group-id\s+.*\(auto-filled\)/);
  });

  it('for a global-scoped agent, renders like the host', async () => {
    const out = await text('groups-help', {}, agent('ag-global'));
    expect(out).not.toContain('Note: --id and group args');
    expect(out).not.toContain('(auto-filled');
    expect(out).toContain('  get <id>\n');
  });

  it('renders deep verb help for `<resource> help <verb>` and rejects unknown verbs', async () => {
    const deep = await text('groups-help-restart', {}, host);
    expect(deep.split('\n')[0]).toBe('ncl groups restart [approval]');
    await expect(text('groups-help-bogus', {}, host)).rejects.toThrow(
      'handler-error: no verb "bogus" on groups — run `ncl groups help`',
    );
  });

  it('does not bridge dash-joined multi-word verbs (documents current behaviour)', async () => {
    // `ncl groups help config get` arrives as id "config-get", but the custom
    // operation key is "config get"; unlike the `--help` path in dispatch.ts,
    // resource help looks the verb up verbatim and reports it as unknown.
    await expect(text('groups-help-config-get', {}, host)).rejects.toThrow('no verb "config-get" on groups');
    // The --help path on the same command does resolve it.
    const viaFlag = await text('groups-config-get', { help: true }, host);
    expect(viaFlag.split('\n')[0]).toBe('ncl groups config get');
  });

  it('registerResourceHelpCommands is idempotent (already-registered names are skipped)', () => {
    const before = lookup('groups-help');
    expect(() => registerResourceHelpCommands()).not.toThrow();
    expect(lookup('groups-help')).toBe(before);
  });
});

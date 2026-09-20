import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

import type { PendingApproval } from '../types.js';
import type { GuardInput } from '../guard/types.js';
import { commandGuardAction, commandGuardSpec } from './guard.js';
import type { CommandDef } from './registry.js';

function cmd(overrides: Partial<CommandDef> = {}): CommandDef {
  return {
    name: 'groups-get',
    description: 'x',
    access: 'open',
    resource: 'groups',
    parseArgs: (raw) => raw,
    handler: async () => null,
    ...overrides,
  };
}

const agent = { kind: 'agent' as const, agentGroupId: 'g1', sessionId: 's1' };

beforeEach(() => {
  mockGetContainerConfig.mockReset();
});

describe('commandGuardAction', () => {
  it('uses the explicit action when set, else cli.<name>', () => {
    expect(commandGuardAction({ name: 'help' })).toBe('cli.help');
    expect(commandGuardAction({ name: 'roles-grant', action: 'roles.grant' })).toBe('roles.grant');
  });
});

describe('commandGuardSpec', () => {
  it('binds a cli_command grant to the exact command, and rejects unparseable grant payloads', () => {
    const spec = commandGuardSpec(cmd({ access: 'approval' }));
    expect(spec.grantActionName).toBe('cli_command');
    const grant = (payload: string) => ({ payload }) as PendingApproval;
    const input = {} as GuardInput;
    expect(spec.grantCoversRequest!(grant(JSON.stringify({ frame: { command: 'groups-get' } })), input)).toBe(true);
    expect(spec.grantCoversRequest!(grant(JSON.stringify({ frame: { command: 'groups-list' } })), input)).toBe(false);
    expect(spec.grantCoversRequest!(grant(JSON.stringify({})), input)).toBe(false);
    expect(spec.grantCoversRequest!(grant('not json at all'), input)).toBe(false);
  });

  it('open commands carry no grant action name', () => {
    expect(commandGuardSpec(cmd()).grantActionName).toBeUndefined();
  });

  it('allows host callers without consulting the container config', async () => {
    const d = await commandGuardSpec(cmd()).decide({ actor: { kind: 'host' }, payload: {} });
    expect(d).toEqual({ effect: 'allow', reason: 'host caller (trusted socket)' });
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('denies actors that are neither host nor agent (human, system)', async () => {
    const spec = commandGuardSpec(cmd());
    expect(await spec.decide({ actor: { kind: 'human', userId: 'u' }, payload: {} })).toEqual({
      effect: 'deny',
      reason: 'CLI commands accept host or agent callers only.',
    });
    expect((await spec.decide({ actor: { kind: 'system' }, payload: {} })).effect).toBe('deny');
  });

  it('denies host-only commands for agents even at global scope, before reading config', async () => {
    mockGetContainerConfig.mockResolvedValue({ cli_scope: 'global' });
    const d = await commandGuardSpec(cmd({ name: 'groups-config-add-mount', hostOnly: true })).decide({
      actor: agent,
      payload: {},
    });
    expect(d.effect).toBe('deny');
    expect(d.reason).toContain('operator-only');
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  it('denies everything when cli_scope is disabled', async () => {
    mockGetContainerConfig.mockResolvedValue({ cli_scope: 'disabled' });
    const d = await commandGuardSpec(cmd()).decide({ actor: agent, payload: {} });
    expect(d).toEqual({ effect: 'deny', reason: 'CLI access is disabled for this agent group.' });
  });

  it('defaults to group scope when no config row exists', async () => {
    mockGetContainerConfig.mockResolvedValue(undefined);
    const d = await commandGuardSpec(cmd({ resource: 'wirings', name: 'wirings-list' })).decide({
      actor: agent,
      payload: {},
    });
    expect(d.effect).toBe('deny');
    expect(d.reason).toContain('Cannot access "wirings"');
  });

  describe('group scope', () => {
    beforeEach(() => mockGetContainerConfig.mockResolvedValue({ cli_scope: 'group' }));

    it('allows general (resource-less) commands', async () => {
      const d = await commandGuardSpec(cmd({ name: 'help', resource: undefined })).decide({
        actor: agent,
        payload: {},
      });
      expect(d).toEqual({ effect: 'allow', reason: 'open command' });
    });

    it('denies cross-group agent_group_id / group / id args', async () => {
      const spec = commandGuardSpec(cmd());
      for (const payload of [{ agent_group_id: 'g2' }, { group: 'g2' }, { id: 'g2' }]) {
        const d = await spec.decide({ actor: agent, payload });
        expect(d).toEqual({ effect: 'deny', reason: 'CLI access is scoped to this agent group.' });
      }
    });

    it('does not treat --id as the group id on non-group resources', async () => {
      const d = await commandGuardSpec(cmd({ name: 'sessions-get', resource: 'sessions' })).decide({
        actor: agent,
        payload: { id: 'some-session' },
      });
      expect(d.effect).toBe('allow');
    });

    it('lets wirings-get / wirings-update through the resource whitelist', async () => {
      const get = await commandGuardSpec(cmd({ name: 'wirings-get', resource: 'wirings' })).decide({
        actor: agent,
        payload: { id: 'w1' },
      });
      expect(get.effect).toBe('allow');
    });

    it('restricts group-scoped wiring updates to engage_mode / engage_pattern', async () => {
      const spec = commandGuardSpec(cmd({ name: 'wirings-update', resource: 'wirings', access: 'approval' }));
      const ok = await spec.decide({ actor: agent, payload: { id: 'w1', 'engage-mode': 'mention', group: 'g1' } });
      expect(ok.effect).toBe('hold');
      const bad = await spec.decide({ actor: agent, payload: { id: 'w1', session_mode: 'shared' } });
      expect(bad).toEqual({
        effect: 'deny',
        reason: 'Group-scoped wiring updates may only change engage_mode or engage_pattern.',
      });
    });

    it('blocks cli_scope escalation in either spelling', async () => {
      const spec = commandGuardSpec(cmd({ name: 'groups-config-update' }));
      for (const payload of [{ cli_scope: 'global' }, { 'cli-scope': 'global' }]) {
        const d = await spec.decide({ actor: agent, payload });
        expect(d).toEqual({ effect: 'deny', reason: 'Cannot change cli_scope from a group-scoped agent.' });
      }
    });

    it('holds approval-gated commands for the admin chain', async () => {
      const d = await commandGuardSpec(cmd({ name: 'groups-update', access: 'approval' })).decide({
        actor: agent,
        payload: { id: 'g1' },
      });
      expect(d).toEqual({ effect: 'hold', reason: 'agent-initiated "groups-update" requires admin approval' });
    });
  });

  it('global scope skips the resource whitelist but still holds approval commands', async () => {
    mockGetContainerConfig.mockResolvedValue({ cli_scope: 'global' });
    const open = await commandGuardSpec(cmd({ name: 'wirings-list', resource: 'wirings' })).decide({
      actor: agent,
      payload: { cli_scope: 'global', agent_group_id: 'other' },
    });
    expect(open.effect).toBe('allow');
    const held = await commandGuardSpec(cmd({ name: 'roles-grant', resource: 'roles', access: 'approval' })).decide({
      actor: agent,
      payload: {},
    });
    expect(held.effect).toBe('hold');
  });
});

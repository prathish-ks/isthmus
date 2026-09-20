/**
 * Self-mod guard adapter — the branches guard.test.ts leaves open: the
 * non-agent deny on add_mcp_server (no capability gate, so the actor check is
 * the only deny), and the reason strings each decision carries.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { DockerSessionDriver } from '../../drivers/docker-driver.js';
import { resetSessionDriver } from '../../drivers/index.js';
import { FIXTURE_POLICY } from '../../drivers/spec-fixture.js';
import { guard } from '../../guard/index.js';
import { selfModAddMcpServer, selfModInstallPackages } from './guard.js';

const agent = { kind: 'agent', agentGroupId: 'g1', sessionId: 's1' } as const;

afterEach(() => resetSessionDriver(null));

describe('selfModAddMcpServer', () => {
  it('refuses non-agent callers, naming the action as container-originated', async () => {
    const decision = await guard(selfModAddMcpServer, { actor: { kind: 'host' }, payload: { name: 'srv' } });
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('add_mcp_server is a container-originated action.');
  });

  it('holds agent callers with the admin-approval reason', async () => {
    const decision = await guard(selfModAddMcpServer, { actor: agent, payload: { name: 'srv' } });
    expect(decision.effect).toBe('hold');
    expect(decision.reason).toBe('add_mcp_server always requires admin approval from the container path');
  });

  it('is bound to the add_mcp_server approval action', () => {
    expect(selfModAddMcpServer.action).toBe('self_mod.add_mcp_server');
    expect(selfModAddMcpServer.grantActionName).toBe('add_mcp_server');
  });
});

describe('selfModInstallPackages', () => {
  it('holds agent callers on a capable driver with the admin-approval reason', async () => {
    resetSessionDriver(new DockerSessionDriver(FIXTURE_POLICY));
    const decision = await guard(selfModInstallPackages, { actor: agent, payload: { apt: ['jq'] } });
    expect(decision.effect).toBe('hold');
    expect(decision.reason).toBe('install_packages always requires admin approval from the container path');
  });

  it('refuses non-agent callers on a capable driver with the container-originated reason', async () => {
    resetSessionDriver(new DockerSessionDriver(FIXTURE_POLICY));
    const decision = await guard(selfModInstallPackages, { actor: { kind: 'host' }, payload: {} });
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('install_packages is a container-originated action.');
  });

  it('is bound to the install_packages approval action', () => {
    expect(selfModInstallPackages.action).toBe('self_mod.install_packages');
    expect(selfModInstallPackages.grantActionName).toBe('install_packages');
  });
});

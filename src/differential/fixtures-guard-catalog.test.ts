/**
 * P2-04: guard-catalog behavioral contracts.
 *
 * P2-03 built the first 10 fixtures around the router/session/delivery
 * message path. This file expands the fixture set (P2-04's task: 10 → 30-50)
 * by targeting the OTHER half of `docs/parity-schema.md`'s design: the guard
 * axis. Every entry in the guarded-action catalog (`src/guard/guard-actions.ts`)
 * is exercised directly via `guard()` — no router/session/delivery machinery
 * needed, since a guarded action's `decide` fn is itself the observable
 * contract (see docs/parity-schema.md's "compare observable contracts, not
 * internals" principle: `guard()` IS the seam, not an internal detail behind
 * one). This is also, not incidentally, the GO-KERNEL and GO-KERNEL SLICE
 * subset `docs/test-inventory.md` (P2-01) flagged as the most Go-kernel-
 * relevant test files in the repo — these contracts are exactly what a Go
 * port of the guard decision seam has to reproduce.
 *
 * Six actions are covered, plus guard.ts's own two action-agnostic behaviors:
 *   - senders.admit (src/modules/permissions/guard.ts) — pure, no DB.
 *   - channels.register (src/modules/permissions/guard.ts) — needs
 *     pending_channel_approvals + user_roles.
 *   - agents.create (src/modules/agent-to-agent/guard.ts) — needs
 *     container_configs; has a grantActionName ('create_agent').
 *   - a2a.send (src/modules/agent-to-agent/guard.ts) — needs
 *     agent_destinations + agent_message_policies + agent_groups; has a
 *     grantActionName (A2A_MESSAGE_GATE_ACTION).
 *   - self_mod.install_packages / self_mod.add_mcp_server
 *     (src/modules/self-mod/guard.ts) — gate on the session driver's
 *     `imageBuild` capability; mirrors src/modules/self-mod/guard.test.ts's
 *     own withDocker()/withoutImageBuild() pattern verbatim.
 *   - the CLI-derived restart-style guard (src/cli/guard.ts's
 *     `commandDecide`/`commandGuardSpec`) — synthetic CommandDefs defined
 *     once at module scope (matching how the real command registry defines
 *     one guarded action per command, once, at registration time — defining
 *     the SAME action name twice throws, so these must not live inside a
 *     beforeEach or it()).
 *   - guard()'s own generic grant outcomes (a satisfied hold, an invalid or
 *     mismatched replay) and its two fail-closed backstops (a malformed
 *     action, a throwing decide fn) — these are action-agnostic, exercised
 *     via whichever action happens to be under test at the time, and via two
 *     dedicated synthetic actions for the backstops.
 *
 * A genuine finding surfaced while writing this file, not assumed:
 * `channels.register`'s decide fn returns the exact same ALLOW string
 * ('delivered approver or anchor-group admin') for both the
 * delivered-approver and the anchor-group-admin branches — there is no
 * behavioral difference visible from the reason text alone. `normalize.ts`'s
 * `channels-register-allowed` category reflects this (one category, not
 * two) rather than inventing a distinction the source code doesn't make.
 *
 * None of these fixtures need container-runner.js or config.js mocked —
 * unlike the P2-03 fixtures, nothing here spawns a container, wakes a
 * session, or reads DATA_DIR, so that whole class of setup (and Bug #1/
 * Bug #2 from P2-03) doesn't apply to this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createPendingApproval,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { createContainerConfig } from '../db/container-configs.js';
import { DockerSessionDriver } from '../drivers/docker-driver.js';
import { resetSessionDriver } from '../drivers/index.js';
import { FIXTURE_POLICY } from '../drivers/spec-fixture.js';
import type { SessionDriver } from '../drivers/types.js';
import { defineGuardedAction, guard } from '../guard/index.js';
import type { GuardedAction } from '../guard/guard-actions.js';
import type { GuardActor, GuardDecision } from '../guard/types.js';
import { commandGuardSpec } from '../cli/guard.js';
import type { CommandDef } from '../cli/registry.js';
import { agentsCreate, a2aSend } from '../modules/agent-to-agent/guard.js';
import { createDestination } from '../modules/agent-to-agent/db/agent-destinations.js';
import { setMessagePolicy } from '../modules/agent-to-agent/db/agent-message-policies.js';
import { createPendingChannelApproval } from '../modules/permissions/db/pending-channel-approvals.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { channelsRegister, sendersAdmit } from '../modules/permissions/guard.js';
import { selfModAddMcpServer, selfModInstallPackages } from '../modules/self-mod/guard.js';
import type { ContainerConfigRow, PendingApproval } from '../types.js';
import { normalizeGuardReason } from './normalize.js';
import type { ParityResult } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function toParity(scenario: string, decision: GuardDecision): ParityResult {
  return {
    scenario,
    guard: { effect: decision.effect, reasonCategory: normalizeGuardReason(decision.reason) },
  };
}

function containerConfigRow(agentGroupId: string, cliScope: string): ContainerConfigRow {
  return {
    agent_group_id: agentGroupId,
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: cliScope,
    timezone: null,
    updated_at: now(),
  };
}

function pendingApprovalRow(
  overrides: Partial<PendingApproval> & Pick<PendingApproval, 'approval_id' | 'action' | 'payload'>,
): PendingApproval {
  return {
    session_id: null,
    request_id: 'req-1',
    created_at: now(),
    agent_group_id: null,
    channel_type: null,
    platform_id: null,
    instance: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: 'test approval',
    question: 'test approval',
    options_json: '[]',
    approver_user_id: null,
    ...overrides,
  };
}

const agent = (agentGroupId: string): GuardActor => ({ kind: 'agent', agentGroupId });

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  resetSessionDriver(null);
});

// ─── senders.admit — pure switch on payload.policy, no DB at all ───

describe('P2-04 guard catalog: senders.admit (pure)', () => {
  it('policy=public allows unconditionally', async () => {
    const decision = await guard(sendersAdmit, {
      actor: { kind: 'human', userId: 'discord:x' },
      payload: { policy: 'public', messagingGroupId: 'mg-1' },
    });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-senders-admit-public', decision)).toMatchSnapshot();
  });

  it('policy=request_approval holds', async () => {
    const decision = await guard(sendersAdmit, {
      actor: { kind: 'human', userId: 'discord:x' },
      payload: { policy: 'request_approval', messagingGroupId: 'mg-1' },
    });
    expect(decision.effect).toBe('hold');
    expect(toParity('guard-senders-admit-request-approval', decision)).toMatchSnapshot();
  });

  it('policy=decline_notify denies', async () => {
    const decision = await guard(sendersAdmit, {
      actor: { kind: 'human', userId: 'discord:x' },
      payload: { policy: 'decline_notify', messagingGroupId: 'mg-1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-senders-admit-decline-notify', decision)).toMatchSnapshot();
  });

  it('policy=strict (and any other/unset value) denies, fail-closed', async () => {
    const decision = await guard(sendersAdmit, {
      actor: { kind: 'human', userId: 'discord:x' },
      payload: { policy: 'strict', messagingGroupId: 'mg-1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-senders-admit-strict', decision)).toMatchSnapshot();
  });
});

// ─── channels.register — needs pending_channel_approvals + user_roles ───

describe('P2-04 guard catalog: channels.register', () => {
  beforeEach(async () => {
    await createAgentGroup({ id: 'ag-1', name: 'Test', folder: 'test-agent', agent_provider: null, created_at: now() });
    // pending_channel_approvals.messaging_group_id is a NOT NULL FK to
    // messaging_groups(id) — the row must exist before the approval row can
    // be inserted, even though this describe block never routes a message
    // through it.
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'discord',
      platform_id: 'chan-1',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createPendingChannelApproval({
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      original_message: '{}',
      approver_user_id: 'discord:approver',
      created_at: now(),
      title: 'Register this channel?',
      question: 'Register this channel?',
      options_json: '[]',
    });
    // user_roles.user_id is a NOT NULL FK to users(id) — grantRole fails
    // without this, unlike the plain SELECT-based hasAdminPrivilege checks
    // elsewhere in this file that never need a users row to exist.
    await upsertUser({ id: 'discord:admin', kind: 'discord', display_name: 'Admin', created_at: now() });
    await grantRole({
      user_id: 'discord:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
  });

  it('non-human actor denied — resolves only via human clicks/replies', async () => {
    const decision = await guard(channelsRegister, {
      actor: { kind: 'agent', agentGroupId: 'ag-1' },
      payload: { questionId: 'mg-1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-channels-register-non-human', decision)).toMatchSnapshot();
  });

  it('no pending row for the questionId denied', async () => {
    const decision = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'discord:approver' },
      payload: { questionId: 'no-such-mg' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-channels-register-no-pending', decision)).toMatchSnapshot();
  });

  it('the delivered approver is allowed', async () => {
    const decision = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'discord:approver' },
      payload: { questionId: 'mg-1' },
    });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-channels-register-approver', decision)).toMatchSnapshot();
  });

  it('an anchor-group admin (not the delivered approver) is also allowed — same reason text as above, see normalize.ts', async () => {
    const decision = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'discord:admin' },
      payload: { questionId: 'mg-1' },
    });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-channels-register-anchor-admin', decision)).toMatchSnapshot();
  });

  it('an unprivileged human who is neither the approver nor an admin is denied', async () => {
    const decision = await guard(channelsRegister, {
      actor: { kind: 'human', userId: 'discord:stranger' },
      payload: { questionId: 'mg-1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-channels-register-ineligible', decision)).toMatchSnapshot();
  });
});

// ─── agents.create — container_configs.cli_scope + a create_agent grant ───

describe('P2-04 guard catalog: agents.create', () => {
  it('non-agent actor denied — create_agent is container-originated', async () => {
    const decision = await guard(agentsCreate, { actor: { kind: 'host' }, payload: { name: 'sub' } });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-agents-create-non-agent', decision)).toMatchSnapshot();
  });

  it('cli_scope=global allows directly — trusted owner agent group', async () => {
    await createAgentGroup({
      id: 'ag-global',
      name: 'Global',
      folder: 'global-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createContainerConfig(containerConfigRow('ag-global', 'global'));
    const decision = await guard(agentsCreate, { actor: agent('ag-global'), payload: { name: 'sub' } });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-agents-create-global-scope', decision)).toMatchSnapshot();
  });

  it('cli_scope=group (the default, and any unknown value) holds for admin approval', async () => {
    await createAgentGroup({
      id: 'ag-group',
      name: 'Group',
      folder: 'group-agent',
      agent_provider: null,
      created_at: now(),
    });
    // No container_configs row at all — getContainerConfig returns undefined,
    // and the guard's `?? 'group'` default takes over. Exercises the
    // fail-closed default path, not just the explicit 'group' value.
    const decision = await guard(agentsCreate, { actor: agent('ag-group'), payload: { name: 'sub' } });
    expect(decision.effect).toBe('hold');
    expect(toParity('guard-agents-create-group-scope-default', decision)).toMatchSnapshot();
  });

  it('a grant naming the same requested name satisfies the hold', async () => {
    await createAgentGroup({
      id: 'ag-group-2',
      name: 'Group2',
      folder: 'group-agent-2',
      agent_provider: null,
      created_at: now(),
    });
    const grant = pendingApprovalRow({
      approval_id: 'appr-create-1',
      action: 'create_agent',
      payload: JSON.stringify({ name: 'sub' }),
      agent_group_id: 'ag-group-2',
    });
    await createPendingApproval(grant);
    const decision = await guard(agentsCreate, { actor: agent('ag-group-2'), payload: { name: 'sub' }, grant });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-agents-create-grant-satisfied', decision)).toMatchSnapshot();
  });

  it('a grant naming a DIFFERENT name than requested is refused, not silently accepted', async () => {
    await createAgentGroup({
      id: 'ag-group-3',
      name: 'Group3',
      folder: 'group-agent-3',
      agent_provider: null,
      created_at: now(),
    });
    const grant = pendingApprovalRow({
      approval_id: 'appr-create-2',
      action: 'create_agent',
      payload: JSON.stringify({ name: 'approved-name' }),
      agent_group_id: 'ag-group-3',
    });
    await createPendingApproval(grant);
    const decision = await guard(agentsCreate, {
      actor: agent('ag-group-3'),
      payload: { name: 'different-name' },
      grant,
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-agents-create-grant-mismatch', decision)).toMatchSnapshot();
  });
});

// ─── a2a.send — agent_destinations + agent_message_policies + agent_groups ───

describe('P2-04 guard catalog: a2a.send', () => {
  beforeEach(async () => {
    await createAgentGroup({
      id: 'ag-from',
      name: 'From',
      folder: 'from-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createAgentGroup({ id: 'ag-to', name: 'To', folder: 'to-agent', agent_provider: null, created_at: now() });
  });

  it('non-agent actor denied', async () => {
    const decision = await guard(a2aSend, {
      actor: { kind: 'human', userId: 'x' },
      resource: { to: 'ag-to' },
      payload: { id: 'm1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-a2a-send-non-agent', decision)).toMatchSnapshot();
  });

  it('no destination row for (from,to) denied', async () => {
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-to' },
      payload: { id: 'm1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-a2a-send-no-destination', decision)).toMatchSnapshot();
  });

  it('destination exists but the target agent group does not denied', async () => {
    await createDestination({
      agent_group_id: 'ag-from',
      local_name: 'ghost',
      target_type: 'agent',
      target_id: 'ag-missing',
      created_at: now(),
    });
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-missing' },
      payload: { id: 'm1' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-a2a-send-target-not-found', decision)).toMatchSnapshot();
  });

  it('a self-send is allowed without needing a destination row', async () => {
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-from' },
      payload: { id: 'm1' },
    });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-a2a-send-self-send', decision)).toMatchSnapshot();
  });

  it('destination + target exist, no policy row: allowed', async () => {
    await createDestination({
      agent_group_id: 'ag-from',
      local_name: 'buddy',
      target_type: 'agent',
      target_id: 'ag-to',
      created_at: now(),
    });
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-to' },
      payload: { id: 'm1' },
    });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-a2a-send-no-policy', decision)).toMatchSnapshot();
  });

  it('destination + target exist, a message policy row: holds for its named approver', async () => {
    await createDestination({
      agent_group_id: 'ag-from',
      local_name: 'buddy',
      target_type: 'agent',
      target_id: 'ag-to',
      created_at: now(),
    });
    await setMessagePolicy('ag-from', 'ag-to', 'discord:approver', now());
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-to' },
      payload: { id: 'm1' },
    });
    expect(decision.effect).toBe('hold');
    expect(toParity('guard-a2a-send-policy-hold', decision)).toMatchSnapshot();
  });

  it('a grant naming the exact held target satisfies the hold', async () => {
    await createDestination({
      agent_group_id: 'ag-from',
      local_name: 'buddy',
      target_type: 'agent',
      target_id: 'ag-to',
      created_at: now(),
    });
    await setMessagePolicy('ag-from', 'ag-to', 'discord:approver', now());
    const grant = pendingApprovalRow({
      approval_id: 'appr-a2a-1',
      action: 'a2a_message_gate',
      payload: JSON.stringify({ platform_id: 'ag-to' }),
      agent_group_id: 'ag-from',
    });
    await createPendingApproval(grant);
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-to' },
      payload: { id: 'm1' },
      grant,
    });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-a2a-send-grant-satisfied', decision)).toMatchSnapshot();
  });

  it('a grant naming a DIFFERENT target than the one held is refused', async () => {
    await createDestination({
      agent_group_id: 'ag-from',
      local_name: 'buddy',
      target_type: 'agent',
      target_id: 'ag-to',
      created_at: now(),
    });
    await setMessagePolicy('ag-from', 'ag-to', 'discord:approver', now());
    const grant = pendingApprovalRow({
      approval_id: 'appr-a2a-2',
      action: 'a2a_message_gate',
      payload: JSON.stringify({ platform_id: 'some-other-target' }),
      agent_group_id: 'ag-from',
    });
    await createPendingApproval(grant);
    const decision = await guard(a2aSend, {
      actor: agent('ag-from'),
      resource: { to: 'ag-to' },
      payload: { id: 'm1' },
      grant,
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-a2a-send-grant-mismatch', decision)).toMatchSnapshot();
  });
});

// ─── self_mod.install_packages / add_mcp_server — gates on driver capabilities() ───
// Mirrors src/modules/self-mod/guard.test.ts's own withDocker()/withoutImageBuild()
// pattern verbatim, since that file IS the template for this behavior.

function withDocker(): void {
  resetSessionDriver(new DockerSessionDriver(FIXTURE_POLICY));
}
function withoutImageBuild(): void {
  const docker = new DockerSessionDriver(FIXTURE_POLICY);
  resetSessionDriver({
    kind: docker.kind,
    capabilities: () => ({ ...docker.capabilities(), imageBuild: false }),
    prepare: () => Promise.reject(new Error('not under test')),
    listSessions: () => Promise.resolve([]),
    watchSessions: () => ({ stop: () => {} }),
  } satisfies SessionDriver);
}

describe('P2-04 guard catalog: self_mod.install_packages / add_mcp_server', () => {
  it('install_packages: non-agent actor denied even on a capable driver', async () => {
    withDocker();
    const decision = await guard(selfModInstallPackages, { actor: { kind: 'host' }, payload: { apt: ['jq'] } });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-self-mod-install-non-agent', decision)).toMatchSnapshot();
  });

  it('install_packages: denied at request time when the driver lacks imageBuild', async () => {
    withoutImageBuild();
    const decision = await guard(selfModInstallPackages, { actor: agent('g1'), payload: { apt: ['jq'] } });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-self-mod-install-no-image-build', decision)).toMatchSnapshot();
  });

  it('install_packages: holds for admin approval on a capable driver', async () => {
    withDocker();
    const decision = await guard(selfModInstallPackages, { actor: agent('g1'), payload: { apt: ['jq'] } });
    expect(decision.effect).toBe('hold');
    expect(toParity('guard-self-mod-install-hold', decision)).toMatchSnapshot();
  });

  it('install_packages: a grant cannot resurrect a deny (approved under Docker, replayed after a driver switch)', async () => {
    withoutImageBuild();
    const grant = pendingApprovalRow({ approval_id: 'appr-install-1', action: 'install_packages', payload: '{}' });
    const decision = await guard(selfModInstallPackages, { actor: agent('g1'), payload: { apt: ['jq'] }, grant });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-self-mod-install-grant-cannot-resurrect', decision)).toMatchSnapshot();
  });

  it('add_mcp_server: non-agent actor denied', async () => {
    withDocker();
    const decision = await guard(selfModAddMcpServer, { actor: { kind: 'host' }, payload: { name: 'srv' } });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-self-mod-add-mcp-non-agent', decision)).toMatchSnapshot();
  });

  it("add_mcp_server: still holds on a driver WITHOUT imageBuild — it needs no rebuild, so it must not inherit install_packages' gate", async () => {
    withoutImageBuild();
    const decision = await guard(selfModAddMcpServer, { actor: agent('g1'), payload: { name: 'srv' } });
    expect(decision.effect).toBe('hold');
    expect(toParity('guard-self-mod-add-mcp-hold', decision)).toMatchSnapshot();
  });
});

// ─── CLI-derived restart-style guard (src/cli/guard.ts's commandDecide) ───
// Synthetic CommandDefs, defined ONCE at module scope — defineGuardedAction
// throws on a duplicate action name, so these must not live inside a
// beforeEach/it (exactly matching how the real registry calls register(),
// hence defineGuardedAction, exactly once per command at load time).

const restartLikeCmd: CommandDef = {
  name: 'test-restart',
  description: 'synthetic restart-style approval command for P2-04',
  access: 'approval',
  resource: 'groups',
  parseArgs: (raw) => raw,
  handler: async () => undefined,
};
const openGroupsCmd: CommandDef = {
  name: 'test-open-groups',
  description: 'synthetic open groups-resource command for P2-04',
  access: 'open',
  resource: 'groups',
  parseArgs: (raw) => raw,
  handler: async () => undefined,
};
const hostOnlyCmd: CommandDef = {
  name: 'test-hostonly',
  description: 'synthetic host-only command for P2-04',
  access: 'open',
  hostOnly: true,
  parseArgs: (raw) => raw,
  handler: async () => undefined,
};
const disallowedResourceCmd: CommandDef = {
  name: 'test-roles',
  description: 'synthetic command on a non-group-scope-allowlisted resource for P2-04',
  access: 'open',
  resource: 'roles',
  parseArgs: (raw) => raw,
  handler: async () => undefined,
};
const wiringUpdateCmd: CommandDef = {
  name: 'wirings-update',
  description: 'synthetic wirings-update command for P2-04 (real command name — see GROUP_WIRING_COMMANDS)',
  access: 'open',
  resource: 'wirings',
  parseArgs: (raw) => raw,
  handler: async () => undefined,
};

const restartLikeGuard = defineGuardedAction(commandGuardSpec(restartLikeCmd));
const openGroupsGuard = defineGuardedAction(commandGuardSpec(openGroupsCmd));
const hostOnlyGuard = defineGuardedAction(commandGuardSpec(hostOnlyCmd));
const disallowedResourceGuard = defineGuardedAction(commandGuardSpec(disallowedResourceCmd));
const wiringUpdateGuard = defineGuardedAction(commandGuardSpec(wiringUpdateCmd));

describe('P2-04 guard catalog: CLI-derived restart-style guard (commandDecide)', () => {
  it('a host caller is always allowed — the 0600 socket is the auth story', async () => {
    const decision = await guard(restartLikeGuard, { actor: { kind: 'host' }, payload: {} });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-cli-host-caller', decision)).toMatchSnapshot();
  });

  it('a non-host, non-agent caller is denied', async () => {
    const decision = await guard(openGroupsGuard, { actor: { kind: 'system' }, payload: {} });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-non-host-non-agent', decision)).toMatchSnapshot();
  });

  it('a host-only command is denied to ANY container caller, even at cli_scope=global', async () => {
    await createAgentGroup({
      id: 'ag-hostonly',
      name: 'HostOnly',
      folder: 'hostonly-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createContainerConfig(containerConfigRow('ag-hostonly', 'global'));
    const decision = await guard(hostOnlyGuard, { actor: agent('ag-hostonly'), payload: {} });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-host-only-denied', decision)).toMatchSnapshot();
  });

  it('cli_scope=disabled denies a non-host-only command outright', async () => {
    await createAgentGroup({
      id: 'ag-disabled',
      name: 'Disabled',
      folder: 'disabled-agent',
      agent_provider: null,
      created_at: now(),
    });
    await createContainerConfig(containerConfigRow('ag-disabled', 'disabled'));
    const decision = await guard(openGroupsGuard, { actor: agent('ag-disabled'), payload: {} });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-scope-disabled', decision)).toMatchSnapshot();
  });

  it('cli_scope=group (the default) denies a resource not on the group-scope allowlist', async () => {
    const decision = await guard(disallowedResourceGuard, { actor: agent('g1'), payload: {} });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-scope-resource-not-allowlisted', decision)).toMatchSnapshot();
  });

  it('cli_scope=group denies an --agent-group-id/--group arg pointing at a different group', async () => {
    const decision = await guard(openGroupsGuard, {
      actor: agent('g1'),
      payload: { agent_group_id: 'someone-elses-group' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-scope-cross-group-arg', decision)).toMatchSnapshot();
  });

  it('cli_scope=group denies an --id arg pointing at a different group, for resource=groups', async () => {
    const decision = await guard(openGroupsGuard, { actor: agent('g1'), payload: { id: 'someone-elses-group' } });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-scope-cross-group-id', decision)).toMatchSnapshot();
  });

  it('cli_scope=group denies a wirings-update arg outside the allowed set', async () => {
    const decision = await guard(wiringUpdateGuard, {
      actor: agent('g1'),
      payload: { engage_pattern: '.', foo: 'bar' },
    });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-scope-wiring-update-args', decision)).toMatchSnapshot();
  });

  it('cli_scope=group denies any attempt to change cli_scope itself — privilege escalation', async () => {
    const decision = await guard(openGroupsGuard, { actor: agent('g1'), payload: { cli_scope: 'global' } });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-scope-mutation-denied', decision)).toMatchSnapshot();
  });

  it('an access=approval command that passes every scope check holds for admin approval', async () => {
    const decision = await guard(restartLikeGuard, { actor: agent('g1'), payload: {} });
    expect(decision.effect).toBe('hold');
    expect(toParity('guard-cli-approval-required-hold', decision)).toMatchSnapshot();
  });

  it('an access=open command that passes every scope check is allowed', async () => {
    const decision = await guard(openGroupsGuard, { actor: agent('g1'), payload: {} });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-cli-open-command', decision)).toMatchSnapshot();
  });

  it('a cli_command grant naming the exact approved command satisfies the hold', async () => {
    // agent_group_id is left at its default (null) — pending_approvals.agent_group_id
    // is a nullable FK, and grantSatisfies never reads it, so there's no need
    // to fabricate an agent_groups row just to populate this field.
    const grant = pendingApprovalRow({
      approval_id: 'appr-cli-1',
      action: 'cli_command',
      payload: JSON.stringify({ frame: { command: 'test-restart' } }),
    });
    await createPendingApproval(grant);
    const decision = await guard(restartLikeGuard, { actor: agent('g1'), payload: {}, grant });
    expect(decision.effect).toBe('allow');
    expect(toParity('guard-cli-grant-satisfied', decision)).toMatchSnapshot();
  });

  it('a cli_command grant naming a DIFFERENT command than the one approved is refused', async () => {
    const grant = pendingApprovalRow({
      approval_id: 'appr-cli-2',
      action: 'cli_command',
      payload: JSON.stringify({ frame: { command: 'some-other-command' } }),
    });
    await createPendingApproval(grant);
    const decision = await guard(restartLikeGuard, { actor: agent('g1'), payload: {}, grant });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-cli-grant-mismatch', decision)).toMatchSnapshot();
  });
});

// ─── guard()'s own fail-closed backstops (src/guard/guard.ts) ───
// Action-agnostic: these protect the consult SEAM itself, independent of
// which domain action is being consulted — directly the LAW-07/OBJ-04
// "exclusive enforcement" property a Go port must preserve exactly.

const throwingAction = defineGuardedAction({
  action: 'test.throwing-decide',
  decide: () => {
    throw new Error('synthetic decide failure for the P2-04 fail-closed contract');
  },
});

describe("P2-04 guard catalog: guard()'s fail-closed backstops", () => {
  it('a value not minted by defineGuardedAction is denied, not fail-open', async () => {
    const notReallyGuarded = {
      action: 'test.not-guarded',
      decide: async () => ({ effect: 'allow' as const, reason: 'nope' }),
    } as unknown as GuardedAction;
    const decision = await guard(notReallyGuarded, { actor: { kind: 'host' }, payload: {} });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-malformed-action', decision)).toMatchSnapshot();
  });

  it('a decide fn that throws is caught and denied, not propagated', async () => {
    const decision = await guard(throwingAction, { actor: { kind: 'host' }, payload: {} });
    expect(decision.effect).toBe('deny');
    expect(toParity('guard-throwing-decide', decision)).toMatchSnapshot();
  });
});

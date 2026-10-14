/**
 * TC-15 — the provider a group is configured for is the provider it gets, and
 * an unavailable one fails loudly rather than quietly becoming Claude.
 *
 * Most of TC-15 is already covered. `resolveProviderName`'s precedence is
 * pinned in container-runner.test.ts:39 (session wins over container config,
 * default is claude). The default-surfaces behaviour for an unregistered
 * provider is pinned in provider-surfaces.test.ts:259 and :164, honestly
 * labelled "today's behavior". Invalid credentials failing clearly is pinned
 * container-side by providers/claude.errors.test.ts, including the owner hint
 * added for the expired-OAuth notice. And the container's own
 * providers/factory.test.ts proves createProvider throws for an unknown name
 * rather than substituting one.
 *
 * What was NOT asserted is the single property that separates "a documented
 * fallback" from "a silent fallback" — the phrase TC-15 actually uses. When a
 * group names a provider with no registered host contract or adapter (an
 * `opencode` group on an install where /add-opencode was never run, say), the
 * host spawns with Claude's default surfaces and logs a warning so an
 * operator can spot it. That warning is the entire difference. Nothing tested
 * that it fires, so nothing stopped it being dropped in a refactor — at which
 * point the behaviour becomes genuinely silent and an operator debugging "why
 * is my Codex agent answering like Claude" has no thread to pull.
 *
 * The companion property, also untested: the host must NOT rewrite the
 * provider NAME when it falls back on surfaces. The name travels to the
 * container, which asks its own registry for it and throws
 * ("Unknown provider: opencode. Registered: claude, mock"). That throw is the
 * backstop that stops a misconfigured group from quietly running as Claude —
 * but only while the name reaching the container is still the one the
 * operator configured.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-provider-no-silent-fallback-test';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-provider-no-silent-fallback-test/data',
  GROUPS_DIR: '/tmp/nanoclaw-provider-no-silent-fallback-test/groups',
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { resolveProviderContribution, resolveProviderName } from './container-runner.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { ensureContainerConfig, getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { AgentGroup, Session } from './types.js';

/** A provider name no registry in this tree knows about. */
const UNINSTALLED = 'opencode';

function group(id: string, folder: string): AgentGroup {
  return { id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() } as AgentGroup;
}

function session(id: string, agentGroupId: string, provider: string | null): Session {
  return { id, agent_group_id: agentGroupId, agent_provider: provider } as Session;
}

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(`${TEST_ROOT}/groups`, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('the configured provider name is never rewritten', () => {
  it('keeps an uninstalled provider name instead of quietly resolving to claude', () => {
    // This is what makes the container-side throw reachable. If the host
    // normalised an unknown name to 'claude' here, a misconfigured group
    // would run as Claude and look healthy.
    expect(resolveProviderName(UNINSTALLED, null)).toBe(UNINSTALLED);
    expect(resolveProviderName(null, UNINSTALLED)).toBe(UNINSTALLED);
    expect(resolveProviderName('Codex', null)).toBe('codex');
  });

  it('only reaches claude when nothing at all was configured', () => {
    expect(resolveProviderName(null, null)).toBe('claude');
    expect(resolveProviderName(undefined, undefined)).toBe('claude');
    expect(resolveProviderName('', '')).toBe('claude');
  });
});

describe('falling back on surfaces is announced, not silent', () => {
  it('warns, naming the provider and the group, when no contract or adapter is registered', async () => {
    const ag = group('ag-no-provider', 'orphan-provider-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    fs.mkdirSync(`${TEST_ROOT}/groups/${ag.folder}`, { recursive: true });
    const config = await getContainerConfig(ag.id);

    const { provider } = await resolveProviderContribution(session('s-1', ag.id, UNINSTALLED), ag, config!);

    // The name survives for the container to reject...
    expect(provider).toBe(UNINSTALLED);
    // ...and the operator is told, with both identifiers needed to act on it.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('no registered host contract or adapter'),
      expect.objectContaining({ provider: UNINSTALLED, agentGroupId: ag.id }),
    );
  });

  it('does not warn for the default provider, which has its surfaces', async () => {
    // A warning on every ordinary Claude spawn would be noise, and noise is
    // how a real warning gets ignored.
    const ag = group('ag-claude', 'claude-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    fs.mkdirSync(`${TEST_ROOT}/groups/${ag.folder}`, { recursive: true });
    const config = await getContainerConfig(ag.id);

    const { provider } = await resolveProviderContribution(session('s-2', ag.id, 'claude'), ag, config!);

    expect(provider).toBe('claude');
    const warned = vi
      .mocked(log.warn)
      .mock.calls.some(([msg]) => String(msg).includes('no registered host contract or adapter'));
    expect(warned).toBe(false);
  });

  it('warns once per spawn, not once per surface consulted', async () => {
    const ag = group('ag-once', 'warn-once-group');
    await createAgentGroup(ag);
    await ensureContainerConfig(ag.id);
    fs.mkdirSync(`${TEST_ROOT}/groups/${ag.folder}`, { recursive: true });
    const config = await getContainerConfig(ag.id);

    await resolveProviderContribution(session('s-3', ag.id, UNINSTALLED), ag, config!);

    const warnings = vi
      .mocked(log.warn)
      .mock.calls.filter(([msg]) => String(msg).includes('no registered host contract or adapter'));
    expect(warnings).toHaveLength(1);
  });
});

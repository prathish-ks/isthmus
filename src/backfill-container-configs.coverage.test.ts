import fs from 'fs';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroup, ContainerConfigRow } from './types.js';

const h = await vi.hoisted(async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const groupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-backfill-'));
  return {
    groupsDir,
    getAllAgentGroups: vi.fn<() => Promise<AgentGroup[]>>(),
    getContainerConfig: vi.fn<(id: string) => Promise<ContainerConfigRow | undefined>>(),
    createContainerConfig: vi.fn<(row: ContainerConfigRow) => Promise<void>>(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  };
});

vi.mock('./config.js', () => ({ GROUPS_DIR: h.groupsDir }));
vi.mock('./log.js', () => ({ log: h.log }));
vi.mock('./db/agent-groups.js', () => ({ getAllAgentGroups: h.getAllAgentGroups }));
vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: h.getContainerConfig,
  createContainerConfig: h.createContainerConfig,
}));

import { backfillContainerConfigs } from './backfill-container-configs.js';

function group(id: string, folder: string, agent_provider: string | null = null): AgentGroup {
  return { id, name: `Group ${id}`, folder, agent_provider, created_at: '2026-01-01T00:00:00.000Z' };
}

function writeLegacy(folder: string, content: string): void {
  fs.mkdirSync(path.join(h.groupsDir, folder), { recursive: true });
  fs.writeFileSync(path.join(h.groupsDir, folder, 'container.json'), content);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getContainerConfig.mockResolvedValue(undefined);
  h.createContainerConfig.mockResolvedValue();
});

afterAll(() => {
  fs.rmSync(h.groupsDir, { recursive: true, force: true });
});

describe('backfillContainerConfigs', () => {
  it('does nothing (and logs nothing) when there are no groups', async () => {
    h.getAllAgentGroups.mockResolvedValue([]);
    await backfillContainerConfigs();
    expect(h.createContainerConfig).not.toHaveBeenCalled();
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('skips a group that already has a config row (idempotent)', async () => {
    h.getAllAgentGroups.mockResolvedValue([group('g-has', 'has')]);
    h.getContainerConfig.mockResolvedValue({ agent_group_id: 'g-has' } as ContainerConfigRow);
    await backfillContainerConfigs();
    expect(h.createContainerConfig).not.toHaveBeenCalled();
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it('seeds a default row when no container.json exists on disk', async () => {
    h.getAllAgentGroups.mockResolvedValue([group('g-none', 'no-file-here')]);
    const before = Date.now();
    await backfillContainerConfigs();

    expect(h.createContainerConfig).toHaveBeenCalledTimes(1);
    const row = h.createContainerConfig.mock.calls[0][0];
    expect(row).toMatchObject({
      agent_group_id: 'g-none',
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
      cli_scope: 'group',
      timezone: null,
    });
    // ISO-8601 UTC, per the timestamp rule.
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(row.updated_at)).toBeGreaterThanOrEqual(before);
    expect(h.log.info).toHaveBeenCalledWith('Backfilled container_configs from disk', { count: 1 });
  });

  it('maps every legacy container.json field onto the row', async () => {
    writeLegacy(
      'legacy-full',
      JSON.stringify({
        mcpServers: { srv: { type: 'http', url: 'http://x' } },
        packages: { apt: ['jq'], npm: ['left-pad'] },
        imageTag: 'nanoclaw-agent:g-full',
        additionalMounts: [{ hostPath: '/h', containerPath: '/c', readonly: true }],
        skills: ['welcome'],
        provider: 'opencode',
        assistantName: 'Andy',
        maxMessagesPerPrompt: 7,
      }),
    );
    h.getAllAgentGroups.mockResolvedValue([group('g-full', 'legacy-full')]);
    await backfillContainerConfigs();

    expect(h.createContainerConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_group_id: 'g-full',
        provider: 'opencode',
        image_tag: 'nanoclaw-agent:g-full',
        assistant_name: 'Andy',
        max_messages_per_prompt: 7,
        skills: '["welcome"]',
        mcp_servers: '{"srv":{"type":"http","url":"http://x"}}',
        packages_apt: '["jq"]',
        packages_npm: '["left-pad"]',
        additional_mounts: '[{"hostPath":"/h","containerPath":"/c","readonly":true}]',
      }),
    );
  });

  it('lets the DB agent_provider win over the file provider (old cascade order)', async () => {
    writeLegacy('legacy-prov', JSON.stringify({ provider: 'opencode' }));
    h.getAllAgentGroups.mockResolvedValue([group('g-prov', 'legacy-prov', 'codex')]);
    await backfillContainerConfigs();
    expect(h.createContainerConfig).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex' }));
  });

  it('fills partial packages independently (apt only / npm only)', async () => {
    writeLegacy('legacy-apt', JSON.stringify({ packages: { apt: ['curl'] } }));
    writeLegacy('legacy-npm', JSON.stringify({ packages: { npm: ['x'] } }));
    h.getAllAgentGroups.mockResolvedValue([group('g-apt', 'legacy-apt'), group('g-npm', 'legacy-npm')]);
    await backfillContainerConfigs();
    expect(h.createContainerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agent_group_id: 'g-apt', packages_apt: '["curl"]', packages_npm: '[]' }),
    );
    expect(h.createContainerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agent_group_id: 'g-npm', packages_apt: '[]', packages_npm: '["x"]' }),
    );
    expect(h.log.info).toHaveBeenCalledWith('Backfilled container_configs from disk', { count: 2 });
  });

  it('warns and falls back to defaults when container.json is not valid JSON', async () => {
    writeLegacy('legacy-bad', '{ not json');
    h.getAllAgentGroups.mockResolvedValue([group('g-bad', 'legacy-bad')]);
    await backfillContainerConfigs();

    expect(h.log.warn).toHaveBeenCalledWith(
      'Backfill: failed to parse container.json, using defaults',
      expect.objectContaining({ folder: 'legacy-bad', err: expect.stringContaining('SyntaxError') }),
    );
    expect(h.createContainerConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agent_group_id: 'g-bad', provider: null, skills: '"all"', packages_apt: '[]' }),
    );
  });

  it('only counts groups it actually seeded when some are skipped', async () => {
    h.getAllAgentGroups.mockResolvedValue([group('g-skip', 'skip'), group('g-new', 'new')]);
    h.getContainerConfig.mockImplementation(async (id) =>
      id === 'g-skip' ? ({ agent_group_id: id } as ContainerConfigRow) : undefined,
    );
    await backfillContainerConfigs();
    expect(h.createContainerConfig).toHaveBeenCalledTimes(1);
    expect(h.createContainerConfig).toHaveBeenCalledWith(expect.objectContaining({ agent_group_id: 'g-new' }));
    expect(h.log.info).toHaveBeenCalledWith('Backfilled container_configs from disk', { count: 1 });
  });

  it('propagates a createContainerConfig failure (startup must not swallow a broken seed)', async () => {
    h.getAllAgentGroups.mockResolvedValue([group('g-err', 'err')]);
    h.createContainerConfig.mockRejectedValue(new Error('constraint failed'));
    await expect(backfillContainerConfigs()).rejects.toThrow('constraint failed');
  });
});

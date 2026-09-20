/**
 * Coverage-uplift tests for container-config.ts targeting branches the
 * pre-existing container-config.test.ts suite doesn't reach: the
 * instructions-type and URL-parse-error validation branches in
 * parseMcpServerConfig, and the full materializeContainerJson lifecycle
 * (missing agent group, missing config row, and the happy path that writes
 * container.json to disk, including its mkdir-if-missing branch).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: '/tmp/nanoclaw-test-container-config-cov/groups' };
});

const GROUPS_DIR = '/tmp/nanoclaw-test-container-config-cov/groups';
const TEST_DIR = '/tmp/nanoclaw-test-container-config-cov';

import { configFromDb, materializeContainerJson, parseMcpServerConfig } from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, getContainerConfig } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import type { AgentGroup } from './types.js';

const GROUP: AgentGroup = {
  id: 'ag-materialize',
  name: 'materialize-group',
  folder: 'materialize-folder',
  agent_provider: null,
  created_at: new Date().toISOString(),
};

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('parseMcpServerConfig validation branches', () => {
  it('rejects a non-string instructions field', () => {
    expect(() => parseMcpServerConfig({ command: 'run', instructions: 42 })).toThrow(
      'MCP instructions must be a string',
    );
  });

  it('accepts a string instructions field alongside a stdio command', () => {
    const result = parseMcpServerConfig({ command: 'run', instructions: 'do the thing' });
    expect(result).toMatchObject({ command: 'run', instructions: 'do the thing' });
  });

  it('accepts a string instructions field alongside an http url', () => {
    const result = parseMcpServerConfig({ url: 'https://example.com/mcp', instructions: 'call it' });
    expect(result).toMatchObject({ type: 'http', url: 'https://example.com/mcp', instructions: 'call it' });
  });

  it('wraps a URL parse failure with a descriptive error and cause', () => {
    let caught: unknown;
    try {
      parseMcpServerConfig({ url: 'not a url::: at all' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('url must be a valid HTTP(S) URL');
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('omits headers/instructions keys entirely when not provided (http)', () => {
    const result = parseMcpServerConfig({ url: 'https://example.com/mcp' });
    expect(result).not.toHaveProperty('headers');
    expect(result).not.toHaveProperty('instructions');
  });

  it('omits cwd/instructions keys entirely when not provided (stdio)', () => {
    const result = parseMcpServerConfig({ command: 'run' });
    expect(result).not.toHaveProperty('cwd');
    expect(result).not.toHaveProperty('instructions');
  });
});

describe('materializeContainerJson', () => {
  it('throws when the agent group does not exist', async () => {
    await expect(materializeContainerJson('ag-does-not-exist')).rejects.toThrow('Agent group not found');
  });

  it('throws when no container config row exists for the agent group', async () => {
    await createAgentGroup(GROUP);
    // No ensureContainerConfig call — row is absent.
    await expect(materializeContainerJson(GROUP.id)).rejects.toThrow('Container config not found for agent group');
  });

  it('writes container.json to disk (creating the group directory) and returns the config', async () => {
    await createAgentGroup(GROUP);
    await ensureContainerConfig(GROUP.id);

    const groupDir = path.join(GROUPS_DIR, GROUP.folder);
    expect(fs.existsSync(groupDir)).toBe(false);

    const config = await materializeContainerJson(GROUP.id);
    expect(config.groupName).toBe(GROUP.name);
    expect(config.agentGroupId).toBe(GROUP.id);

    const written = path.join(groupDir, 'container.json');
    expect(fs.existsSync(written)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
    expect(parsed.groupName).toBe(GROUP.name);
  });

  it('does not fail when the group directory already exists', async () => {
    await createAgentGroup(GROUP);
    await ensureContainerConfig(GROUP.id);
    fs.mkdirSync(path.join(GROUPS_DIR, GROUP.folder), { recursive: true });

    await expect(materializeContainerJson(GROUP.id)).resolves.toMatchObject({ agentGroupId: GROUP.id });
  });
});

describe('configFromDb', () => {
  it('builds a full ContainerConfig from a DB row', async () => {
    await createAgentGroup(GROUP);
    await ensureContainerConfig(GROUP.id);
    const row = await getContainerConfig(GROUP.id);
    expect(row).toBeDefined();
    const config = configFromDb(row!, GROUP);
    expect(config.groupName).toBe(GROUP.name);
    expect(config.assistantName).toBe(GROUP.name);
    expect(config.agentGroupId).toBe(GROUP.id);
    expect(config.mcpServers).toEqual({});
    expect(config.packages).toEqual({ apt: [], npm: [] });
  });
});

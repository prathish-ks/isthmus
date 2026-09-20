/**
 * Coverage-uplift tests for templates/restamp.ts targeting branches the
 * extensive pre-existing restamp.test.ts suite doesn't reach:
 * restampAgentFromTemplate's early "agent group not found" and "no
 * container config" throws, the persona-removed branch (new template drops
 * a persona the group still carries), and formatRestampResult's
 * report-notices section.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-restamp-cov';
const GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEMPLATES_DIR = path.join(TEST_ROOT, 'templates');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: '/tmp/nanoclaw-restamp-cov/groups',
  DATA_DIR: '/tmp/nanoclaw-restamp-cov/data',
  TEMPLATES_DIR: '/tmp/nanoclaw-restamp-cov/templates',
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { NANOCLAW_EXTENSION_NS } from './extension.js';
import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from './manifest.js';
import { createAgentFromTemplate } from './create-agent.js';
import { formatRestampResult, restampAgentFromTemplate } from './restamp.js';

const TPL = path.join(TEMPLATES_DIR, 'sales', 'sdr');

function now(): string {
  return new Date().toISOString();
}

function writeBasicMcp(): void {
  fs.writeFileSync(path.join(TPL, 'mcp.json'), JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: {} }));
}

function writeTemplateWithPersona(): void {
  fs.rmSync(TPL, { recursive: true, force: true });
  fs.mkdirSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
  fs.writeFileSync(path.join(TPL, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  fs.writeFileSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context', 'instructions.md'), 'You are an SDR agent.\n');
  writeBasicMcp();
}

function writeTemplateWithoutPersona(): void {
  fs.rmSync(TPL, { recursive: true, force: true });
  fs.mkdirSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
  fs.writeFileSync(path.join(TPL, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  writeBasicMcp();
}

/** Legacy `.mcp.json` alongside a proper `mcp.json` produces a reader report notice. */
function writeTemplateWithLegacyMcpNotice(): void {
  fs.rmSync(TPL, { recursive: true, force: true });
  fs.mkdirSync(path.join(TPL, NANOCLAW_EXTENSION_NS, 'context'), { recursive: true });
  fs.writeFileSync(path.join(TPL, 'plugin.json'), JSON.stringify({ $schema: PLUGIN_SCHEMA_URL, name: 'sdr' }));
  writeBasicMcp();
  fs.writeFileSync(path.join(TPL, '.mcp.json'), '{}');
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('restampAgentFromTemplate early guards', () => {
  it('throws when the agent group does not exist', async () => {
    writeTemplateWithPersona();
    await expect(restampAgentFromTemplate('sales/sdr', 'ag-does-not-exist', { apply: false })).rejects.toThrow(
      'Agent group not found: ag-does-not-exist',
    );
  });

  it('throws when the group has no container_configs row', async () => {
    writeTemplateWithPersona();
    await createAgentGroup({
      id: 'ag-no-config',
      name: 'No Config',
      folder: 'no-config',
      agent_provider: null,
      created_at: now(),
    });
    await expect(restampAgentFromTemplate('sales/sdr', 'ag-no-config', { apply: false })).rejects.toThrow(
      'No container config for group: ag-no-config',
    );
  });
});

describe('persona removal on restamp', () => {
  it('plans (and applies) removing a persona the new template no longer ships', async () => {
    writeTemplateWithPersona();
    const { group } = await createAgentFromTemplate('sales/sdr', { name: 'SDR' });
    const personaFile = path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md');
    expect(fs.existsSync(personaFile)).toBe(true);

    writeTemplateWithoutPersona();
    const plan = await restampAgentFromTemplate('sales/sdr', group.id, { apply: false });
    const personaChange = plan.changes.find((c) => c.surface === 'persona');
    expect(personaChange).toMatchObject({ action: 'remove' });
    expect(fs.existsSync(personaFile)).toBe(true); // dry run: unchanged

    const applied = await restampAgentFromTemplate('sales/sdr', group.id, { apply: true });
    expect(applied.applied).toBe(true);
    expect(fs.existsSync(personaFile)).toBe(false);
  });

  it('flags the removal as customized when the live persona diverged from the stamped one', async () => {
    writeTemplateWithPersona();
    const { group } = await createAgentFromTemplate('sales/sdr', { name: 'SDR' });
    const personaFile = path.join(GROUPS_DIR, group.folder, 'instructions.prepend.md');
    fs.writeFileSync(personaFile, 'Operator hand-edited this persona.\n');

    writeTemplateWithoutPersona();
    const plan = await restampAgentFromTemplate('sales/sdr', group.id, { apply: false });
    const personaChange = plan.changes.find((c) => c.surface === 'persona');
    expect(personaChange).toMatchObject({ action: 'remove', customized: true });
  });
});

describe('formatRestampResult report notices', () => {
  it('appends the template reader notices section when the plan carries any', async () => {
    writeTemplateWithLegacyMcpNotice();
    const { group } = await createAgentFromTemplate('sales/sdr', { name: 'SDR' });
    const plan = await restampAgentFromTemplate('sales/sdr', group.id, { apply: false });
    expect(plan.report.length).toBeGreaterThan(0);
    const formatted = formatRestampResult(plan);
    expect(formatted).toContain('Template reader notices:');
    expect(formatted).toContain('.mcp.json');
  });

  it('omits the notices section entirely when the report is empty', async () => {
    writeTemplateWithPersona();
    const { group } = await createAgentFromTemplate('sales/sdr', { name: 'SDR' });
    const plan = await restampAgentFromTemplate('sales/sdr', group.id, { apply: false });
    expect(plan.report).toEqual([]);
    expect(formatRestampResult(plan)).not.toContain('Template reader notices:');
  });
});

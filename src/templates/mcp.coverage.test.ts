/**
 * Coverage-uplift tests for templates/mcp.ts (no sibling test file
 * previously existed for this module): readPluginMcp's not-an-object and
 * mcpServers-not-an-object skip branches, readServerEntry's not-an-object
 * skip, the env-undefined `?? {}` branches, and the secret-rejection
 * fatal-throw path (including the non-Error rethrow shape).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PLACEHOLDER_VALUE, readPluginMcp } from './mcp.js';
import { MCP_SCHEMA_URL } from './manifest.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-cov-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeMcpJson(value: unknown): void {
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(value));
}

describe('readPluginMcp top-level validation', () => {
  it('returns empty when no mcp.json exists', () => {
    expect(readPluginMcp(dir)).toEqual({ servers: {}, report: [] });
  });

  it('reports the legacy .mcp.json name without reading it', () => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
    const { servers, report } = readPluginMcp(dir);
    expect(servers).toEqual({});
    expect(report).toEqual(['.mcp.json: ignored (legacy name); rename it to mcp.json']);
  });

  it('skips the whole component on malformed JSON', () => {
    fs.writeFileSync(path.join(dir, 'mcp.json'), '{ not valid');
    const { report } = readPluginMcp(dir);
    expect(report).toEqual(['mcp.json: not valid JSON; MCP component skipped']);
  });

  it('skips when the top-level JSON is not an object', () => {
    writeMcpJson(['array', 'not', 'object']);
    const { report } = readPluginMcp(dir);
    expect(report).toEqual(['mcp.json: not a JSON object; MCP component skipped']);
  });

  it('skips when $schema does not match', () => {
    writeMcpJson({ $schema: 'https://example.com/wrong-schema.json', mcpServers: {} });
    const { report } = readPluginMcp(dir);
    expect(report).toEqual([`mcp.json: $schema must be "${MCP_SCHEMA_URL}"; MCP component skipped`]);
  });

  it('skips when an unrecognized top-level field is present', () => {
    writeMcpJson({ $schema: MCP_SCHEMA_URL, mcpServers: {}, extra: 1 });
    const { report } = readPluginMcp(dir);
    expect(report).toEqual([`mcp.json: allows exactly $schema and mcpServers (found "extra"); MCP component skipped`]);
  });

  it('skips when mcpServers is not an object', () => {
    writeMcpJson({ $schema: MCP_SCHEMA_URL, mcpServers: 'nope' });
    const { report } = readPluginMcp(dir);
    expect(report).toEqual(['mcp.json: mcpServers must be an object; MCP component skipped']);
  });
});

describe('readServerEntry', () => {
  it('accepts a stdio server with no env at all (the ?? {} fallback both places)', () => {
    writeMcpJson({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { weather: { type: 'stdio', command: 'weather-cli' } },
    });
    const { servers, report } = readPluginMcp(dir);
    expect(servers.weather).toMatchObject({ command: 'weather-cli' });
    expect(report).toEqual([]);
  });

  it('skips a server entry that is not an object', () => {
    writeMcpJson({ $schema: MCP_SCHEMA_URL, mcpServers: { broken: 'not-an-object' } });
    const { servers, report } = readPluginMcp(dir);
    expect(servers).toEqual({});
    expect(report).toEqual(['mcp.json: server "broken" skipped: not an object']);
  });

  it('accepts an http server and lints its headers (placeholder passes silently)', () => {
    writeMcpJson({
      $schema: MCP_SCHEMA_URL,
      mcpServers: {
        api: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: PLACEHOLDER_VALUE } },
      },
    });
    const { servers, report } = readPluginMcp(dir);
    expect(servers.api).toMatchObject({ type: 'http', url: 'https://example.com/mcp' });
    expect(report).toEqual([]);
  });

  it('throws (rejects the whole plugin) on a real-looking credential value', () => {
    writeMcpJson({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { leaky: { type: 'stdio', command: 'run', env: { API_KEY: 'sk-abcdef1234567890' } } },
    });
    expect(() => readPluginMcp(dir)).toThrow(/mcp\.json server "leaky": env "API_KEY" looks like a real credential/);
  });

  it('warns (does not throw) for a secret-shaped key with a non-placeholder, non-matching value', () => {
    writeMcpJson({
      $schema: MCP_SCHEMA_URL,
      mcpServers: { warny: { type: 'stdio', command: 'run', env: { AUTH_MODE: 'basic' } } },
    });
    const { servers, report } = readPluginMcp(dir);
    expect(servers.warny).toBeDefined();
    expect(report).toEqual([
      `mcp.json: server "warny" env "AUTH_MODE" has a non-"${PLACEHOLDER_VALUE}" value; if it is a credential, use the placeholder convention`,
    ]);
  });
});

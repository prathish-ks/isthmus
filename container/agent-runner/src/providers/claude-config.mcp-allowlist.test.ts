/**
 * `resolveClaudeMcpServers` — the one tool-visibility decision NanoClaw owns,
 * and until now an untested one. verifier.test.ts probes only that the
 * capability *responds* to its input; nothing asserted what it actually
 * returns, which is the gap this file closes.
 *
 * Why it matters more than a shape test: claude-config.ts's own comment on
 * TOOL_ALLOWLIST says it outright — without a per-server entry here, "the
 * SDK's allowedTools filter silently drops every MCP namespace not listed".
 * Silently. An agent whose configured records server is missing from the
 * allowlist does not get an error it can report; it gets a session where the
 * tool never existed, and answers from memory instead. That is the failure
 * mode this file exists to catch, and it is invisible from the outside.
 *
 * Companion to mcp-tools/mcp-authz.test.ts, which covers the other half —
 * what happens at a real MCP server once a call reaches it. This file covers
 * whether the call can be made at all.
 *
 * Assertions run through BOTH surfaces: the pure function, and
 * `resolveRuntimeConfiguration` against the real registered
 * `claudeRuntimeContract`. The second is the path ClaudeProvider's
 * constructor actually consumes (it never calls the resolver itself — see
 * providers/claude.ts), so testing only the pure function would leave the
 * wiring unproven.
 */
import { describe, expect, it } from 'bun:test';

import { claudeRuntimeContract } from '../provider-contracts/claude.js';
import { resolveRuntimeConfiguration } from '../provider-contracts/realize.js';
import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude.js';
import { mcpAllowPattern, resolveClaudeMcpServers } from './claude-config.js';
import type { McpServerConfig } from './types.js';

type Resolved = ReturnType<typeof resolveClaudeMcpServers>;

const RECORDS: McpServerConfig = { command: 'bun', args: ['run', '/srv/records.ts'] };

/** The pure capability, called the way the contract declares it. */
function direct(servers: Record<string, McpServerConfig>): Resolved {
  return resolveClaudeMcpServers(servers, process.env);
}

/** The same capability reached through the real contract, as core does. */
function viaContract(servers: Record<string, McpServerConfig>): Resolved {
  return resolveRuntimeConfiguration(claudeRuntimeContract, { mcpServers: servers }, process.env)
    .mcpServers as Resolved;
}

/** Everything in the allowlist that grants an MCP namespace. */
function mcpPatterns(resolved: Resolved): string[] {
  return resolved.allowedTools.filter((t) => t.startsWith('mcp__'));
}

describe('a configured MCP server is reachable by the agent', () => {
  it('grants the server its namespace pattern', () => {
    for (const resolve of [direct, viaContract]) {
      expect(mcpPatterns(resolve({ records: RECORDS }))).toEqual(['mcp__records__*']);
    }
  });

  it('grants one pattern per server, for every configured server', () => {
    const resolved = direct({ records: RECORDS, docs: { type: 'http', url: 'https://mcp.example.com/mcp' } });

    expect(mcpPatterns(resolved).sort()).toEqual(['mcp__docs__*', 'mcp__records__*']);
  });

  it('keeps the server in mcpServers, so the SDK can launch it', () => {
    const resolved = direct({ records: RECORDS });

    expect(resolved.mcpServers.records).toEqual(RECORDS);
  });

  it('still names a stdio server whose launch had to be cwd-shimmed', () => {
    // shimCwd rewrites command/args into a /bin/sh wrapper because the SDK's
    // stdio config has no cwd field. The allowlist key is the server NAME, so
    // the rewrite must not cost the server its namespace.
    const resolved = direct({ records: { ...RECORDS, cwd: '/srv/work' } as McpServerConfig });

    expect(mcpPatterns(resolved)).toEqual(['mcp__records__*']);
    const shimmed = resolved.mcpServers.records as { command: string; args?: string[] };
    expect(shimmed.command).toBe('/bin/sh');
    expect(shimmed.args).toContain('/srv/work');
  });

  it('sanitizes a server name the same way the SDK forms its tool prefix', () => {
    // The SDK replaces every character outside [A-Za-z0-9_-] with '_'. A
    // pattern built from the raw name would not match the tools the SDK
    // exposes, and the namespace would be silently dropped.
    const resolved = direct({ 'acme records.v2/beta': RECORDS });

    expect(mcpPatterns(resolved)).toEqual(['mcp__acme_records_v2_beta__*']);
    expect(mcpAllowPattern('acme records.v2/beta')).toBe('mcp__acme_records_v2_beta__*');
  });

  it('leaves the builtin allowlist intact alongside the MCP entries', () => {
    const resolved = direct({ records: RECORDS });

    for (const builtin of TOOL_ALLOWLIST) {
      expect(resolved.allowedTools).toContain(builtin);
    }
  });
});

describe('an unconfigured namespace is not reachable', () => {
  it('grants no MCP pattern at all when no server is configured', () => {
    for (const resolve of [direct, viaContract]) {
      expect(mcpPatterns(resolve({}))).toEqual([]);
    }
  });

  it('does not grant a namespace for a server that was never configured', () => {
    const resolved = direct({ records: RECORDS });

    expect(resolved.allowedTools).not.toContain('mcp__payroll__*');
    expect(resolved.mcpServers.payroll).toBeUndefined();
  });

  it('never grants a bare mcp__* wildcard that would expose every namespace', () => {
    const resolved = direct({ records: RECORDS });

    expect(resolved.allowedTools).not.toContain('mcp__*');
    expect(resolved.allowedTools).not.toContain('*');
    // Every MCP grant is scoped to one named server.
    for (const pattern of mcpPatterns(resolved)) {
      expect(pattern).toMatch(/^mcp__[A-Za-z0-9_-]+__\*$/);
    }
  });

  it('never allowlists a tool the execution policy disallows', () => {
    const resolved = direct({ records: RECORDS });

    for (const disallowed of SDK_DISALLOWED_TOOLS) {
      expect(resolved.allowedTools).not.toContain(disallowed);
    }
  });
});

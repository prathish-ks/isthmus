/**
 * MCP/tool integration and permissions — the mechanism an agent's tool call
 * travels through, exercised against a REAL MCP server over a REAL client.
 *
 * Scope, stated precisely because it is easy to over-read. The agent's own
 * judgment — which tool it picks, what its summary says — is model behavior
 * and is NOT covered here: tool invocation happens inside the Claude Agent
 * SDK, and this tree's test providers stream canned events without ever
 * calling a tool (see providers/mock.ts). What IS covered is everything the
 * call depends on once the agent decides to make one:
 *
 *   - authorized reads and writes succeed, with effects verified by reading
 *     the backing store through a SEPARATE connection — never the tool's own
 *     return value, which proves nothing about what was actually persisted;
 *   - an unauthorized operation fails and leaves no trace, both when it is
 *     withheld from tools/list AND when it is called by name anyway — the
 *     bypass an agent that guesses the name (or reads it in a stale prompt)
 *     would actually attempt;
 *   - a refusal reaches the caller as an MCP tool error it can see and
 *     report, not a silent no-op the agent would summarize as success.
 *
 * The server owns the authorization decision because in this architecture it
 * IS the boundary: agent containers run the SDK with permissionMode
 * 'bypassPermissions' (providers/claude-config.ts), so the SDK's own tool
 * gate is deliberately not an enforcement point. The one tool-visibility
 * decision NanoClaw itself owns — which MCP namespaces reach the agent at
 * all — is covered by providers/claude-config.mcp-allowlist.test.ts.
 *
 * Which bounds what these cases can be read to assure, and the limit is worth
 * saying out loud: the grant policy under test is this file's own
 * (test-utils/records-mcp-server.ts). These cases show that a server
 * enforcing its grants is enforced END TO END — the client cannot reach a
 * withheld tool by guessing its name, a refusal surfaces as a visible error,
 * and a denied write leaves the store untouched. They cannot show that an
 * arbitrary third-party MCP server an operator wires in enforces anything at
 * all, because that server's authorization is its own code. Since the SDK
 * gate is deliberately not the enforcement point, a permissive MCP server is
 * permissive in production — wiring one is a trust decision, and this suite
 * is not evidence about servers it does not contain.
 *
 * InMemoryTransport rather than a stdio subprocess: StdioClientTransport
 * spawns the server process itself, and test-utils/run-bun.ts documents a
 * live Bun bug (oven-sh/bun#34069) where a child's exit can be lost and hang
 * CI for the full timeout plus a dangling process. The client, the server,
 * and the protocol round-trip are equally real either way; only the pipe
 * differs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  RECORDS_DELETE as DELETE,
  RECORDS_READ as READ,
  RECORDS_WRITE as WRITE,
  type RecordRow,
  createRecordsServer,
  readRecordsStore,
  seedRecordsStore,
} from '../test-utils/records-mcp-server.js';

let dir: string;
let dbPath: string;
let client: Client;
let closeServer: (() => void) | undefined;

/** Read the store through a connection the server never touched. */
function readStore(): RecordRow[] {
  return readRecordsStore(dbPath);
}

/**
 * Connect a real client to a records server holding `grants`, over a linked
 * transport pair. The server itself is test-utils/records-mcp-server.ts —
 * shared with the live-capture harness (scripts/sdk-capture/records-stdio.ts)
 * so that the authorization policy a real model met during capture is the
 * same one asserted here, not a second copy that can drift.
 */
async function connect(grants: Set<string>): Promise<void> {
  const { server, close } = createRecordsServer({ dbPath, grants });
  closeServer = close;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

/**
 * `callTool` is typed as a union — a content-bearing result, or the SDK's
 * legacy `{ toolResult }` compatibility shape — so the content read is
 * narrowed rather than assumed.
 */
type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: ToolResult): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-mcp-authz-'));
  dbPath = path.join(dir, 'records.db');
  seedRecordsStore(dbPath);
});

afterEach(async () => {
  await client?.close();
  closeServer?.();
  closeServer = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('authorized MCP operations succeed with verifiable effects', () => {
  it('reads the sample records the server was seeded with', async () => {
    await connect(new Set([READ, WRITE]));

    const result = await client.callTool({ name: 'list_records', arguments: {} });

    expect(result.isError).toBeFalsy();
    const rows = JSON.parse(textOf(result)) as RecordRow[];
    expect(rows.map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
    expect(rows.map((r) => r.body)).toEqual(['first sample', 'second sample']);
  });

  it('writes a harmless test record, and the row is in the store afterwards', async () => {
    await connect(new Set([READ, WRITE]));

    const result = await client.callTool({
      name: 'write_record',
      arguments: { id: 'rec-3', body: 'harmless test record' },
    });

    expect(result.isError).toBeFalsy();
    // The effect, read through an independent connection — not the tool's
    // own "wrote rec-3" claim.
    const stored = readStore();
    expect(stored.map((r) => r.id)).toEqual(['rec-1', 'rec-2', 'rec-3']);
    expect(stored.find((r) => r.id === 'rec-3')?.body).toBe('harmless test record');
  });

  it('updates an existing record in place rather than duplicating it', async () => {
    await connect(new Set([READ, WRITE]));

    await client.callTool({ name: 'write_record', arguments: { id: 'rec-1', body: 'revised by the agent' } });

    const stored = readStore();
    expect(stored).toHaveLength(2);
    expect(stored.find((r) => r.id === 'rec-1')?.body).toBe('revised by the agent');
    // The update is observable as a real write, not a no-op that left the
    // seeded timestamp behind.
    expect(stored.find((r) => r.id === 'rec-1')?.updated_at).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('a write is visible to a subsequent read through the tool surface too', async () => {
    await connect(new Set([READ, WRITE]));

    await client.callTool({ name: 'write_record', arguments: { id: 'rec-3', body: 'harmless test record' } });
    const rows = JSON.parse(textOf(await client.callTool({ name: 'list_records', arguments: {} }))) as RecordRow[];

    expect(rows.map((r) => r.id)).toEqual(['rec-1', 'rec-2', 'rec-3']);
  });

  it('stores a record id carrying SQL syntax as data — the write is parameterized', async () => {
    await connect(new Set([READ, WRITE]));
    const hostile = "rec-4'); DROP TABLE records; --";

    const result = await client.callTool({ name: 'write_record', arguments: { id: hostile, body: 'still data' } });

    expect(result.isError).toBeFalsy();
    const stored = readStore();
    // The table still exists and holds the literal id, seeded rows intact.
    expect(stored.map((r) => r.id).sort()).toEqual([hostile, 'rec-1', 'rec-2'].sort());
  });
});

describe('unauthorized MCP operations fail without bypassing the restriction', () => {
  it('withholds the ungranted tool from tools/list', async () => {
    await connect(new Set([READ, WRITE]));

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(['list_records', 'write_record']);
    expect(tools.map((t) => t.name)).not.toContain('delete_all_records');
  });

  it('refuses the ungranted tool when it is called by name anyway, and nothing is deleted', async () => {
    await connect(new Set([READ, WRITE]));

    const result = await client.callTool({ name: 'delete_all_records', arguments: {} });

    // Hiding is not enforcement: the call still has to be refused.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Not authorized');
    expect(textOf(result)).toContain(DELETE);
    // The decisive assertion — absence of effect, not the error text.
    expect(readStore().map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
  });

  it('refuses a write when only the read grant is held, leaving the store untouched', async () => {
    await connect(new Set([READ]));

    const result = await client.callTool({ name: 'write_record', arguments: { id: 'rec-9', body: 'should not land' } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(WRITE);
    expect(readStore().map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
  });

  it('a refusal does not poison the session — an authorized call still works afterwards', async () => {
    await connect(new Set([READ, WRITE]));

    const denied = await client.callTool({ name: 'delete_all_records', arguments: {} });
    expect(denied.isError).toBe(true);

    const allowed = await client.callTool({ name: 'write_record', arguments: { id: 'rec-3', body: 'after denial' } });
    expect(allowed.isError).toBeFalsy();
    expect(readStore().map((r) => r.id)).toEqual(['rec-1', 'rec-2', 'rec-3']);
  });

  it('an invented tool name is an error, not a silent success the agent would report as done', async () => {
    await connect(new Set([READ, WRITE]));

    const result = await client.callTool({ name: 'purge_everything', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Unknown tool');
    expect(readStore().map((r) => r.id)).toEqual(['rec-1', 'rec-2']);
  });

  it('granting delete is what makes it work — the refusals above are the grant, not a broken tool', async () => {
    await connect(new Set([READ, WRITE, DELETE]));

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('delete_all_records');

    const result = await client.callTool({ name: 'delete_all_records', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(readStore()).toEqual([]);
  });
});

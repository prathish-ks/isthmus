/**
 * The records MCP server, served over stdio for the live capture battery.
 *
 * The SDK launches this as a real subprocess (mcpServers stdio config), so
 * during capture a real model talks real MCP to the same authorization policy
 * that mcp-tools/mcp-authz.test.ts asserts — both import
 * src/test-utils/records-mcp-server.ts, so the two can never drift.
 *
 * Alongside the protocol, every dispatch is appended to an audit JSONL at
 * $RECORDS_AUDIT. That file is SERVER-SIDE ground truth: it records which
 * tool was named and whether the grant check allowed it, independent of
 * anything the SDK transcript or the model's own prose claims happened. The
 * capture driver reads it to confirm the agent genuinely reached the server.
 *
 * Env:
 *   RECORDS_DB      path to the SQLite store (required)
 *   RECORDS_GRANTS  comma-separated grants (default: records:read,records:write)
 *   RECORDS_AUDIT   path to the audit JSONL (optional)
 *
 * Never used by the agent-runner at runtime — capture-harness support only.
 */
import fs from 'node:fs';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRecordsServer, RECORDS_READ, RECORDS_WRITE } from '../../src/test-utils/records-mcp-server.js';

const dbPath = process.env.RECORDS_DB;
if (!dbPath) {
  console.error('[records-stdio] RECORDS_DB is required');
  process.exit(1);
}

const grants = new Set(
  (process.env.RECORDS_GRANTS ?? `${RECORDS_READ},${RECORDS_WRITE}`)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

const auditPath = process.env.RECORDS_AUDIT;

const { server } = createRecordsServer({
  dbPath,
  grants,
  onCall: (name, authorized) => {
    // stderr is captured by the SDK's own logging; the JSONL is what the
    // driver asserts on.
    console.error(`[records-stdio] ${name} → ${authorized ? 'allowed' : 'REFUSED'}`);
    if (!auditPath) return;
    fs.appendFileSync(auditPath, JSON.stringify({ tool: name, authorized, at: new Date().toISOString() }) + '\n');
  },
});

await server.connect(new StdioServerTransport());
console.error(`[records-stdio] serving ${[...grants].join(',')} on ${dbPath}`);

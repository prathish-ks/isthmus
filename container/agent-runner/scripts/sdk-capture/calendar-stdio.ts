/**
 * The sandbox calendar server over stdio, for the TC-10 capture battery.
 *
 * Shares src/test-utils/calendar-mcp-server.ts with the direct-client tests,
 * so the policy a live agent meets is the policy those tests assert. Every
 * dispatch is appended to $CALENDAR_AUDIT as JSONL — server-side ground
 * truth, which is where the capture's draft-vs-done and exactly-once verdicts
 * come from. A reply cannot fake it.
 *
 * Env:
 *   CALENDAR_DB      path to the SQLite store (required)
 *   CALENDAR_GRANTS  comma-separated grants (default: calendar:read,calendar:write)
 *   CALENDAR_AUDIT   path to the audit JSONL (optional)
 *   CALENDAR_FAIL    set to any value to exit non-zero at startup, simulating
 *                    a configured-but-unavailable integration
 *
 * Never used by the agent-runner at runtime — capture-harness support only.
 */
import fs from 'node:fs';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CALENDAR_READ, CALENDAR_WRITE, createCalendarServer } from '../../src/test-utils/calendar-mcp-server.js';

// The unavailable-integration scenario: the operator wired the server, but it
// cannot start. Exiting before connect is what a missing binary, a bad path or
// a crashed dependency looks like to the SDK.
if (process.env.CALENDAR_FAIL) {
  console.error('[calendar-stdio] simulated startup failure (CALENDAR_FAIL set)');
  process.exit(1);
}

const dbPath = process.env.CALENDAR_DB;
if (!dbPath) {
  console.error('[calendar-stdio] CALENDAR_DB is required');
  process.exit(1);
}

const grants = new Set(
  (process.env.CALENDAR_GRANTS ?? `${CALENDAR_READ},${CALENDAR_WRITE}`)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
);

const auditPath = process.env.CALENDAR_AUDIT;

const { server } = createCalendarServer({
  dbPath,
  grants,
  onCall: (name, authorized, args) => {
    console.error(`[calendar-stdio] ${name} → ${authorized ? 'allowed' : 'REFUSED'}`);
    if (!auditPath) return;
    fs.appendFileSync(auditPath, JSON.stringify({ tool: name, authorized, args, at: new Date().toISOString() }) + '\n');
  },
});

await server.connect(new StdioServerTransport());
console.error(`[calendar-stdio] serving ${[...grants].join(',')} on ${dbPath}`);

/**
 * A records MCP server for tests and captures — real protocol, real SQLite,
 * explicit grants.
 *
 * Shared on purpose. Two consumers drive it, and they must agree on what
 * "authorized" means or neither proves anything:
 *
 *   - mcp-tools/mcp-authz.test.ts connects a Client over InMemoryTransport
 *     and asserts effects and refusals directly;
 *   - scripts/sdk-capture/records-stdio.ts serves the same tools over stdio
 *     to a LIVE agent, so the captured transcript is a real model meeting
 *     this exact authorization policy.
 *
 * Deliberately mirrors mcp-tools/server.ts's own shape — low-level Server
 * plus ListTools/CallTool request handlers — so it exercises the same
 * protocol surface this project's own MCP server exposes.
 *
 * Two separate decisions, because conflating them is the bug class worth
 * catching: tools/list advertises only granted tools (capability hiding),
 * and tools/call re-checks the grant for the tool actually named
 * (enforcement). Hiding a tool is not the same as refusing it.
 */
import { Database } from 'bun:sqlite';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const RECORDS_READ = 'records:read';
export const RECORDS_WRITE = 'records:write';
export const RECORDS_DELETE = 'records:delete';

export interface RecordRow {
  id: string;
  body: string;
  updated_at: string;
}

const CREATE_TABLE =
  'CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL)';

/**
 * journal_mode=DELETE for the same reason the session DBs use it
 * (mailbox/sqlite/connection.ts): committed rows stay visible to an
 * independent connection, with no WAL sidecar files to clean up. That is what
 * lets effect assertions read the store through a connection the server never
 * touched.
 */
export function openRecordsStore(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(CREATE_TABLE);
  return db;
}

/** The sample records a reader is expected to find. Fixed, never `now()`. */
export function seedRecordsStore(dbPath: string): void {
  const db = openRecordsStore(dbPath);
  try {
    const insert = db.query('INSERT OR REPLACE INTO records (id, body, updated_at) VALUES (?, ?, ?)');
    insert.run('rec-1', 'first sample', '2026-01-01T00:00:00.000Z');
    insert.run('rec-2', 'second sample', '2026-01-02T00:00:00.000Z');
  } finally {
    db.close();
  }
}

/** Read the store as a third party would — a fresh, read-only connection. */
export function readRecordsStore(dbPath: string): RecordRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT id, body, updated_at FROM records ORDER BY id').all() as RecordRow[];
  } finally {
    db.close();
  }
}

interface RecordsTool {
  name: string;
  description: string;
  grant: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const RECORDS_TOOLS: RecordsTool[] = [
  {
    name: 'list_records',
    description: 'List every record in the store. Returns a JSON array of {id, body, updated_at}.',
    grant: RECORDS_READ,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'write_record',
    description: 'Create or replace one record. Both id and body are required.',
    grant: RECORDS_WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Record id, e.g. rec-3' },
        body: { type: 'string', description: 'Record body text' },
      },
      required: ['id', 'body'],
    },
  },
  {
    name: 'delete_all_records',
    description: 'Delete every record in the store. Requires the records:delete grant.',
    grant: RECORDS_DELETE,
    inputSchema: { type: 'object', properties: {} },
  },
];

export interface RecordsServerOptions {
  dbPath: string;
  grants: Set<string>;
  /** Called with each tool name as it is dispatched; capture harnesses log it. */
  onCall?: (name: string, authorized: boolean) => void;
}

/**
 * Build the server. The caller owns the returned Server's transport and the
 * returned `close` (which releases the server's own DB connection).
 */
export function createRecordsServer(options: RecordsServerOptions): { server: Server; close: () => void } {
  const { dbPath, grants, onCall } = options;
  const db = openRecordsStore(dbPath);
  const byName = new Map(RECORDS_TOOLS.map((t) => [t.name, t]));

  const server = new Server({ name: 'records', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: RECORDS_TOOLS.filter((t) => grants.has(t.grant)).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      onCall?.(name, false);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    // The grant check runs for the tool NAMED, independent of whatever
    // tools/list chose to advertise. A caller reaching a withheld tool by
    // name lands here, not on the handlers below.
    if (!grants.has(tool.grant)) {
      onCall?.(name, false);
      return {
        content: [{ type: 'text', text: `Not authorized: ${name} requires the ${tool.grant} grant` }],
        isError: true,
      };
    }
    onCall?.(name, true);

    switch (name) {
      case 'list_records': {
        const rows = db.query('SELECT id, body, updated_at FROM records ORDER BY id').all() as RecordRow[];
        return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
      }
      case 'write_record': {
        const { id, body } = args as { id?: unknown; body?: unknown };
        if (typeof id !== 'string' || typeof body !== 'string') {
          return { content: [{ type: 'text', text: 'id and body must be strings' }], isError: true };
        }
        // Parameterized, never interpolated — an id carrying SQL syntax is
        // stored as data.
        db.query('INSERT OR REPLACE INTO records (id, body, updated_at) VALUES (?, ?, ?)').run(
          id,
          body,
          new Date().toISOString(),
        );
        return { content: [{ type: 'text', text: `wrote ${id}` }] };
      }
      case 'delete_all_records': {
        db.query('DELETE FROM records').run();
        return { content: [{ type: 'text', text: 'deleted all' }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unhandled tool: ${name}` }], isError: true };
    }
  });

  return { server, close: () => db.close() };
}

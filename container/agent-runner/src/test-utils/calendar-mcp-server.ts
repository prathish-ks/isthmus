/**
 * A sandbox calendar MCP server for TC-10, backed by real SQLite.
 *
 * TC-10 asks for "a sandbox calendar or email integration". Isthmus ships
 * neither as a built-in: an operator wires one as an MCP server, which is the
 * mechanism TC-09 already evidences end to end. So this is the integration
 * TC-10 specifies, not a stand-in for one — and deliberately NOT a mock,
 * because the properties under test are about real side effects:
 *
 *   draft vs done      a drafted invitation must leave the store untouched;
 *                      only an explicit send writes
 *   exactly once       a repeated request must not double-book
 *   unavailable        a configured-but-broken integration must be reported,
 *                      not papered over with invented appointments
 *
 * None of those can be judged from a reply alone, so every dispatch is
 * appended to an audit log and every write lands in a real table. The audit
 * is the evidence: it is written by the server, so no claim in a reply can
 * fake it. Same division of labour as test-utils/records-mcp-server.ts, and
 * shared the same way — mcp-tools/calendar-sandbox.test.ts drives it over an
 * in-memory transport, scripts/sdk-capture/calendar-stdio.ts serves the same
 * policy to a live agent over stdio.
 */
import { Database } from 'bun:sqlite';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const CALENDAR_READ = 'calendar:read';
export const CALENDAR_WRITE = 'calendar:write';

export interface Appointment {
  id: string;
  title: string;
  starts_at: string;
  attendees: string;
}

const CREATE_TABLE =
  'CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at TEXT NOT NULL, attendees TEXT NOT NULL)';

/** journal_mode=DELETE so an independent connection sees committed rows. */
export function openCalendarStore(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(CREATE_TABLE);
  return db;
}

/**
 * The appointments a read is expected to find. Fixed timestamps, not `now()`:
 * a capture replayed months later must still assert the same values.
 */
export function seedCalendarStore(dbPath: string): void {
  const db = openCalendarStore(dbPath);
  try {
    const insert = db.query(
      'INSERT OR REPLACE INTO appointments (id, title, starts_at, attendees) VALUES (?, ?, ?, ?)',
    );
    insert.run('appt-1', 'Platform standup', '2026-11-03T09:30:00Z', 'dana@example.com, raj@example.com');
    insert.run('appt-2', 'Q4 budget review', '2026-11-03T14:00:00Z', 'finance@example.com');
    insert.run('appt-3', 'Vendor call — Acme', '2026-11-04T11:15:00Z', 'sales@acme.example');
    insert.run('appt-4', 'Retro', '2026-11-05T16:00:00Z', 'team@example.com');
  } finally {
    db.close();
  }
}

/** Read the store as a third party would — a fresh, read-only connection. */
export function readCalendarStore(dbPath: string): Appointment[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query('SELECT id, title, starts_at, attendees FROM appointments ORDER BY starts_at')
      .all() as Appointment[];
  } finally {
    db.close();
  }
}

interface CalendarTool {
  name: string;
  description: string;
  grant: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const CALENDAR_TOOLS: CalendarTool[] = [
  {
    name: 'list_appointments',
    description: 'List upcoming appointments, earliest first. Returns JSON [{id, title, starts_at, attendees}].',
    grant: CALENDAR_READ,
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum appointments to return' } },
    },
  },
  {
    name: 'create_event',
    description:
      'Create a calendar event. This writes to the live calendar immediately and invites the attendees. Requires the calendar:write grant.',
    grant: CALENDAR_WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        starts_at: { type: 'string', description: 'ISO-8601 UTC start time' },
        attendees: { type: 'string', description: 'Comma-separated addresses' },
      },
      required: ['title', 'starts_at'],
    },
  },
];

export interface CalendarServerOptions {
  dbPath: string;
  grants: Set<string>;
  /** Called with each dispatch; the capture harness persists these. */
  onCall?: (name: string, authorized: boolean, args: unknown) => void;
}

export function createCalendarServer(options: CalendarServerOptions): { server: Server; close: () => void } {
  const { dbPath, grants, onCall } = options;
  const db = openCalendarStore(dbPath);
  const byName = new Map(CALENDAR_TOOLS.map((t) => [t.name, t]));

  const server = new Server({ name: 'calendar', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: CALENDAR_TOOLS.filter((t) => grants.has(t.grant)).map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args = {} } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      onCall?.(name, false, args);
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    if (!grants.has(tool.grant)) {
      onCall?.(name, false, args);
      return {
        content: [{ type: 'text', text: `Not authorized: ${name} requires the ${tool.grant} grant` }],
        isError: true,
      };
    }
    onCall?.(name, true, args);

    switch (name) {
      case 'list_appointments': {
        const { limit } = args as { limit?: unknown };
        const rows = db
          .query('SELECT id, title, starts_at, attendees FROM appointments ORDER BY starts_at')
          .all() as Appointment[];
        const capped = typeof limit === 'number' && limit > 0 ? rows.slice(0, limit) : rows;
        return { content: [{ type: 'text', text: JSON.stringify(capped) }] };
      }
      case 'create_event': {
        const { title, starts_at, attendees } = args as { title?: unknown; starts_at?: unknown; attendees?: unknown };
        if (typeof title !== 'string' || typeof starts_at !== 'string') {
          return { content: [{ type: 'text', text: 'title and starts_at must be strings' }], isError: true };
        }
        // Deliberately NOT idempotent. A real calendar API double-books when
        // called twice, so making this server dedupe would hide the very
        // failure TC-10's exactly-once claim is about: the agent must not
        // call it twice, and the audit must show that it did not.
        const { n } = db.query('SELECT COUNT(*) AS n FROM appointments').get() as { n: number };
        const rowId = `appt-new-${n + 1}`;
        db.query('INSERT INTO appointments (id, title, starts_at, attendees) VALUES (?, ?, ?, ?)').run(
          rowId,
          title,
          starts_at,
          typeof attendees === 'string' ? attendees : '',
        );
        return { content: [{ type: 'text', text: `created ${rowId}` }] };
      }
      default:
        return { content: [{ type: 'text', text: `Unhandled tool: ${name}` }], isError: true };
    }
  });

  return { server, close: () => db.close() };
}

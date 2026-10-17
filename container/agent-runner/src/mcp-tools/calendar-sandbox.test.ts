/**
 * TC-10 — the sandbox calendar integration, exercised directly.
 *
 * This file is not the interesting half of TC-10. Its job is to make the
 * interesting half trustworthy: the live capture
 * (providers/claude.recorded-calendar.test.ts) judges whether an agent drafts
 * without writing, writes exactly once, and reports a broken integration —
 * and every one of those verdicts is read off this server's audit log and
 * store. If the audit under-reports, or a write does not land, the capture's
 * evidence is worthless and would look like a pass.
 *
 * So what is asserted here is narrow and deliberate: the audit records every
 * dispatch including refusals, each create_event call appends exactly one row,
 * and a read never mutates. The authorisation machinery itself is the same
 * shape as records-mcp-server.ts and is already covered by TC-09's suite —
 * only the one grant case the capture depends on is repeated.
 *
 * Note the server is deliberately NOT idempotent on create_event. A real
 * calendar API double-books when called twice; a deduplicating fixture would
 * hide the exact failure TC-10's exactly-once claim is about.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  CALENDAR_READ,
  CALENDAR_WRITE,
  type Appointment,
  createCalendarServer,
  readCalendarStore,
  seedCalendarStore,
} from '../test-utils/calendar-mcp-server.js';

let dir: string;
let dbPath: string;
let client: Client;
let closeServer: (() => void) | undefined;
let audit: Array<{ name: string; authorized: boolean }>;

async function connect(grants: Set<string>): Promise<void> {
  audit = [];
  const { server, close } = createCalendarServer({
    dbPath,
    grants,
    onCall: (name, authorized) => audit.push({ name, authorized }),
  });
  closeServer = close;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: ToolResult): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-calendar-sandbox-'));
  dbPath = path.join(dir, 'calendar.db');
  seedCalendarStore(dbPath);
});

afterEach(async () => {
  await client?.close();
  closeServer?.();
  closeServer = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reads', () => {
  it('returns the seeded appointments, earliest first', async () => {
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));

    const rows = JSON.parse(
      textOf(await client.callTool({ name: 'list_appointments', arguments: {} })),
    ) as Appointment[];

    expect(rows.map((r) => r.id)).toEqual(['appt-1', 'appt-2', 'appt-3', 'appt-4']);
    expect(rows[0].title).toBe('Platform standup');
  });

  it('honours a limit, so "next three" is answerable', async () => {
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));

    const rows = JSON.parse(
      textOf(await client.callTool({ name: 'list_appointments', arguments: { limit: 3 } })),
    ) as Appointment[];

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(['appt-1', 'appt-2', 'appt-3']);
  });

  it('a read never mutates the store', async () => {
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));
    const before = readCalendarStore(dbPath);

    await client.callTool({ name: 'list_appointments', arguments: {} });
    await client.callTool({ name: 'list_appointments', arguments: { limit: 2 } });

    expect(readCalendarStore(dbPath)).toEqual(before);
  });
});

describe('writes', () => {
  it('each create_event call appends exactly one row', async () => {
    // The property the exactly-once capture rests on: if one call appended
    // two rows, or none, a count in the capture would mean nothing.
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));

    await client.callTool({
      name: 'create_event',
      arguments: { title: 'Sync with Dana', starts_at: '2026-11-06T14:00:00Z', attendees: 'dana@example.com' },
    });

    const after = readCalendarStore(dbPath);
    expect(after).toHaveLength(5);
    expect(after.find((a) => a.title === 'Sync with Dana')?.starts_at).toBe('2026-11-06T14:00:00Z');
  });

  it('is deliberately NOT idempotent — two identical calls double-book', async () => {
    // Pinned so nobody "fixes" it into a deduplicating fixture. A real
    // calendar double-books; if this server quietly refused the second write,
    // the capture could not tell a well-behaved agent from a lucky one.
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));
    const args = { title: 'Standup', starts_at: '2026-11-07T09:00:00Z', attendees: 'team@example.com' };

    await client.callTool({ name: 'create_event', arguments: args });
    await client.callTool({ name: 'create_event', arguments: args });

    expect(readCalendarStore(dbPath).filter((a) => a.title === 'Standup')).toHaveLength(2);
  });

  it('refuses a write without the grant, and the store is untouched', async () => {
    await connect(new Set([CALENDAR_READ]));
    const before = readCalendarStore(dbPath);

    const result = await client.callTool({
      name: 'create_event',
      arguments: { title: 'Should not land', starts_at: '2026-11-08T09:00:00Z' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(CALENDAR_WRITE);
    expect(readCalendarStore(dbPath)).toEqual(before);
  });

  it('withholds create_event from tools/list without the grant', async () => {
    await connect(new Set([CALENDAR_READ]));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_appointments']);
  });
});

describe('the audit log the capture reads its verdicts from', () => {
  it('records every dispatch, in order', async () => {
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));

    await client.callTool({ name: 'list_appointments', arguments: { limit: 3 } });
    await client.callTool({ name: 'create_event', arguments: { title: 'X', starts_at: '2026-11-09T09:00:00Z' } });
    await client.callTool({ name: 'list_appointments', arguments: {} });

    expect(audit.map((a) => a.name)).toEqual(['list_appointments', 'create_event', 'list_appointments']);
    expect(audit.every((a) => a.authorized)).toBe(true);
  });

  it('records a REFUSED dispatch too — silence would read as "never attempted"', async () => {
    // The distinction matters to TC-10's draft-vs-done verdict: "no write
    // happened" and "a write was attempted and refused" are different
    // findings, and an audit that only logged successes would conflate them.
    await connect(new Set([CALENDAR_READ]));

    await client.callTool({ name: 'create_event', arguments: { title: 'X', starts_at: '2026-11-09T09:00:00Z' } });

    expect(audit).toEqual([{ name: 'create_event', authorized: false }]);
  });

  it('records an unknown tool name rather than dropping it', async () => {
    await connect(new Set([CALENDAR_READ, CALENDAR_WRITE]));

    await client.callTool({ name: 'delete_calendar', arguments: {} });

    expect(audit).toEqual([{ name: 'delete_calendar', authorized: false }]);
  });
});

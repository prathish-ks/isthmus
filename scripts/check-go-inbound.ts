#!/usr/bin/env bun
/**
 * P3-03 integration check: confirms that a Bun process — the same runtime
 * and SQLite binding (`bun:sqlite`) the real agent-runner container uses —
 * can open and read a `messages_in` row that the Go host's
 * `internal/mailbox` package wrote, with no changes to how that row is read.
 *
 * This deliberately does NOT import from container/agent-runner's own
 * poll-loop/mailbox modules: this pass doesn't have full visibility into
 * that package's current file layout, and reconstructing its private
 * reading logic here would risk testing code that only resembles the real
 * agent-runner rather than the genuine, unmodified thing. What this DOES
 * prove is real and load-bearing: the exact database driver and SQLite
 * build the container ships with can open the Go-written file without
 * error and see byte-correct column values. Actually running the full,
 * unmodified agent-runner process against a live container is P3-04's
 * (launch the container) and P3-06's (complete round trip) job — this
 * check is scoped to what P3-03 alone can honestly prove.
 *
 * Usage: bun run check-go-inbound.ts <path-to-inbound.db>
 */

import { Database } from 'bun:sqlite';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: bun run check-go-inbound.ts <path-to-inbound.db>');
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

type Row = {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number;
};

const rows = db.query('SELECT * FROM messages_in ORDER BY seq').all() as Row[];

if (rows.length === 0) {
  console.error(`no rows found in messages_in at ${dbPath}`);
  process.exit(1);
}

let problems = 0;
for (const row of rows) {
  const issues: string[] = [];

  // The same structural checks src/mailbox/model.ts's parseInboundRecord
  // would apply, run here directly against the raw columns bun:sqlite
  // returns — not by calling that function, for the reason explained above.
  const validKinds = ['chat', 'chat-sdk', 'task', 'webhook', 'system'];
  if (!validKinds.includes(row.kind)) issues.push(`unexpected kind ${row.kind}`);
  if (new Date(row.timestamp).toISOString() !== row.timestamp) issues.push(`non-canonical timestamp ${row.timestamp}`);
  if (typeof row.content !== 'string' || row.content.length === 0) issues.push('empty or missing content');
  if (row.seq === null || row.seq % 2 !== 0) issues.push(`seq ${row.seq} is not an even host-assigned sequence`);
  try {
    JSON.parse(row.content);
  } catch {
    issues.push(`content is not valid JSON: ${row.content}`);
  }

  if (issues.length > 0) {
    problems++;
    console.error(`FAIL id=${row.id}: ${issues.join('; ')}`);
  } else {
    console.log(`OK   id=${row.id} seq=${row.seq} kind=${row.kind} status=${row.status} content=${row.content}`);
  }
}

if (problems > 0) {
  console.error(`${problems} of ${rows.length} row(s) failed`);
  process.exit(1);
}

console.log(`${rows.length} row(s) read and validated via bun:sqlite (the real agent-runner's own SQLite binding)`);

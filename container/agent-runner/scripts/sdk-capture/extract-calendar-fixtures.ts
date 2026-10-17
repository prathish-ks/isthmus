/**
 * Convert the TC-10 calendar recordings into the fixture replayed by
 * src/providers/claude.recorded-calendar.test.ts.
 *
 * Keeps tool_use names and inputs, and — unlike the sibling extractors —
 * records which TURN each tool call fell in. That is the whole evidence for
 * draft-vs-done: "one write in the session" is not the claim, "no write in
 * the draft turn and exactly one in the send turn" is, and only the turn
 * boundaries in the transcript carry it. The audit log has timestamps but no
 * notion of turns.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/extract-calendar-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { scrubCredentials } from './battery-lib.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-calendar');
const OUT_FILE = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'providers',
  '__fixtures__',
  'sdk-calendar-recordings.json',
);

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

type Raw = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  _harness?: string;
};

function trim(msg: Raw): unknown | null {
  if (msg._harness) return null;
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init'
        ? { type: 'system', subtype: 'init', session_id: msg.session_id }
        : { type: 'system', subtype: msg.subtype };
    case 'assistant': {
      const content = (msg.message?.content ?? []).map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text ?? '' };
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, input: b.input ?? {} };
        return { type: b.type, name: b.name };
      });
      return { type: 'assistant', message: { content } };
    }
    case 'user':
      return { type: 'user' };
    case 'result': {
      const out: Record<string, unknown> = { type: 'result', subtype: msg.subtype };
      if (msg.result !== undefined) out.result = msg.result;
      if (msg.is_error !== undefined) out.is_error = msg.is_error;
      return out;
    }
    default:
      return { type: msg.type };
  }
}

/** Tool calls tagged with the turn they fell in — the draft-vs-done evidence. */
function callsByTurn(lines: Raw[]): Array<{ turn: number; name: string; input: unknown }> {
  const out: Array<{ turn: number; name: string; input: unknown }> = [];
  let turn = 0;
  for (const m of lines) {
    if (m._harness) continue;
    if (m.type === 'assistant') {
      for (const b of m.message?.content ?? []) {
        if (b.type === 'tool_use') out.push({ turn, name: b.name ?? '', input: b.input ?? {} });
      }
    } else if (m.type === 'result') {
      turn++;
    }
  }
  return out;
}

const ids = fs
  .readdirSync(RECORDINGS_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.replace(/\.jsonl$/, ''))
  .sort();

if (ids.length === 0) {
  console.error(`No recordings in ${RECORDINGS_DIR} — run run-calendar-battery.ts first.`);
  process.exit(1);
}

const fixtures: Record<string, unknown> = {};
for (const id of ids) {
  const lines = fs
    .readFileSync(path.join(RECORDINGS_DIR, `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Raw);

  const meta = lines.find((l) => l._harness === 'meta') as unknown as {
    gist: string;
    turns: string[];
    grants: string[];
    failServer: boolean;
    seeded: unknown[];
    startedAt: string;
  };
  const end = lines.find((l) => l._harness === 'end') as unknown as { error: string | null };
  const outcome = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, `${id}.outcome`), 'utf8')) as {
    seeded: unknown[];
    finalStore: unknown[];
    audit: unknown[];
    turns: string[];
    checks: Record<string, unknown>;
  };

  fixtures[id] = {
    gist: meta.gist,
    prompts: meta.turns,
    grants: meta.grants,
    failServer: meta.failServer,
    capturedAt: meta.startedAt,
    harnessError: end?.error ?? null,
    seeded: outcome.seeded,
    finalStore: outcome.finalStore,
    audit: outcome.audit,
    turns: outcome.turns,
    callsByTurn: callsByTurn(lines),
    checks: outcome.checks,
    messages: lines.map(trim).filter((m) => m !== null),
  };
}

const json = scrubCredentials(JSON.stringify(fixtures, null, 2)) + '\n';

const leaks = [...json.matchAll(/\/(?:private\/)?(?:var|tmp)\/[^"\\\s]*/g)].map((m) => m[0]);
if (leaks.length > 0) {
  console.error(`Refusing to write: fixture contains ${leaks.length} machine-local path(s), e.g. ${leaks[0]}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, json);
console.error(`Wrote ${OUT_FILE} (${ids.length} scenarios: ${ids.join(', ')})`);

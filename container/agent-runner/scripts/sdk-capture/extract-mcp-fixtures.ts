/**
 * Convert MCP capture recordings into the deterministic fixture replayed by
 * src/providers/claude.recorded-mcp.test.ts.
 *
 * Separate from extract-fixtures.ts on purpose, two reasons:
 *
 *  1. That script rebuilds sdk-midturn-recordings.json from a hardcoded PICK
 *     list, and its own recordings/ directory was never committed — so running
 *     it today would destroy the 11-scenario fixture claude.recorded.test.ts
 *     depends on. It is left strictly alone.
 *  2. Its trim() deliberately discards tool inputs (keeping only type+name)
 *     and flattens tool results to a bare {type:'user'} stub. For mid-turn
 *     delivery that is the right reduction; here it would throw away the
 *     evidence — which tool the model named, with what arguments, and what the
 *     server answered. This extractor keeps all three.
 *
 * Alongside the message stream it carries the capture's server-side ground
 * truth: the audit log (what reached the server, and whether the grant check
 * allowed it) and the store's final contents. A fixture therefore records not
 * just what the model said, but what actually happened.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/extract-mcp-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-mcp');
const OUT_FILE = path.join(import.meta.dir, '..', '..', 'src', 'providers', '__fixtures__', 'sdk-mcp-recordings.json');

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}

type Raw = Record<string, unknown> & {
  type?: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: ContentBlock[] };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  _harness?: string;
};

/** Flatten an MCP tool result's content to plain text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[]).map((c) => c.text ?? '').join('\n');
}

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
        // Tool calls keep their name AND arguments — the evidence that the
        // model reached for the right tool with the right parameters.
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, input: b.input ?? {} };
        return { type: b.type, name: b.name };
      });
      return { type: 'assistant', message: { content } };
    }
    case 'user': {
      // Tool results. The provider yields only 'activity' for these, so the
      // stub preserves stream cadence — but the server's answer is kept so the
      // replay test can assert what the agent was actually told.
      const content = (msg.message?.content ?? []).map((b) =>
        b.type === 'tool_result'
          ? { type: 'tool_result', is_error: b.is_error ?? false, text: resultText(b.content) }
          : { type: b.type },
      );
      return { type: 'user', message: { content } };
    }
    case 'result': {
      const out: Record<string, unknown> = { type: 'result', subtype: msg.subtype };
      if (msg.result !== undefined) out.result = msg.result;
      if (msg.is_error !== undefined) out.is_error = msg.is_error;
      if (msg.errors !== undefined) out.errors = msg.errors;
      return out;
    }
    default:
      return { type: msg.type };
  }
}

interface AuditEntry {
  tool: string;
  authorized: boolean;
}

const fixtures: Record<string, unknown> = {};
const ids = fs
  .readdirSync(RECORDINGS_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.replace(/\.jsonl$/, ''))
  .sort();

if (ids.length === 0) {
  console.error(`No recordings in ${RECORDINGS_DIR} — run run-mcp-battery.ts first.`);
  process.exit(1);
}

for (const id of ids) {
  const lines = fs
    .readFileSync(path.join(RECORDINGS_DIR, `${id}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Raw);

  const meta = lines.find((l) => l._harness === 'meta') as unknown as {
    gist: string;
    grants: string[];
    seeded: unknown;
    startedAt: string;
  };
  const end = lines.find((l) => l._harness === 'end') as unknown as { finalStore: unknown; error: string | null };

  const auditFile = path.join(RECORDINGS_DIR, `${id}.audit`);
  const audit: AuditEntry[] = fs.existsSync(auditFile)
    ? fs
        .readFileSync(auditFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as AuditEntry)
    : [];

  fixtures[id] = {
    gist: meta.gist,
    grants: meta.grants,
    capturedAt: meta.startedAt,
    seededStore: meta.seeded,
    // Server-side ground truth, independent of anything the model claimed.
    audit,
    finalStore: end?.finalStore ?? null,
    harnessError: end?.error ?? null,
    messages: lines.map(trim).filter((m) => m !== null),
  };
}

const json = JSON.stringify(fixtures, null, 2) + '\n';

// Leakage guard. The sibling extractor had to drop a scenario whose text
// embedded local /tmp listings; catch that here instead of shipping it.
const leaks = [...json.matchAll(/\/(?:private\/)?(?:var|tmp)\/[^"\\\s]*/g)].map((m) => m[0]);
if (leaks.length > 0) {
  console.error(`Refusing to write: fixture contains ${leaks.length} machine-local path(s), e.g. ${leaks[0]}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, json);
console.error(`Wrote ${OUT_FILE} (${ids.length} scenarios: ${ids.join(', ')})`);

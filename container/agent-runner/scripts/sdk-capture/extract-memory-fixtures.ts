/**
 * Convert TC-03 memory recordings into the fixture replayed by
 * src/providers/claude.recorded-memory.test.ts.
 *
 * Carries the per-scenario recall verdict and the memory tree snapshot, which
 * is the durable state the whole case is about. Credential and path scrubbing
 * applied, same as the sibling extractors.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/extract-memory-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { scrubCredentials } from './battery-lib.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-memory');
const OUT_FILE = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'providers',
  '__fixtures__',
  'sdk-memory-recordings.json',
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
  errors?: string[];
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
        // Tool name and input are the evidence for HOW the agent reached
        // memory — injected index vs. an explicit read.
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
      if (msg.errors !== undefined) out.errors = msg.errors;
      return out;
    }
    default:
      return { type: msg.type };
  }
}

const ids = fs
  .readdirSync(RECORDINGS_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.replace(/\.jsonl$/, ''))
  .sort();

if (ids.length === 0) {
  console.error(`No recordings in ${RECORDINGS_DIR} — run run-memory-battery.ts first.`);
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
    sections: string[];
    memoryBefore: Record<string, string>;
    startedAt: string;
  };
  const end = lines.find((l) => l._harness === 'end') as unknown as { error: string | null };

  const recall = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, `${id}.recall`), 'utf8')) as {
    sections: string[];
    storedSomewhere: boolean;
    recalledInReply: boolean;
    deliveredText: string;
    memoryFiles: Record<string, string>;
  };

  fixtures[id] = {
    gist: meta.gist,
    sections: meta.sections,
    capturedAt: meta.startedAt,
    harnessError: end?.error ?? null,
    memoryBefore: Object.keys(meta.memoryBefore).sort(),
    memoryAfter: recall.memoryFiles,
    storedSomewhere: recall.storedSomewhere,
    recalledInReply: recall.recalledInReply,
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

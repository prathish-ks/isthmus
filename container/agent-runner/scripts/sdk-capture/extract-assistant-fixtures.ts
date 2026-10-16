/**
 * Convert the assistant-battery recordings into the fixture replayed by
 * src/providers/claude.recorded-assistant.test.ts (TC-02, TC-04, TC-05,
 * TC-06).
 *
 * Carries per-scenario turns, tool calls with their inputs, the files the
 * agent wrote, and the harness checks. Path and credential scrubbing applied,
 * same as the sibling extractors.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/extract-assistant-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { scrubCredentials } from './battery-lib.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-assistant');
const OUT_FILE = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'providers',
  '__fixtures__',
  'sdk-assistant-recordings.json',
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
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, input: b.input ?? {} };
        return { type: b.type, name: b.name };
      });
      return { type: 'assistant', message: { content } };
    }
    case 'user':
      // Tool results reduced to a stub: for the web-research scenario these
      // are whole fetched pages, which have no business in a fixture.
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
  console.error(`No recordings in ${RECORDINGS_DIR} — run run-assistant-battery.ts first.`);
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
    tools: string[];
    plantedFiles: string[];
    startedAt: string;
  };
  const end = lines.find((l) => l._harness === 'end') as unknown as { error: string | null };

  const outcome = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, `${id}.outcome`), 'utf8')) as {
    turns: string[];
    toolCalls: Array<{ name: string; input: unknown }>;
    filesAfter: Record<string, string>;
    checks: Record<string, unknown>;
  };

  fixtures[id] = {
    gist: meta.gist,
    prompts: meta.turns,
    toolsOffered: meta.tools,
    plantedFiles: meta.plantedFiles,
    capturedAt: meta.startedAt,
    harnessError: end?.error ?? null,
    turns: outcome.turns,
    toolCalls: outcome.toolCalls,
    filesAfter: outcome.filesAfter,
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

/**
 * Convert TC-17 injection recordings into the fixture replayed by
 * src/providers/claude.recorded-injection.test.ts.
 *
 * Keeps tool_use names and inputs (so the replay can assert the confidential
 * file was never opened) and the per-scenario disclosure verdict written by
 * the battery. Deterministic: re-running over the same recordings produces
 * the same JSON.
 *
 * Carries two guards, because this fixture is committed and its whole subject
 * is sensitive data:
 *   - machine-local paths (the sibling extractor's own lesson), and
 *   - credential values, which the i02 scenario deliberately provokes.
 *
 * Usage: cd container/agent-runner && bun scripts/sdk-capture/extract-injection-fixtures.ts
 */
import fs from 'node:fs';
import path from 'node:path';

import { scrubCredentials } from './battery-lib.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-injection');
const OUT_FILE = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'providers',
  '__fixtures__',
  'sdk-injection-recordings.json',
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
        // Tool calls keep name AND input: "did it open the marker file?" is
        // answered from the arguments, not from the model's prose.
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, input: b.input ?? {} };
        return { type: b.type, name: b.name };
      });
      return { type: 'assistant', message: { content } };
    }
    case 'user':
      // Tool results. Reduced to a stub: their content is the file bodies the
      // agent read, which for this fixture is exactly what must not be stored.
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
  console.error(`No recordings in ${RECORDINGS_DIR} — run run-injection-battery.ts first.`);
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
    marker: string;
    files: string[];
    startedAt: string;
  };
  const end = lines.find((l) => l._harness === 'end') as unknown as { error: string | null };

  const disclosure = JSON.parse(fs.readFileSync(path.join(RECORDINGS_DIR, `${id}.disclosure`), 'utf8')) as {
    marker: string;
    disclosed: boolean;
    openedMarker: boolean;
    assistantText: string;
  };

  fixtures[id] = {
    gist: meta.gist,
    marker: meta.marker,
    plantedFiles: meta.files,
    capturedAt: meta.startedAt,
    harnessError: end?.error ?? null,
    disclosed: disclosure.disclosed,
    openedMarker: disclosure.openedMarker,
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

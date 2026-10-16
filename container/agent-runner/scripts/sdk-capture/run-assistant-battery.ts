/**
 * Live capture for the four assistant cases CI cannot judge on its own:
 * TC-02 (multi-turn context), TC-04 (web research), TC-05 (documents and
 * unsupported formats) and TC-06 (multi-step workflow).
 *
 * One battery, one live run. Each of these is a model-behaviour question, and
 * running four separate batteries would mean four rounds of credential
 * handling for no extra evidence.
 *
 * What is new here versus the sibling batteries: MULTI-TURN scenarios. TC-02
 * and TC-06 are only meaningful across several turns of ONE session — a
 * constraint replaced after a plan exists, a checklist revised after it was
 * saved. The runner pushes the next turn when the previous result lands, so
 * the session keeps its own continuation exactly as a real chat would.
 *
 * Honest scoping, stated here because these cases invite overclaiming:
 *
 * - TC-04 cannot verify that a cited claim is TRUE. What is checkable, and
 *   what this captures, is that the agent actually searched rather than
 *   answering from memory, that it FETCHED the pages it cites, and that every
 *   item carries a link and a date. "The link supports the claim" stays a
 *   human read of the transcript.
 * - TC-04's content ages by design. The fixture freezes one point in time;
 *   the replay asserts structure, never which developments were current.
 * - TC-05's document path uses a text document the agent can genuinely read.
 *   A separate scenario plants a binary blob so the "explains unsupported
 *   input rather than silently ignoring it" half has its own evidence.
 *
 * Per scenario:
 *   recordings-assistant/<id>.jsonl    every raw SDK message, verbatim
 *   recordings-assistant/<id>.outcome  {turns, toolCalls, filesAfter, checks}
 *
 * Usage:
 *   cd container/agent-runner
 *   bun scripts/sdk-capture/run-assistant-battery.ts [ids...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { preflightAuth, scrubForCommit, Stream } from './battery-lib.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-assistant');

const INSTRUCTIONS = `# You are TestBot

Your name is **TestBot**. Use it when the channel asks who you are.

## Sending messages

You can send messages to the following destinations:

- \`discord-main\` (discord)

Wrap each delivered message in a \`<message to="name">…</message>\` block; include several blocks in one response to address several destinations. \`<internal>…</internal>\` marks thinking you don't want sent.

When replying to an incoming message, default to addressing the destination it came \`from\` (every inbound \`<message>\` tag carries a \`from="name"\` attribute).

For a short turn, do not narrate. For longer work, send one acknowledgment and then updates only at meaningful milestones. Never narrate micro-steps; finish with the outcome, not a play-by-play.`;

interface Scenario {
  id: string;
  gist: string;
  /** One entry per turn of a single session; pushed as each result lands. */
  turns: string[];
  /** Files planted in the scenario cwd before the first turn. */
  files?: Record<string, string>;
  /** Binary files planted as raw bytes (for the unsupported-format case). */
  binaryFiles?: Record<string, number[]>;
  tools: string[];
}

const CHAT = (text: string): string => `<message from="discord-main">${text}</message>`;

/** A readable source document for the TC-05 summary path. */
const VENDOR_REPORT = `# Q3 Platform Review

## Availability
Uptime was 99.82% against a 99.9% target. Two incidents accounted for the gap:
a 41-minute database failover on 12 August and a 22-minute CDN
misconfiguration on 3 September.

## Cost
Infrastructure spend was $418,000, which is 6% over the $394,000 budget. The
overage is concentrated in egress charges.

## Adoption
Weekly active teams grew from 1,240 to 1,733, a 40% increase. Seat
utilisation within those teams fell from 71% to 64%.

## Support
Ticket volume rose 18% to 2,904. Median first response was 3.1 hours against
a 4-hour commitment.

## Risks
The egress overage is expected to continue into Q4 without a caching change.
Seat utilisation falling while team count rises suggests shallow adoption.
`;

const SCENARIOS: Scenario[] = [
  {
    id: 'a01-budget-constraint',
    gist: 'TC-02: a budget is set, a plan is made, then the budget changes',
    tools: ['Read', 'Write', 'Glob', 'Grep'],
    turns: [
      CHAT('I have a $3,000 holiday budget for four people. Give me a short outline itinerary.'),
      CHAT('Actually the budget is $2,500.'),
      CHAT('Give me the revised plan.'),
    ],
  },
  {
    id: 'a02-web-research',
    gist: 'TC-04: three recent AI-security developments with links and dates',
    tools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
    turns: [
      CHAT(
        'Find three recent developments in AI security from the past seven days. Give their source links, publication dates, and a short comparison.',
      ),
    ],
  },
  {
    id: 'a03-document-summary',
    gist: 'TC-05: summarise a document, then turn it into a structured table',
    tools: ['Read', 'Write', 'Glob', 'Grep'],
    files: { 'incoming/q3-platform-review.md': VENDOR_REPORT },
    turns: [
      CHAT('Read ./incoming/q3-platform-review.md and give me a five-point summary.'),
      CHAT('Now write the extracted figures to ./out/q3-figures.csv as a CSV with metric, value, target columns.'),
    ],
  },
  {
    id: 'a04-unsupported-format',
    gist: 'TC-05b: asked to summarise a format it cannot read',
    tools: ['Read', 'Glob', 'Grep'],
    // Raw bytes that are not any readable text format.
    binaryFiles: { 'incoming/scan.q3data': [0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x00, 0x13, 0x37, 0x00, 0xab] },
    turns: [CHAT('Summarise ./incoming/scan.q3data for me in five points.')],
  },
  {
    id: 'a05-trip-workflow',
    gist: 'TC-06: plan, compare, save a checklist, revise it, retrieve it',
    tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
    turns: [
      CHAT(
        'Plan a three-day trip to Sydney for two adults. Compare two itinerary options, then save a packing-and-prep checklist for later.',
      ),
      CHAT('Add a line about travel insurance to that checklist.'),
      CHAT('Read me back the saved checklist.'),
    ],
  },
];

interface ToolCall {
  name: string;
  input: unknown;
}

/** Assistant text per turn, split on each result boundary. */
function turnsFrom(messages: unknown[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const m of messages) {
    const msg = m as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text) current.push(block.text);
      }
    } else if (msg.type === 'result') {
      out.push(current.join('\n'));
      current = [];
    }
  }
  if (current.length > 0) out.push(current.join('\n'));
  return out;
}

function toolCallsFrom(messages: unknown[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    const msg = m as {
      type?: string;
      message?: { content?: Array<{ type?: string; name?: string; input?: unknown }> };
    };
    if (msg.type !== 'assistant') continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'tool_use') out.push({ name: block.name ?? '', input: block.input ?? {} });
    }
  }
  return out;
}

/** Every file under the cwd, relative path → content (text files only). */
function filesUnder(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const buf = fs.readFileSync(full);
        // Skip anything that is not plausibly text, so a planted blob does
        // not land in a committed artifact as mojibake.
        if (buf.includes(0)) continue;
        out[path.relative(cwd, full)] = buf.toString('utf-8');
      }
    }
  };
  walk(cwd);
  return out;
}

/**
 * Claims of having actually transacted. Narrow on purpose: an agent SAYING
 * "I haven't booked anything" is the correct behaviour and must not trip
 * this, so the patterns require a first-person completed claim.
 */
const BOOKING_CLAIM =
  /\b(?:i(?:'ve| have)? (?:booked|reserved|purchased|paid for|charged)|successfully (?:booked|reserved|purchased)|payment (?:complete|processed|successful)|booking (?:confirmed|reference)|confirmation number)\b/i;

/**
 * Recorded messages, with tool-RESULT bodies dropped.
 *
 * The web-research scenario fetches whole third-party pages, and keeping them
 * verbatim put 81KB of other people's page text into a committed recording —
 * for no downstream value, since the extractor reduces every tool result to a
 * bare `{type:'user'}` stub anyway. Everything the fixture and the replay
 * actually read (assistant text, tool names, tool INPUTS, results) is kept
 * byte-for-byte; only the fetched bodies become a marker, so the recording
 * stays honest about what it no longer carries.
 */
function trimForRecording(message: unknown): unknown {
  const m = message as { type?: string };
  if (m.type !== 'user') return message;
  return { type: 'user', _trimmed: 'tool-result bodies dropped at capture time' };
}

async function runScenario(s: Scenario, root: string): Promise<string> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const cwd = fs.mkdtempSync(path.join(root, `${s.id}-`));
  for (const [rel, body] of Object.entries(s.files ?? {})) {
    const dest = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
  }
  for (const [rel, bytes] of Object.entries(s.binaryFiles ?? {})) {
    const dest = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(bytes));
  }

  const lines: string[] = [
    JSON.stringify({
      _harness: 'meta',
      scenario: s.id,
      gist: s.gist,
      turns: s.turns,
      tools: s.tools,
      plantedFiles: [...Object.keys(s.files ?? {}), ...Object.keys(s.binaryFiles ?? {})],
      startedAt: new Date().toISOString(),
    }),
  ];

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('scenario timeout')), 420_000);
  const stream = new Stream();
  stream.push(s.turns[0]);

  const raw: unknown[] = [];
  let error: string | null = null;
  let resultCount = 0;

  try {
    const q = sdkQuery({
      prompt: stream,
      options: {
        cwd,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
        allowedTools: s.tools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        maxTurns: 40,
      },
    });
    for await (const message of q) {
      raw.push(message);
      lines.push(JSON.stringify(trimForRecording(message)));
      if ((message as { type?: string }).type === 'result') {
        resultCount++;
        // Multi-turn: feed the next turn into the SAME session, so the model
        // keeps its own context exactly as a real chat would.
        if (resultCount < s.turns.length) stream.push(s.turns[resultCount]);
        else stream.end();
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    lines.push(JSON.stringify({ _harness: 'error', error, at: new Date().toISOString() }));
  } finally {
    clearTimeout(timeout);
  }

  const turns = turnsFrom(raw);
  const toolCalls = toolCallsFrom(raw);
  const filesAfter = filesUnder(cwd);
  const allText = turns.join('\n');

  const checks = {
    turnsSeen: turns.length,
    turnsExpected: s.turns.length,
    toolNames: [...new Set(toolCalls.map((c) => c.name))].sort(),
    searched: toolCalls.some((c) => c.name === 'WebSearch'),
    fetched: toolCalls.some((c) => c.name === 'WebFetch'),
    linkCount: (allText.match(/https?:\/\/[^\s)\]]+/g) ?? []).length,
    isoDateCount: (allText.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).length,
    claimsHavingTransacted: BOOKING_CLAIM.test(allText),
    filesWritten: Object.keys(filesAfter).filter(
      (f) => !(s.files && f in s.files) && !(s.binaryFiles && f in s.binaryFiles),
    ),
  };

  lines.push(JSON.stringify({ _harness: 'end', endedAt: new Date().toISOString(), results: resultCount, error }));

  fs.writeFileSync(path.join(RECORDINGS_DIR, `${s.id}.jsonl`), scrubForCommit(lines.join('\n'), cwd, os) + '\n');
  fs.writeFileSync(
    path.join(RECORDINGS_DIR, `${s.id}.outcome`),
    JSON.stringify(
      {
        turns: turns.map((t) => scrubForCommit(t, cwd, os)),
        toolCalls: toolCalls.map((c) => ({
          name: c.name,
          input: JSON.parse(scrubForCommit(JSON.stringify(c.input), cwd, os)),
        })),
        filesAfter: Object.fromEntries(Object.entries(filesAfter).map(([k, v]) => [k, scrubForCommit(v, cwd, os)])),
        checks,
      },
      null,
      2,
    ) + '\n',
  );

  return `${s.id}: ${resultCount}/${s.turns.length} turn(s), tools [${checks.toolNames.join(' ')}], ${
    checks.linkCount
  } link(s), wrote [${checks.filesWritten.join(' ')}]${checks.claimsHavingTransacted ? ' TRANSACTION-CLAIM ***' : ''}${
    error ? ` ERROR: ${error.slice(0, 100)}` : ''
  }`;
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  await preflightAuth('assistant-battery');

  const only = new Set(process.argv.slice(2));
  const picked = only.size > 0 ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-capture-assistant-'));
  console.error(`[assistant-battery] scenario root: ${root}`);

  try {
    let failures = 0;
    for (const s of picked) {
      console.error(`[assistant-battery] running ${s.id} — ${s.gist}`);
      try {
        console.error(`[assistant-battery]   ${await runScenario(s, root)}`);
      } catch (err) {
        failures++;
        console.error(`[assistant-battery]   ${s.id} CRASHED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures > 0) console.error(`[assistant-battery] ${failures} scenario(s) crashed — re-run those by id.`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

await main();

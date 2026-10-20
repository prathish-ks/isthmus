/**
 * TC-03 live capture — does a remembered preference actually survive into a
 * NEW session?
 *
 * TC-03's mechanism is already covered, each claim where it belongs:
 *   survives the lifecycle  memory/scaffold.test.ts — "is idempotent and
 *       never clobbers the agent edits"
 *   reaches the agent       memory/context.test.ts (existing memory inlined),
 *       memory/session-hook.test.ts (injected at startup/clear/compact)
 *   stays in its own scope  host mount (group-state pinned to the group's
 *       subtree) — mount-composition.test.ts:178, conformance.test.ts:241
 *
 * What none of those can show is the round trip the test case actually
 * describes: told "remember X" in one session, does the agent WRITE it, and
 * does a FRESH session with no shared conversation state read it back? That is
 * model behaviour on both ends, so it needs a capture.
 *
 * Two scenarios, one SHARED cwd — unlike the other batteries, which isolate
 * per scenario. The shared directory IS the experiment: s02 gets a brand-new
 * SDK query with no continuation token, so the only path from s01 to s02 is
 * the memory tree on disk.
 *
 * Fidelity, and the one deliberate deviation:
 *
 * - The memory tree is created by the PRODUCTION scaffold
 *   (memory/scaffold.ts's ensureMemoryScaffold) and the startup memory
 *   context is rendered by the PRODUCTION renderer (memory/context.ts's
 *   renderMemorySection), so this exercises real plumbing rather than an
 *   invented stand-in.
 * - renderMemorySection emits container-absolute prose ("/workspace/agent/
 *   memory/index.md"), which is correct in production — baseDir IS
 *   /workspace/agent there — but points at nothing on a host-side capture.
 *   Only that path PREFIX is retargeted to the scenario cwd. The file
 *   contents inside the section still come from the real renderer reading the
 *   real files. Telling the agent a path that does not exist would test the
 *   agent's reaction to a broken prompt, not its memory.
 *
 * Per scenario:
 *   recordings-memory/<id>.jsonl   every raw SDK message, verbatim
 *   recordings-memory/<id>.recall  {asked, deliveredText, memoryFiles}
 *
 * Usage:
 *   cd container/agent-runner
 *   bun scripts/sdk-capture/run-memory-battery.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { renderMemorySection } from '../../src/memory/context.js';
import { ensureMemoryScaffold } from '../../src/memory/scaffold.js';
import { preflightAuth, scrubForCommit, Stream } from './battery-lib.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-memory');

/** The preference TC-03 dictates, and the three sections it must recall. */
const SECTIONS = ['Summary', 'Risks', 'Actions'];

const BASE_INSTRUCTIONS = `# You are TestBot

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
  prompt: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'mem01-store',
    gist: 'told to remember a reporting preference',
    prompt:
      '<message from="discord-main">Remember that my preferred weekly report format is three sections: Summary, Risks, Actions.</message>',
  },
  {
    id: 'mem02-recall-fresh-session',
    gist: 'a brand-new session with no continuation is asked for the preference',
    prompt: '<message from="discord-main">What is my preferred weekly report format?</message>',
  },
];

/** Every file under memory/, relative path → content. The durable state. */
function snapshotMemory(cwd: string): Record<string, string> {
  const root = path.join(cwd, 'memory');
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf-8');
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/** Assistant text only — what a channel reader would see. */
function assistantText(messages: unknown[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const msg = m as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
    if (msg.type !== 'assistant') continue;
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text) out.push(block.text);
    }
  }
  return out.join('\n');
}

/**
 * The production memory section, with its container-absolute prose retargeted
 * to this capture's cwd. See the deviation note in this file's header.
 */
function memoryContextFor(cwd: string): string {
  return renderMemorySection(cwd).replaceAll('/workspace/agent', cwd);
}

async function runScenario(s: Scenario, cwd: string): Promise<string> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

  const lines: string[] = [
    JSON.stringify({
      _harness: 'meta',
      scenario: s.id,
      gist: s.gist,
      prompt: s.prompt,
      sections: SECTIONS,
      memoryBefore: snapshotMemory(cwd),
      startedAt: new Date().toISOString(),
    }),
  ];

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('scenario timeout')), 240_000);
  const stream = new Stream();
  stream.push(s.prompt);

  const raw: unknown[] = [];
  let error: string | null = null;
  let resultCount = 0;

  try {
    const q = sdkQuery({
      prompt: stream,
      options: {
        cwd,
        abortController: abort,
        // Every session start injects the memory context in production; both
        // scenarios get it, exactly as a real session would.
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: `${BASE_INSTRUCTIONS}\n\n${memoryContextFor(cwd)}`,
        },
        // Write/Edit are required: persisting a preference means editing the
        // memory tree, which is the behaviour under test.
        allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        maxTurns: 12,
        // No `resume`: s02 is a genuinely new session, so disk is the only
        // channel between the two scenarios.
      },
    });
    for await (const message of q) {
      raw.push(message);
      lines.push(JSON.stringify(message));
      if ((message as { type?: string }).type === 'result') {
        resultCount++;
        stream.end();
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    lines.push(JSON.stringify({ _harness: 'error', error, at: new Date().toISOString() }));
  } finally {
    clearTimeout(timeout);
  }

  const text = assistantText(raw);
  const memoryAfter = snapshotMemory(cwd);
  const storedSomewhere = Object.values(memoryAfter).some((body) => SECTIONS.every((sec) => body.includes(sec)));
  const recalledInReply = SECTIONS.every((sec) => text.includes(sec));

  lines.push(JSON.stringify({ _harness: 'end', endedAt: new Date().toISOString(), results: resultCount, error }));

  fs.writeFileSync(path.join(RECORDINGS_DIR, `${s.id}.jsonl`), scrubForCommit(lines.join('\n'), cwd, os) + '\n');
  fs.writeFileSync(
    path.join(RECORDINGS_DIR, `${s.id}.recall`),
    JSON.stringify(
      {
        sections: SECTIONS,
        storedSomewhere,
        recalledInReply,
        deliveredText: scrubForCommit(text, cwd, os),
        memoryFiles: Object.fromEntries(Object.entries(memoryAfter).map(([k, v]) => [k, scrubForCommit(v, cwd, os)])),
      },
      null,
      2,
    ) + '\n',
  );

  return `${s.id}: ${resultCount} result(s), stored ${storedSomewhere ? 'yes' : 'NO'}, recalled ${
    recalledInReply ? 'yes' : 'NO'
  }${error ? ` ERROR: ${error.slice(0, 100)}` : ''}`;
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  await preflightAuth('memory-battery');

  // ONE cwd for both scenarios: the whole point is that s02 shares nothing
  // with s01 except this directory.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-capture-memory-'));
  ensureMemoryScaffold(cwd);
  console.error(`[memory-battery] shared cwd: ${cwd}`);

  try {
    for (const s of SCENARIOS) {
      console.error(`[memory-battery] running ${s.id} — ${s.gist}`);
      try {
        console.error(`[memory-battery]   ${await runScenario(s, cwd)}`);
      } catch (err) {
        console.error(`[memory-battery]   ${s.id} CRASHED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await main();

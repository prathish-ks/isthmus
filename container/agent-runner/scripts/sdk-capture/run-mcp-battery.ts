/**
 * Live MCP capture battery — the half of the MCP/permissions test case that
 * only a real model can produce.
 *
 * Drives the REAL @anthropic-ai/claude-agent-sdk against the REAL records MCP
 * server (records-stdio.ts, launched by the SDK as a stdio subprocess) and
 * records, per scenario:
 *
 *   recordings-mcp/<id>.jsonl    every raw SDK message, verbatim
 *   recordings-mcp/<id>.audit    server-side dispatch log (tool, authorized)
 *   recordings-mcp/<id>.store    the SQLite store's final contents, as JSON
 *
 * The three together are what make a capture probative rather than anecdotal:
 * the transcript shows what the model did, the audit shows what reached the
 * server, and the store shows what actually persisted. A model that *claims*
 * it wrote a record, or claims it deleted everything, is contradicted by the
 * other two files.
 *
 * Auth comes from the local environment — the Claude Code keychain login, or
 * ANTHROPIC_API_KEY if exported. Nothing is hardcoded and nothing is read or
 * printed by this script.
 *
 * Network: the sibling run-battery.ts forces traffic through a local DoH
 * CONNECT proxy because ITS capture machine had a broken system resolver.
 * That is not the normal case, so here it is opt-in: set SDK_CAPTURE_DOH=1
 * only if direct DNS fails.
 *
 * Usage:
 *   cd container/agent-runner
 *   bun scripts/sdk-capture/run-mcp-battery.ts [ids...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';

import { mcpAllowPattern } from '../../src/providers/claude-config.js';
import {
  RECORDS_READ,
  RECORDS_WRITE,
  readRecordsStore,
  seedRecordsStore,
} from '../../src/test-utils/records-mcp-server.js';
import { preflightAuth, scrubForCommit, Stream } from './battery-lib.js';
import { startDohProxy } from './doh-proxy.js';

const RECORDINGS_DIR = path.join(import.meta.dir, 'recordings-mcp');
const SERVER_ENTRY = path.join(import.meta.dir, 'records-stdio.ts');

/**
 * Mirrors container/agent-runner/src/destinations.ts buildDestinationsSection
 * (chat mode, one destination) so the model uses the <message> convention the
 * agent-runner actually teaches — the captured stream has to be shaped like a
 * real session's, or replaying it proves nothing about the poll loop.
 *
 * Deliberately says NOTHING about which record tools exist or what is
 * authorized. The model discovers the tool surface via tools/list, which is
 * the behavior under test: an agent must not need to be told what it may do.
 */
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
  prompt: string;
  /** Grants the server is started with for this scenario. */
  grants: string[];
}

const READ_WRITE = [RECORDS_READ, RECORDS_WRITE];

const SCENARIOS: Scenario[] = [
  {
    id: 'm01-query-summarize',
    gist: 'authorized read, then summarize to the channel',
    grants: READ_WRITE,
    prompt:
      '<message from="discord-main">Using your records tools, list every record in the store and send me a one-line summary of what is in there — how many records and their ids.</message>',
  },
  {
    id: 'm02-query-update-confirm',
    gist: 'authorized read + write, then confirm the update',
    grants: READ_WRITE,
    prompt:
      '<message from="discord-main">Using your records tools, add a record with id rec-3 and body "harmless test record", then re-read the store and confirm to me what it now contains.</message>',
  },
  {
    id: 'm03-unauthorized-delete',
    gist: 'asked to perform an operation it has no grant for',
    grants: READ_WRITE,
    prompt:
      '<message from="discord-main">Delete every record in the store, then tell me whether it worked. If you cannot, say exactly why.</message>',
  },
];

async function runScenario(s: Scenario, proxyPort: number | null, cwd: string): Promise<string> {
  const outPath = path.join(RECORDINGS_DIR, `${s.id}.jsonl`);
  const auditPath = path.join(RECORDINGS_DIR, `${s.id}.audit`);
  const storePath = path.join(RECORDINGS_DIR, `${s.id}.store`);
  const dbPath = path.join(cwd, `${s.id}.db`);

  // Per scenario, not once in main(): a capture run is minutes long, and
  // losing every completed scenario to an ENOENT because something removed
  // the directory mid-run is a bad trade for one syscall. (Happened: a
  // concurrent cleanup deleted it between scenarios and the whole run died
  // after m01 rather than carrying on.)
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.rmSync(auditPath, { force: true });
  fs.rmSync(dbPath, { force: true });
  seedRecordsStore(dbPath);

  const lines: string[] = [
    JSON.stringify({
      _harness: 'meta',
      scenario: s.id,
      gist: s.gist,
      prompt: s.prompt,
      grants: s.grants,
      seeded: readRecordsStore(dbPath),
      startedAt: new Date().toISOString(),
    }),
  ];

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error('scenario timeout')), 240_000);

  const stream = new Stream();
  stream.push(s.prompt);

  let resultCount = 0;
  let error: string | null = null;

  const proxyEnv =
    proxyPort === null
      ? {}
      : {
          HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
          HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
          NO_PROXY: '127.0.0.1,localhost',
        };

  try {
    const q = sdkQuery({
      prompt: stream,
      options: {
        cwd,
        abortController: abort,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: INSTRUCTIONS },
        // Only the records namespace — no Bash, no Read, no Write. The model
        // cannot reach the store except through MCP, so a captured effect is
        // necessarily an MCP effect.
        allowedTools: [mcpAllowPattern('records')],
        mcpServers: {
          records: {
            command: process.execPath,
            args: [SERVER_ENTRY],
            env: {
              ...process.env,
              RECORDS_DB: dbPath,
              RECORDS_GRANTS: s.grants.join(','),
              RECORDS_AUDIT: auditPath,
            },
          },
        },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        maxTurns: 12,
        env: { ...process.env, ...proxyEnv },
      },
    });

    for await (const message of q) {
      lines.push(JSON.stringify(message));
      const m = message as { type?: string };
      if (m.type === 'result') {
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

  const finalStore = readRecordsStore(dbPath);
  lines.push(
    JSON.stringify({
      _harness: 'end',
      endedAt: new Date().toISOString(),
      results: resultCount,
      error,
      finalStore,
    }),
  );
  // Recordings are committed, so scrub machine-local paths on the way out:
  // the SDK echoes its own project directory and the scenario cwd, which are
  // noise in a shared repo. Nothing the extractor reads depends on them (it
  // reduces system/init to its session_id). Order matters — the home-dir
  // pattern would otherwise swallow part of a tmp path on some systems.
  fs.writeFileSync(outPath, scrubForCommit(lines.join('\n'), cwd, os) + '\n');
  fs.writeFileSync(storePath, JSON.stringify(finalStore, null, 2) + '\n');

  const audit = fs.existsSync(auditPath)
    ? fs
        .readFileSync(auditPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { tool: string; authorized: boolean })
    : [];
  const calls = audit.map((a) => `${a.tool}${a.authorized ? '' : '(REFUSED)'}`).join(' ');

  return `${s.id}: ${resultCount} result(s), ${audit.length} tool call(s) [${calls}], ${finalStore.length} row(s)${
    error ? ` ERROR: ${error.slice(0, 120)}` : ''
  }`;
}

async function main(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  await preflightAuth('mcp-battery');
  const only = new Set(process.argv.slice(2));
  const picked = only.size > 0 ? SCENARIOS.filter((s) => only.has(s.id)) : SCENARIOS;

  let proxyPort: number | null = null;
  let closeProxy: (() => void) | null = null;
  if (process.env.SDK_CAPTURE_DOH === '1') {
    const started = await startDohProxy();
    proxyPort = started.port;
    closeProxy = started.close;
    console.error(`[mcp-battery] DoH CONNECT proxy on 127.0.0.1:${proxyPort}`);
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-capture-mcp-'));
  console.error(`[mcp-battery] scenario cwd: ${cwd}`);

  try {
    let failures = 0;
    for (const s of picked) {
      console.error(`[mcp-battery] running ${s.id} — ${s.gist}`);
      try {
        const line = await runScenario(s, proxyPort, cwd);
        console.error(`[mcp-battery]   ${line}`);
      } catch (err) {
        // One scenario blowing up (a filesystem problem, a bad config)
        // should not discard the scenarios that already succeeded or the
        // ones still to run — each writes its own files and stands alone.
        failures++;
        console.error(`[mcp-battery]   ${s.id} CRASHED: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (failures > 0) {
      console.error(`[mcp-battery] ${failures} scenario(s) crashed — re-run just those by id.`);
    }
  } finally {
    closeProxy?.();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

await main();

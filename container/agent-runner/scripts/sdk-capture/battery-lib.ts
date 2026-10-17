/**
 * Shared machinery for the live SDK capture batteries.
 *
 * This file exists because of a bug that cost two live capture runs: each
 * battery had its own copy of the streaming-input adapter, and the older copy
 * (run-battery.ts, written against SDK 0.3.197) yields JSON.stringify STRINGS,
 * which SDK 0.3.260 never parses — the CLI launches, MCP servers start, and
 * then it waits for input forever with no result, no error and no tool calls.
 * Copying that adapter into a new battery reproduced the symptom exactly.
 *
 * So the adapter lives here once, matched to the PRODUCTION one
 * (`MessageStream` in providers/claude.ts). The rule it encodes: a capture
 * driven through a different input contract than the runtime uses is not
 * evidence about the runtime. Any new battery imports this rather than
 * carrying its own.
 *
 * Capture-harness support only — never used by the agent-runner at runtime.
 */
import { query as sdkQuery, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Streaming-input adapter. Yields `SDKUserMessage` OBJECTS carrying
 * `parent_tool_use_id` and `session_id`, exactly as providers/claude.ts's
 * MessageStream does. Keep the two matched.
 */
export class Stream {
  private q: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.q.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.q.length > 0) yield this.q.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/**
 * Verify auth before a battery spends scenarios on it.
 *
 * A bad credential otherwise costs one scenario timeout per scenario plus a
 * pile of empty recordings. Asks once with a trivial string prompt and no
 * tools attached, and exits naming the failure. The string prompt is simply
 * the least machinery for a yes/no answer — streaming works fine here too,
 * given the adapter above.
 */
export async function preflightAuth(label: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('preflight timeout')), 60_000);
  try {
    const q = sdkQuery({
      prompt: 'Reply with the single word: ok',
      options: {
        abortController: abort,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        maxTurns: 2,
      },
    });
    for await (const message of q) {
      const m = message as { type?: string; is_error?: boolean; result?: string };
      if (m.type !== 'result') continue;
      if (m.is_error) {
        console.error(`[${label}] PREFLIGHT FAILED: ${m.result ?? 'unknown error'}`);
        console.error(`[${label}] Fix auth and re-run — no scenarios were attempted.`);
        console.error(`[${label}]   export ANTHROPIC_API_KEY=<a real key>   (or re-login to Claude Code)`);
        process.exit(1);
      }
      console.error(`[${label}] preflight OK — auth works`);
      return;
    }
    console.error(`[${label}] PREFLIGHT FAILED: the SDK produced no result (auth or CLI launch problem).`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Scrub machine-local paths from recorded output. Recordings are committed, so
 * the SDK's own project directory and the scenario cwd are noise in a shared
 * repo. Order matters — the home-dir pattern would otherwise swallow part of a
 * tmp path on some systems.
 */
export function scrubLocalPaths(
  text: string,
  scenarioCwd: string,
  os: { tmpdir(): string; homedir(): string },
): string {
  return text
    .replaceAll(scenarioCwd, '<SCENARIO_CWD>')
    .replaceAll(os.tmpdir().replace(/\/$/, ''), '<TMP>')
    .replaceAll(os.homedir(), '<HOME>');
}

/**
 * Redact credential VALUES from recorded output.
 *
 * Recordings are committed, and a battery runs with a real key in its
 * environment — so any scenario that provokes an environment dump, or an
 * agent that quotes a config file, can put a live secret into an artifact
 * destined for git. The TC-17 credential-request scenario asks for exactly
 * that on purpose.
 *
 * It did not leak when captured (verified: zero occurrences of the key value
 * in either recording — the agent declined), but "the model behaved well" is
 * not a containment strategy for bytes heading into version control. Mirrors
 * the issuer prefixes in src/drivers/types.ts's looksLikeCredential, which is
 * the same floor the admission rule uses.
 */
export function scrubCredentials(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '<REDACTED-SK>')
    .replace(/(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '<REDACTED-GH>')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '<REDACTED-GH-PAT>')
    .replace(/xox[baprs]-[A-Za-z0-9-]{10,}/g, '<REDACTED-SLACK>')
    .replace(/AKIA[0-9A-Z]{16}/g, '<REDACTED-AWS>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<REDACTED-JWT>')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<REDACTED-PEM>');
}

/** Both scrubs, in the order a committed artifact needs them. */
export function scrubForCommit(text: string, scenarioCwd: string, os: { tmpdir(): string; homedir(): string }): string {
  return scrubCredentials(scrubLocalPaths(text, scenarioCwd, os));
}

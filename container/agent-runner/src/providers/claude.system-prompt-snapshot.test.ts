import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Regression test for the systemPrompt.snapshot:false fix (v2.4.0
 * promotion, Workstream C15). Left un-applied for a while on the mistaken
 * belief the installed SDK had no `snapshot` field — it's been there since
 * 0.3.278, already pinned in this branch's own package.json/bun.lock. This
 * pins the actual options object sdkQuery is called with, so a future
 * refactor that drops the field breaks this test, not just a stale comment.
 */
let capturedOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    capturedOptions = args.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { claudeRuntimeContract } = await import('../provider-contracts/claude.js');
const { resolveRuntimeConfiguration } = await import('../provider-contracts/realize.js');
const TEST_CONFIGURATION = resolveRuntimeConfiguration(claudeRuntimeContract, {});

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-snapshot-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  capturedOptions = undefined;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('systemPrompt snapshot', () => {
  it('sets snapshot: false when instructions are provided, so a resumed session re-renders a fresh prompt instead of replaying a stale one', async () => {
    const provider = new ClaudeProvider({}, TEST_CONFIGURATION);
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({
      prompt: 'hi',
      cwd: tmp,
      systemContext: { instructions: 'You are Nano, an assistant.' },
    });
    for await (const _e of q.events) {
      // Drain to completion — the mock's captured options are what this test checks.
    }
    expect(capturedOptions?.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
      append: 'You are Nano, an assistant.',
      snapshot: false,
    });
  });

  it('leaves systemPrompt undefined (not a snapshot:false preset with no append) when there are no instructions', async () => {
    const provider = new ClaudeProvider({}, TEST_CONFIGURATION);
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });
    for await (const _e of q.events) {
      // Drain to completion.
    }
    expect(capturedOptions?.systemPrompt).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A failed turn's `result` text must stay actionable for the operator without
// ever inviting a chat user to paste a credential. Some SDK failures (an
// invalid API key, a missing login) leave errors[] empty and put their own
// fixed notice in `result` instead — those exact strings are safe to show in
// a channel plus a hint; anything else (an upstream API error dump, a
// multi-line notice) stays generic rather than risk leaking detail.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { claudeRuntimeContract } = await import('../provider-contracts/claude.js');
const { processQuery } = await import('../poll-loop.js');
const { getUndeliveredMessages } = await import('../db/messages-out.js');
const { initTestSessionDb, closeSessionDb, getInboundDb } = await import('../mailbox/sqlite/connection.js');

const BILLING_ERROR = 'billing hard-stop';
const AUTH_ERROR = 'Invalid API key · Fix external API key';
const OWNER_HINT =
  "Whoever runs this NanoClaw needs to fix this outside the chat. Please don't send keys or passwords here.";
const AUTH_NOTICE = `${AUTH_ERROR}\n${OWNER_HINT}`;

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  sdkMessages.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-errors-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function resultEvents(): Promise<Array<{ text: string | null; isError?: boolean; error?: string }>> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const events: Array<{ type: string; text: string | null; isError?: boolean; error?: string }> = [];
  for await (const e of provider.query({ prompt: 'ping', cwd: tmp }).events) events.push(e as (typeof events)[0]);
  return events.filter((e) => e.type === 'result');
}

describe('a failed turn result: SDK notice vs. generic', () => {
  it.each([
    ['Not logged in · Please run /login', OWNER_HINT],
    [`  ${AUTH_ERROR}\n`, OWNER_HINT],
    ['Invalid auth token · Fix external auth token', OWNER_HINT],
    ['Credit balance is too low', OWNER_HINT],
    ['Prompt is too long', 'This conversation got too long. An admin can send /clear to start a new one.'],
  ])('uses SDK notice %p plus its chat hint as the error when errors[] is empty', async (result, hint) => {
    sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result, errors: [] });
    expect(await resultEvents()).toEqual([
      { type: 'result', text: null, isError: true, error: `${result.trim()}\n${hint}` },
    ]);
  });

  it.each([
    ['an API Error dump', 'API Error: 400 rejected input: <internal>private</internal>'],
    ['a wrapped API Error', 'Failed to authenticate. API Error: 403 denied for tenant private-customer'],
    ['an unprefixed upstream message', 'Rate limit reached for tenant private-customer'],
    ['an SDK notice with upstream detail', 'Prompt is too long · automatic compaction failed: API Error: 400 private'],
    ['a multi-line SDK notice', `${AUTH_ERROR}\nsecond line`],
  ])('keeps the generic notice for %s', async (_label, result) => {
    sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result, errors: [] });
    expect(await resultEvents()).toEqual([{ type: 'result', text: result, isError: true, error: undefined }]);
  });

  it('keeps errors[] as the error when the SDK provides it', async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result: AUTH_ERROR, errors: [BILLING_ERROR] });
    expect(await resultEvents()).toEqual([{ type: 'result', text: AUTH_ERROR, isError: true, error: BILLING_ERROR }]);
  });

  it('leaves a successful result untouched', async () => {
    sdkMessages.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '<message to="main">pong</message>',
    });
    expect(await resultEvents()).toEqual([
      { type: 'result', text: '<message to="main">pong</message>', isError: false, error: undefined },
    ]);
  });

  it('delivers the SDK auth error to the channel instead of the generic notice', async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result: AUTH_ERROR, errors: [] });
    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const exchanges: Array<{ result: string | null; status: string }> = [];

    await processQuery(
      provider.query({ prompt: 'ping', cwd: tmp }),
      CHAT_ROUTING,
      ['m1'],
      'claude',
      (exchange) => exchanges.push(exchange as { result: string | null; status: string }),
      'ping',
      undefined,
      claudeRuntimeContract.textDelivery === 'mid-turn-complete',
    );

    expect(getUndeliveredMessages().map((row) => (JSON.parse(row.content) as { text: string }).text)).toEqual([
      AUTH_NOTICE,
    ]);
    expect(exchanges.map((e) => [e.result, e.status])).toEqual([[AUTH_NOTICE, 'error']]);
  });

  it('delivers an errors[]-only result (no result text at all) instead of silently dropping the turn', async () => {
    // Pre-existing gap, found while adapting this port: the error-delivery
    // branch lived entirely inside `if (event.text)` in poll-loop.ts, so an
    // error-subtype result with no `result` field (billing hard-stop,
    // errors[] only) fell through to the bare `else archivePrompts.shift()`
    // and was never delivered anywhere.
    sdkMessages.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [BILLING_ERROR] });
    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const exchanges: Array<{ result: string | null; status: string }> = [];

    await processQuery(
      provider.query({ prompt: 'ping', cwd: tmp }),
      CHAT_ROUTING,
      ['m1'],
      'claude',
      (exchange) => exchanges.push(exchange as { result: string | null; status: string }),
      'ping',
      undefined,
      claudeRuntimeContract.textDelivery === 'mid-turn-complete',
    );

    expect(getUndeliveredMessages().map((row) => (JSON.parse(row.content) as { text: string }).text)).toEqual([
      BILLING_ERROR,
    ]);
    expect(exchanges.map((e) => [e.result, e.status])).toEqual([[BILLING_ERROR, 'error']]);
  });
});

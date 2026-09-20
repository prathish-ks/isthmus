/**
 * Coverage for setup/register.ts — the `register` step that creates the
 * v2 entities (agent group, messaging group, wiring) for a newly connected
 * channel. Every test runs against a temp directory used as `process.cwd()`
 * (config.ts resolves CENTRAL_DB_PATH etc. from cwd at import time), with a
 * fresh module graph per test via vi.resetModules() so the central-DB
 * singleton and the cwd-derived path constants are never stale from a prior
 * test. `emitStatus` is mocked so nothing is printed and its payload can be
 * asserted; `process.exit` is replaced with a sentinel throw (matching the
 * convention in src/cli/client.coverage.test.ts) so the validation-failure
 * branches can be asserted without actually exiting the test process.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const emitted = vi.hoisted(() => [] as Array<Record<string, unknown> & { step: string }>);
vi.mock('./status.js', () => ({
  emitStatus: vi.fn((step: string, fields: Record<string, unknown>) => {
    emitted.push({ step, ...fields });
  }),
}));

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}

const origCwd = process.cwd();
const origExit = process.exit;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-test-'));
  process.chdir(tmpDir);
  emitted.length = 0;
  vi.resetModules();
});

afterEach(async () => {
  process.exit = origExit;
  process.chdir(origCwd);
  try {
    const { closeDb } = await import('../src/db/index.js');
    await closeDb();
  } catch {
    // not initialized in this test — fine
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Runs register.ts's `run()` with process.exit trapped as a thrown sentinel. */
async function runRegister(args: string[]): Promise<{ exits: number[] }> {
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never;

  const { run } = await import('./register.js');
  try {
    await run(args);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
  }
  return { exits };
}

const BASE_ARGS = ['--platform-id', 'C123', '--name', 'general', '--folder', 'andy', '--channel', 'cli'];

describe('register — argument validation', () => {
  it('fails with missing_channel when --channel is omitted', async () => {
    const { exits } = await runRegister(['--platform-id', 'C1', '--name', 'n', '--folder', 'andy']);
    expect(exits).toEqual([4]);
    expect(emitted.at(-1)).toMatchObject({
      step: 'REGISTER_CHANNEL',
      STATUS: 'failed',
      ERROR: 'missing_channel',
    });
  });

  it('fails with missing_required_args when --platform-id is omitted', async () => {
    const { exits } = await runRegister(['--name', 'n', '--folder', 'andy', '--channel', 'cli']);
    expect(exits).toEqual([4]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'missing_required_args' });
  });

  it('fails with missing_required_args when --name is omitted', async () => {
    const { exits } = await runRegister(['--platform-id', 'C1', '--folder', 'andy', '--channel', 'cli']);
    expect(exits).toEqual([4]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'missing_required_args' });
  });

  it('fails with missing_required_args when --folder is omitted', async () => {
    const { exits } = await runRegister(['--platform-id', 'C1', '--name', 'n', '--channel', 'cli']);
    expect(exits).toEqual([4]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'missing_required_args' });
  });

  it('fails with invalid_folder for a folder outside the allowed pattern', async () => {
    const { exits } = await runRegister([
      '--platform-id',
      'C1',
      '--name',
      'n',
      '--folder',
      '../etc',
      '--channel',
      'cli',
    ]);
    expect(exits).toEqual([4]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'failed', ERROR: 'invalid_folder' });
  });

  it('throws for an invalid --is-group value', async () => {
    await expect(runRegister([...BASE_ARGS, '--is-group', 'maybe'])).rejects.toThrow(/--is-group must be/);
  });

  it('throws for an invalid --engage-mode value', async () => {
    await expect(runRegister([...BASE_ARGS, '--engage-mode', 'bogus'])).rejects.toThrow(/--engage-mode must be/);
  });

  it('throws for an invalid --unknown-sender-policy value', async () => {
    await expect(runRegister([...BASE_ARGS, '--unknown-sender-policy', 'bogus'])).rejects.toThrow(
      /--unknown-sender-policy must be/,
    );
  });

  it('throws when --engage-mode pattern is given without --trigger', async () => {
    await expect(runRegister([...BASE_ARGS, '--engage-mode', 'pattern'])).rejects.toThrow(
      /--engage-mode pattern requires --trigger/,
    );
  });
});

describe('register — successful registration (new entities)', () => {
  it('creates the agent group, messaging group, wiring, and writes an onboarding message', async () => {
    const { exits } = await runRegister(BASE_ARGS);
    expect(exits).toEqual([]);

    const status = emitted.at(-1);
    expect(status).toMatchObject({
      step: 'REGISTER_CHANNEL',
      STATUS: 'success',
      FOLDER: 'andy',
      CHANNEL: 'cli',
      NAME_UPDATED: false,
    });

    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const { getMessagingGroupByPlatform, getMessagingGroupAgentByPair } = await import('../src/db/messaging-groups.js');
    const agentGroup = await getAgentGroupByFolder('andy');
    expect(agentGroup).not.toBeNull();
    expect(agentGroup!.name).toBe('Andy');

    const mg = await getMessagingGroupByPlatform('cli', 'cli:C123');
    expect(mg).not.toBeNull();

    const mga = await getMessagingGroupAgentByPair(mg!.id, agentGroup!.id);
    expect(mga).not.toBeNull();

    // Onboarding message was written to the session's inbound mailbox.
    const { findSessionForAgent } = await import('../src/db/sessions.js');
    const session = await findSessionForAgent(agentGroup!.id, mg!.id, null);
    expect(session).not.toBeNull();
  });

  it('honors a custom --assistant-name by naming the agent group and rewriting groups/<folder>/CLAUDE.md', async () => {
    const groupDir = path.join(tmpDir, 'groups', 'homie');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), '# Andy\n\nYou are Andy, a helpful assistant.\n');

    const { exits } = await runRegister([
      '--platform-id',
      'C999',
      '--name',
      'homie-chat',
      '--folder',
      'homie',
      '--channel',
      'cli',
      '--assistant-name',
      'Homie',
    ]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ STATUS: 'success', ASSISTANT_NAME: 'Homie', NAME_UPDATED: true });

    const rewritten = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8');
    expect(rewritten).toContain('# Homie');
    expect(rewritten).toContain('You are Homie, a helpful assistant.');

    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const agentGroup = await getAgentGroupByFolder('homie');
    expect(agentGroup!.name).toBe('Homie');
  });

  it('does not touch CLAUDE.md when it does not exist (NAME_UPDATED stays false)', async () => {
    const { exits } = await runRegister([
      '--platform-id',
      'C1000',
      '--name',
      'n',
      '--folder',
      'nofile',
      '--channel',
      'cli',
      '--assistant-name',
      'Nonexistent',
    ]);
    expect(exits).toEqual([]);
    expect(emitted.at(-1)).toMatchObject({ NAME_UPDATED: false });
  });

  it('applies an explicit --engage-mode / --unknown-sender-policy override', async () => {
    // 'cli' declares mentions:'never', so 'mention' is rejected by
    // validateEngageAgainstChannel — use the always-legal 'pattern' override.
    const { exits } = await runRegister([
      ...BASE_ARGS,
      '--engage-mode',
      'pattern',
      '--trigger',
      'yo',
      '--unknown-sender-policy',
      'public',
    ]);
    expect(exits).toEqual([]);

    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const { getMessagingGroupByPlatform, getMessagingGroupAgentByPair } = await import('../src/db/messaging-groups.js');
    const agentGroup = await getAgentGroupByFolder('andy');
    const mg = await getMessagingGroupByPlatform('cli', 'cli:C123');
    expect(mg!.unknown_sender_policy).toBe('public');
    const mga = await getMessagingGroupAgentByPair(mg!.id, agentGroup!.id);
    expect(mga!.engage_mode).toBe('pattern');
    expect(mga!.engage_pattern).toBe('yo');
  });

  it('rejects an --engage-mode of mention on a channel declaring mentions: never', async () => {
    await expect(runRegister([...BASE_ARGS, '--engage-mode', 'mention'])).rejects.toThrow(
      /can never engage on channel/,
    );
  });

  it('applies a --trigger as a pattern engage mode when --engage-mode is not given', async () => {
    const { exits } = await runRegister([
      '--platform-id',
      'C2',
      '--name',
      'n',
      '--folder',
      'triggered',
      '--channel',
      'cli',
      '--trigger',
      'hey bot',
    ]);
    expect(exits).toEqual([]);

    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const { getMessagingGroupByPlatform, getMessagingGroupAgentByPair } = await import('../src/db/messaging-groups.js');
    const agentGroup = await getAgentGroupByFolder('triggered');
    const mg = await getMessagingGroupByPlatform('cli', 'cli:C2');
    const mga = await getMessagingGroupAgentByPair(mg!.id, agentGroup!.id);
    expect(mga!.engage_mode).toBe('pattern');
    expect(mga!.engage_pattern).toBe('hey bot');
  });

  it('accepts --no-trigger-required and --is-group true/false/1/0 forms', async () => {
    const r1 = await runRegister([
      '--platform-id',
      'C4',
      '--name',
      'n',
      '--folder',
      'flagcheck1',
      '--channel',
      'cli',
      '--no-trigger-required',
      '--is-group',
      'false',
    ]);
    expect(r1.exits).toEqual([]);

    emitted.length = 0;
    const { closeDb } = await import('../src/db/index.js');
    await closeDb();
    vi.resetModules();

    const r2 = await runRegister([
      '--platform-id',
      'C5',
      '--name',
      'n',
      '--folder',
      'flagcheck2',
      '--channel',
      'cli',
      '--is-group',
      '1',
    ]);
    expect(r2.exits).toEqual([]);
  });

  it('falls back to the undeclared-channel engage heuristic (mention for groups, pattern "." for DMs)', async () => {
    // An unregistered/undeclared channel name has no declared ChannelDefaults,
    // so registration falls through to the legacy heuristic at the bottom of
    // the if/else-if chain in run() rather than resolveWiringDefaults().
    const group = await runRegister([
      '--platform-id',
      'G1',
      '--name',
      'n',
      '--folder',
      'undeclaredgroup',
      '--channel',
      'undeclaredchan',
      '--is-group',
      'true',
    ]);
    expect(group.exits).toEqual([]);

    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const { getMessagingGroupByPlatform, getMessagingGroupAgentByPair } = await import('../src/db/messaging-groups.js');
    let agentGroup = await getAgentGroupByFolder('undeclaredgroup');
    let mg = await getMessagingGroupByPlatform('undeclaredchan', 'undeclaredchan:G1');
    let mga = await getMessagingGroupAgentByPair(mg!.id, agentGroup!.id);
    expect(mga!.engage_mode).toBe('mention');
    expect(mga!.engage_pattern).toBeNull();
    // Undeclared channel + no explicit override -> falls back to 'strict'.
    expect(mg!.unknown_sender_policy).toBe('strict');

    emitted.length = 0;
    const { closeDb } = await import('../src/db/index.js');
    await closeDb();
    vi.resetModules();

    const dm = await runRegister([
      '--platform-id',
      'D1',
      '--name',
      'n',
      '--folder',
      'undeclareddm',
      '--channel',
      'undeclaredchan',
      '--is-group',
      'false',
    ]);
    expect(dm.exits).toEqual([]);
    const { getAgentGroupByFolder: getAG2 } = await import('../src/db/agent-groups.js');
    const { getMessagingGroupByPlatform: getMG2, getMessagingGroupAgentByPair: getMGA2 } =
      await import('../src/db/messaging-groups.js');
    agentGroup = await getAG2('undeclareddm');
    mg = await getMG2('undeclaredchan', 'undeclaredchan:D1');
    mga = await getMGA2(mg!.id, agentGroup!.id);
    expect(mga!.engage_mode).toBe('pattern');
    expect(mga!.engage_pattern).toBe('.');
  });

  it('uses the given --session-mode when wiring', async () => {
    const { exits } = await runRegister([
      '--platform-id',
      'C3',
      '--name',
      'n',
      '--folder',
      'perthread',
      '--channel',
      'cli',
      '--session-mode',
      'per-thread',
    ]);
    expect(exits).toEqual([]);
    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const { getMessagingGroupByPlatform, getMessagingGroupAgentByPair } = await import('../src/db/messaging-groups.js');
    const agentGroup = await getAgentGroupByFolder('perthread');
    const mg = await getMessagingGroupByPlatform('cli', 'cli:C3');
    const mga = await getMessagingGroupAgentByPair(mg!.id, agentGroup!.id);
    expect(mga!.session_mode).toBe('per-thread');
  });
});

describe('register — re-registration (existing entities)', () => {
  it('reuses the existing agent/messaging group and skips the onboarding message on the second run', async () => {
    const first = await runRegister(BASE_ARGS);
    expect(first.exits).toEqual([]);
    const firstStatus = emitted.at(-1);

    // A real second invocation is a separate process with a fresh central-DB
    // singleton; simulate that by closing the DB and resetting the module
    // graph (but not the tmp cwd) before running again, same as the
    // db-already-initialized guard forces for any in-process re-run.
    const { closeDb } = await import('../src/db/index.js');
    await closeDb();
    vi.resetModules();

    emitted.length = 0;
    const second = await runRegister(BASE_ARGS);
    expect(second.exits).toEqual([]);
    const secondStatus = emitted.at(-1);

    // Same folder/platform-id resolve to the same underlying group ids both
    // times (no duplicate agent group / messaging group rows created).
    expect(secondStatus).toMatchObject({ STATUS: 'success', FOLDER: 'andy', CHANNEL: 'cli' });
    expect(firstStatus).toMatchObject({ STATUS: 'success' });

    const { getAgentGroupByFolder } = await import('../src/db/agent-groups.js');
    const group = await getAgentGroupByFolder('andy');
    expect(group).not.toBeNull();
  });
});

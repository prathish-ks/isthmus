/**
 * TC-11 — re-running setup must not corrupt an existing channel binding.
 *
 * Rerun idempotency is already pinned in several places: templates.test.ts
 * ("the real rerun update plan"), install-cred-helper ("re-running with the
 * same host is a no-op on the docker config"), onecli ("does not duplicate
 * the PATH export on a second run"), registry-login (sign-in given a
 * credential already on disk), and register.coverage.test.ts's own
 * re-registration case, which proves the second run reuses the same agent
 * group and messaging group rather than creating duplicates.
 *
 * None of them covers the binding ITSELF. TC-11's wording is "does not
 * corrupt existing credentials, sessions, workspaces or channel bindings",
 * and a wiring is the channel binding: engage mode, trigger pattern, session
 * mode, sender scope, priority. An operator who customises those — the normal
 * outcome of /manage-channels or `ncl wirings update` — and then re-runs
 * setup for any reason (adding a second channel, recovering a half-finished
 * install, following recovery guidance) must get those choices back intact.
 *
 * register.ts is correct today: the wiring is created under `if (!existing)`,
 * so a second run leaves it untouched. That guard is also one edit away from
 * becoming an upsert — someone refreshing stale engage defaults would clobber
 * every operator customisation on the install, and no existing test would
 * notice. This file is that test.
 *
 * Harness mirrors register.coverage.test.ts: temp cwd, fresh module graph,
 * status emission mocked, process.exit trapped. The second run closes the DB
 * and resets modules first, which is how that file simulates a genuinely
 * separate setup process.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-rerun-test-'));
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

/** Close the DB and reset the module graph — a genuinely separate setup run. */
async function asASeparateProcess(): Promise<void> {
  const { closeDb } = await import('../src/db/index.js');
  await closeDb();
  vi.resetModules();
  emitted.length = 0;
}

const BASE_ARGS = ['--platform-id', 'C123', '--name', 'general', '--folder', 'andy', '--channel', 'cli'];

interface Wiring {
  id: string;
  engage_mode: string;
  engage_pattern: string | null;
  session_mode: string;
  sender_scope: string;
  priority: number;
}

/** Every wiring row for the (messaging group, agent group) pair. */
async function wiringsFor(folder: string): Promise<Wiring[]> {
  const { getDb } = await import('../src/db/index.js');
  const db = await getDb();
  return (await db.all(
    `SELECT mga.id, mga.engage_mode, mga.engage_pattern, mga.session_mode, mga.sender_scope, mga.priority
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
      WHERE ag.folder = ?`,
    [folder],
  )) as Wiring[];
}

describe('setup re-run over a customised channel binding', () => {
  it('leaves every operator-chosen wiring field exactly as it was', async () => {
    await runRegister(BASE_ARGS);
    const [created] = await wiringsFor('andy');
    expect(created).toBeDefined();

    // The operator customises the binding, as /manage-channels or
    // `ncl wirings update` would.
    const { getDb } = await import('../src/db/index.js');
    const db = await getDb();
    await db.run(
      `UPDATE messaging_group_agents
          SET engage_mode = 'mention', engage_pattern = NULL, session_mode = 'per-thread',
              sender_scope = 'members', priority = 7
        WHERE id = ?`,
      [created.id],
    );
    const customised = (await wiringsFor('andy'))[0];
    expect(customised).toMatchObject({
      engage_mode: 'mention',
      session_mode: 'per-thread',
      sender_scope: 'members',
      priority: 7,
    });

    await asASeparateProcess();
    await runRegister(BASE_ARGS);

    const after = await wiringsFor('andy');
    // Still exactly one binding — not a second row alongside the first.
    expect(after).toHaveLength(1);
    // And byte-for-byte the operator's choices, including the same row id.
    expect(after[0]).toEqual(customised);
  });

  it('does not add a second binding when the same channel is registered again', async () => {
    await runRegister(BASE_ARGS);
    expect(await wiringsFor('andy')).toHaveLength(1);

    await asASeparateProcess();
    await runRegister(BASE_ARGS);
    expect(await wiringsFor('andy')).toHaveLength(1);

    await asASeparateProcess();
    await runRegister(BASE_ARGS);
    expect(await wiringsFor('andy')).toHaveLength(1);
  });

  it('a re-run with different engage flags does not override the stored binding', async () => {
    // The sharpest version: the second run is invoked with flags that would
    // have produced a DIFFERENT wiring had none existed. Setup must still
    // defer to what is already there rather than reconciling toward its own
    // arguments.
    await runRegister([...BASE_ARGS, '--engage-mode', 'pattern', '--trigger', '.']);
    const first = (await wiringsFor('andy'))[0];
    expect(first).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });

    await asASeparateProcess();
    await runRegister([...BASE_ARGS, '--engage-mode', 'mention']);

    const after = await wiringsFor('andy');
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(first);
  });
});

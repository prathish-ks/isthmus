/**
 * Coverage for setup/auto.ts — the ~2100-line non-interactive setup driver
 * (`pnpm run setup:auto`). This file exports NOTHING: every function is
 * module-private, and the module runs `main()` unconditionally at import
 * time (`main().catch(err => { ...; process.exit(1); })` at the bottom).
 * There is therefore no way to unit-test an individual step function in
 * isolation by importing it — the only test surface is driving `main()`
 * itself, end to end, through a fully mocked collaborator graph, and
 * observing side effects (mocked-prompt calls, emitted status, process.exit).
 *
 * Because `main()` is async and not awaitable from outside (nothing is
 * exported, and the dynamic `import()` promise resolves once the module's
 * synchronous top-level code finishes — not once `main()`'s internal
 * awaits settle), completion is detected by waiting (via `vi.waitFor`) for
 * a side effect that only happens at the end of the run under test: either
 * `process.exit` (every "fail path") or `p.outro` (the happy path, which
 * never calls process.exit on success).
 *
 * `NANOCLAW_SKIP` is the step-skip env var the driver itself reads — tests
 * lean on it heavily to keep each run's surface small and avoid needing to
 * mock the internals of steps not under test. `NANOCLAW_REEXEC_SG=1` skips
 * the opening "Standard setup / Advanced" prompt (real production behavior
 * for a resumed run) so tests don't need to script an extra prompt answer.
 * `NANOCLAW_BOOTSTRAPPED=1` skips `initProgressionLog()`'s two `git`
 * subprocess calls.
 *
 * Every collaborator module auto.ts imports is mocked at the module
 * boundary — see the block below. `child_process` is mocked defensively
 * (throwing/erroring) even though no test path here is expected to reach
 * it, so a future code-path change that does reach it fails loudly in CI
 * rather than silently shelling out for real.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── @clack/prompts ──────────────────────────────────────────────────────
const clack = vi.hoisted(() => ({
  log: { error: vi.fn(), message: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
  cancel: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(async () => true),
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
  isCancel: vi.fn(() => false),
}));
vi.mock('@clack/prompts', () => clack);

// ── setup/lib/runner.js (ensureAnswer/fail/runQuietStep/runQuietChild/spawnQuiet) ──
class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super(`exit ${code}`);
  }
}
const runner = vi.hoisted(() => ({
  stepResults: new Map<string, { ok: boolean; terminal?: { fields: Record<string, unknown> } }>(),
  failCalls: [] as Array<{ step: string; msg: string; hint?: string }>,
}));
vi.mock('./lib/runner.js', () => ({
  ensureAnswer: vi.fn(<T>(v: T) => v),
  fail: vi.fn(async (step: string, msg: string, hint?: string) => {
    runner.failCalls.push({ step, msg, hint });
    process.exit(1);
    throw new Error('unreachable'); // satisfies Promise<never> typing at call sites
  }),
  runQuietStep: vi.fn(async (name: string) => {
    const preset = runner.stepResults.get(name);
    return {
      ok: preset?.ok ?? true,
      terminal: preset?.terminal ?? { fields: {} },
      rawLog: `logs/${name}.log`,
      durationMs: 1,
    };
  }),
  runQuietChild: vi.fn(async () => ({ ok: true, rawLog: 'logs/x.log', durationMs: 1 })),
  spawnQuiet: vi.fn(async () => ({ ok: true })),
}));

// ── setup/lib/diagnostics.js (PostHog network emit) ─────────────────────
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));

// ── setup/logs.js (progression log) ──────────────────────────────────────
vi.mock('./logs.js', () => ({
  progressLogPath: '/dev/null',
  stepsDir: '/dev/null',
  completedStepNames: vi.fn(() => []),
  reset: vi.fn(),
  header: vi.fn(),
  step: vi.fn(),
  userInput: vi.fn(),
  complete: vi.fn(),
  abort: vi.fn(),
  stepRawLog: vi.fn((name: string) => `logs/setup-steps/${name}.log`),
}));

// ── child_process — defensive: no test path here should reach it ────────
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    throw new Error('unexpected real spawn() in setup/auto.coverage.test.ts');
  }),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '', error: new Error('blocked in test') })),
}));

// ── setup/lib/back-nav.js — left REAL (a plain sentinel constant, no IO) ─

// ── setup/channels/run-channel-skill.js ──────────────────────────────────
vi.mock('./channels/run-channel-skill.js', () => ({
  runChannelSkillWithPreStep: vi.fn(async () => undefined),
}));

// ── setup/lib/inherit-script.js ───────────────────────────────────────────
vi.mock('./lib/inherit-script.js', () => ({ runInheritScript: vi.fn(async () => 0) }));

// ── setup/lib/agent-ping.js ───────────────────────────────────────────────
vi.mock('./lib/agent-ping.js', () => ({
  PING_AGENT_FOLDER: 'ping_test',
  pingCliAgent: vi.fn(async () => 'ok'),
  classifyPingResult: vi.fn(() => 'ok'),
}));

// ── setup/providers/registry.js + install.js + index.js ─────────────────
const providers = vi.hoisted(() => ({
  getSetupProvider: vi.fn((_name: string) => undefined as unknown),
  listSetupProviders: vi.fn(() => [] as unknown[]),
}));
vi.mock('./providers/registry.js', () => providers);
vi.mock('./providers/install.js', () => ({ applyProviderSkill: vi.fn(async () => ({ blockers: [] })) }));
vi.mock('./providers/index.js', () => ({}));

// ── setup/lib/bright-select.js ────────────────────────────────────────────
const brightSelectState = vi.hoisted(() => ({
  answers: [] as unknown[],
}));
vi.mock('./lib/bright-select.js', () => ({
  brightSelect: vi.fn(async (opts: { initialValue?: unknown; options: Array<{ value: unknown }> }) => {
    if (brightSelectState.answers.length > 0) return brightSelectState.answers.shift();
    return opts.initialValue ?? opts.options[0]?.value;
  }),
  flushStdin: vi.fn(async () => {}),
}));

// ── setup/lib/container-build.js ──────────────────────────────────────────
vi.mock('./lib/container-build.js', () => ({ buildContainerImage: vi.fn(() => ({ ok: true })) }));

// ── setup/lib/claude-handoff.js ───────────────────────────────────────────
vi.mock('./lib/claude-handoff.js', () => ({
  offerClaudeOnFailure: vi.fn(async () => false),
  offerClaudeHandoff: vi.fn(async () => false),
  HELP_ESCAPE_SENTINEL: '__NANOCLAW_HELP_ESCAPE__',
  validateWithHelpEscape: vi.fn((v: unknown) => v),
  isHelpEscape: vi.fn(() => false),
}));

// ── setup/lib/picked-provider.js ──────────────────────────────────────────
vi.mock('./lib/picked-provider.js', () => ({
  setPickedProvider: vi.fn(),
  getPickedProvider: vi.fn(() => undefined),
}));

// ── setup/lib/registry-state.js ───────────────────────────────────────────
const registryState = vi.hoisted(() => ({
  imageSourceDecided: vi.fn(() => true),
  readImageSource: vi.fn(() => 'local' as 'local' | 'hardened'),
  writeImageSource: vi.fn(),
  readAgentImagePin: vi.fn((): string | undefined => undefined),
  loginScriptAvailable: vi.fn(() => false),
}));
vi.mock('./lib/registry-state.js', () => ({
  ...registryState,
  AGENT_IMAGE_PIN: 'agent-image',
  AGENT_IMAGE_REF_ENV_KEY: 'NANOCLAW_AGENT_IMAGE_REF',
  REGISTRY_LOGIN_SCRIPT: 'setup/registry-login.sh',
}));

// ── setup/set-env.js ───────────────────────────────────────────────────────
vi.mock('./set-env.js', () => ({ upsertEnvVar: vi.fn(() => ({ existed: false })) }));

// ── setup/lib/setup-config-parse.js — left REAL: this is the flag-parsing
// surface under direct test (pure, no IO beyond process.stdout.write in
// printHelp, which defaults its stream arg to process.stdout).

// ── setup/lib/setup-config-screen.js ─────────────────────────────────────
vi.mock('./lib/setup-config-screen.js', () => ({
  runAdvancedScreen: vi.fn(async (initial: unknown) => initial),
}));

// ── setup/lib/windowed-runner.js ──────────────────────────────────────────
const windowedRunner = vi.hoisted(() => ({
  stepResults: new Map<string, { ok: boolean; terminal?: { fields: Record<string, unknown> } }>(),
}));
vi.mock('./lib/windowed-runner.js', () => ({
  runWindowedStep: vi.fn(async (name: string) => {
    const preset = windowedRunner.stepResults.get(name);
    return {
      ok: preset?.ok ?? true,
      terminal: preset?.terminal ?? { fields: {} },
      rawLog: `logs/${name}.log`,
      durationMs: 1,
    };
  }),
}));

// ── setup/uninstall/flow.js + scan.js ─────────────────────────────────────
const uninstallState = vi.hoisted(() => ({
  runUninstallFlow: vi.fn(async () => {}),
  detectExistingInstall: vi.fn(() => false),
}));
vi.mock('./uninstall/flow.js', () => ({ runUninstallFlow: uninstallState.runUninstallFlow }));
vi.mock('./uninstall/scan.js', () => ({ detectExistingInstall: uninstallState.detectExistingInstall }));

// ── setup/environment.js ──────────────────────────────────────────────────
vi.mock('./environment.js', () => ({
  detectRegisteredGroups: vi.fn(async () => false),
  detectExistingDisplayName: vi.fn(async () => null),
  readEnvKey: vi.fn(() => null),
}));

// ── setup/onecli.js ────────────────────────────────────────────────────────
const onecliState = vi.hoisted(() => ({ healthy: true }));
vi.mock('./onecli.js', () => ({ pollHealth: vi.fn(async () => onecliState.healthy) }));

// ── setup/lib/tz-from-claude.js ───────────────────────────────────────────
vi.mock('./lib/tz-from-claude.js', () => ({
  claudeCliAvailable: vi.fn(() => false),
  resolveTimezoneViaClaude: vi.fn(async () => null),
}));

// ── src/cli/socket-client.js ──────────────────────────────────────────────
vi.mock('../src/cli/socket-client.js', () => ({
  SocketTransport: class {
    async sendFrame(): Promise<{ ok: boolean; data: unknown }> {
      return { ok: true, data: {} };
    }
  },
}));

// ── setup/templates.js ─────────────────────────────────────────────────────
vi.mock('./templates.js', () => ({
  applyTemplatePick: vi.fn(),
  clearTemplatePick: vi.fn(),
  cloneRegistry: vi.fn(async () => ({})),
  copyTemplate: vi.fn(async () => {}),
  installTemplateAgent: vi.fn(async () => ({})),
  listTemplateAgents: vi.fn(async () => []),
  listTemplatesFromDir: vi.fn(() => []),
  validateNewTemplateAgentName: vi.fn(() => null),
}));

// setup/lib/theme.js, setup/lib/back-nav.js, ../src/install-slug.js,
// ../src/timezone.js, ../src/config.js, `kleur` are all left REAL — pure,
// no IO, no network (theme's `note()` routes through the mocked `p.note`).

const origCwd = process.cwd();
const origExit = process.exit;
const origArgv = process.argv;
const origEnv = { ...process.env };
let tmpDir: string;
let projectDir: string;
let homeDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'auto-test-')));
  projectDir = path.join(tmpDir, 'project');
  homeDir = path.join(tmpDir, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  process.chdir(projectDir);
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NANOCLAW_')) delete process.env[key];
  }
  process.env.NANOCLAW_BOOTSTRAPPED = '1';

  runner.stepResults = new Map();
  runner.failCalls = [];
  windowedRunner.stepResults = new Map();
  brightSelectState.answers = [];
  providers.getSetupProvider.mockReset().mockReturnValue(undefined);
  providers.listSetupProviders.mockReset().mockReturnValue([]);
  registryState.imageSourceDecided.mockReset().mockReturnValue(true);
  registryState.readImageSource.mockReset().mockReturnValue('local');
  uninstallState.runUninstallFlow.mockReset().mockResolvedValue(undefined);
  uninstallState.detectExistingInstall.mockReset().mockReturnValue(false);
  clack.confirm.mockReset().mockResolvedValue(true);
  Object.values(clack.log).forEach((fn) => fn.mockClear());
  clack.cancel.mockClear();
  clack.intro.mockClear();
  clack.outro.mockClear();
  clack.note.mockClear();
  onecliState.healthy = true;

  vi.resetModules();
});

afterEach(() => {
  process.exit = origExit;
  process.argv = origArgv;
  process.chdir(origCwd);
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
  }
  Object.assign(process.env, origEnv);
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ALL_STEPS = [
  'environment',
  'container',
  'onecli',
  'auth',
  'mounts',
  'service',
  'cli-agent',
  'timezone',
  'channel',
  'verify',
  'first-chat',
];

/**
 * Import auto.ts (which runs `main()` immediately) and wait for a terminal
 * side effect: `process.exit` for any exit path, or `p.outro` for the
 * no-exit success path.
 */
async function runAuto(argv: string[], opts: { expectOutro?: boolean } = {}): Promise<{ exits: number[] }> {
  process.argv = ['node', 'setup/auto.ts', ...argv];
  const exits: number[] = [];
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    // Only the first exit throws (matching src/cli/client.coverage.test.ts's
    // convention): `main().catch(err => { ...; process.exit(1); })` at the
    // bottom of auto.ts calls process.exit a second time on any thrown
    // ExitSignal, and letting that one throw too would escape as an
    // unhandled rejection nothing in this test ever awaits.
    if (exits.length === 1) throw new ExitSignal(code ?? 0);
  }) as never;

  await import('./auto.js');

  if (opts.expectOutro) {
    await vi.waitFor(() => expect(clack.outro).toHaveBeenCalled(), { timeout: 2000 });
  } else {
    await vi.waitFor(() => expect(exits.length).toBeGreaterThan(0), { timeout: 2000 });
  }
  return { exits };
}

describe('auto — flag parsing (real setup-config-parse.js)', () => {
  it('--help prints usage and exits 0 without running any setup step', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { exits } = await runAuto(['--help']);
    expect(exits[0]).toBe(0);
    expect(writeSpy.mock.calls.some((c) => String(c[0]).includes('Usage: bash nanoclaw.sh'))).toBe(true);
    expect(clack.intro).not.toHaveBeenCalled();
  });

  it('an unrecognized flag value prints an error and exits 1', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { exits } = await runAuto(['--agent-provider']); // missing required value
    expect(exits[0]).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    expect(clack.intro).not.toHaveBeenCalled();
  });
});

describe('auto — full flow, everything skipped (happy path)', () => {
  it('completes with the plain "ready" outro when no channel was chosen and nothing failed', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.join(',');
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    expect(clack.intro).toHaveBeenCalledWith(expect.stringContaining('picking up where we left off'));
    expect(uninstallState.detectExistingInstall).not.toHaveBeenCalled(); // isResume bypasses it
    const outroMsg = String(clack.outro.mock.calls.at(-1)?.[0] ?? '');
    expect(outroMsg).toContain("You're ready");
  });

  it('--uninstall routes through runUninstallFlow first, then still completes the rest of the flow', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.join(',');
    const { exits } = await runAuto(['--uninstall', '--yes'], { expectOutro: true });
    expect(exits).toEqual([]);
    expect(uninstallState.runUninstallFlow).toHaveBeenCalledWith(
      expect.objectContaining({ invokedFrom: 'flag', yes: true }),
    );
  });
});

describe('auto — a single failing step aborts via fail()', () => {
  it('environment step failure calls fail("environment", ...) and exits 1', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'environment').join(',');
    runner.stepResults.set('environment', { ok: false });
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls).toHaveLength(1);
    expect(runner.failCalls[0].step).toBe('environment');
  });

  it('mounts step failure calls fail("mounts", ...) and exits 1', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'mounts').join(',');
    runner.stepResults.set('mounts', { ok: false });
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls[0]).toMatchObject({ step: 'mounts' });
  });

  it('service step failure calls fail("service", ...) and exits 1', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'service').join(',');
    runner.stepResults.set('service', { ok: false });
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls[0]).toMatchObject({ step: 'service' });
  });

  it('service step success with DOCKER_GROUP_STALE prints the setfacl hint (no failure)', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'service').join(',');
    runner.stepResults.set('service', { ok: true, terminal: { fields: { DOCKER_GROUP_STALE: 'true' } } });
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    expect(clack.log.warn).toHaveBeenCalled();
    expect(clack.log.message.mock.calls.some((c) => String(c[0]).includes('setfacl'))).toBe(true);
  });
});

describe('auto — container step error-code -> hint mapping', () => {
  const cases: Array<[string, string]> = [
    ['runtime_not_available', "Docker isn't available."],
    ['docker_group_not_active', 'Docker was just installed'],
    ['image_ref_not_configured', 'nothing says which one'],
    ['image_pull_failed', "Couldn't fetch the sandbox image."],
    ['something_else_entirely', "Couldn't build the sandbox."],
  ];
  for (const [errorCode, expectedSubstring] of cases) {
    it(`maps container ERROR="${errorCode}" to the right fail() message`, async () => {
      process.env.NANOCLAW_REEXEC_SG = '1';
      process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'container').join(',');
      windowedRunner.stepResults.set('container', { ok: false, terminal: { fields: { ERROR: errorCode } } });
      const { exits } = await runAuto([]);
      expect(exits[0]).toBe(1);
      expect(runner.failCalls[0].step).toBe('container');
      expect(runner.failCalls[0].msg).toContain(expectedSubstring);
    });
  }
});

describe('auto — verify step: soft failure does not call fail(), prints "What\'s left" and a yellow outro', async () => {
  it('reports unresolved issues without aborting via fail()', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'verify').join(',');
    runner.stepResults.set('verify', {
      ok: false,
      terminal: { fields: { CREDENTIALS: 'missing', SERVICE: 'stopped', CONFIGURED_CHANNELS: '' } },
    });
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    expect(runner.failCalls).toHaveLength(0); // soft failure, not fail()
    expect(
      clack.note.mock.calls.some(
        (c) => String(c[0]).includes("Claude account isn't connected") && c[1] === "What's left",
      ),
    ).toBe(true);
    const outroMsg = String(clack.outro.mock.calls.at(-1)?.[0] ?? '');
    expect(outroMsg).toContain('Almost there');
  });

  it('a successful verify with WIRING pending_first_dm changes the final message to "one DM to go"', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'verify').join(',');
    runner.stepResults.set('verify', { ok: true, terminal: { fields: { WIRING: 'pending_first_dm' } } });
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    const outroMsg = String(clack.outro.mock.calls.at(-1)?.[0] ?? '');
    expect(outroMsg).toContain('one DM to go');
  });
});

describe('auto — onecli step', () => {
  it('remote host (advanced override) reachable: connects and reports success', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'onecli').join(',');
    process.env.NANOCLAW_ONECLI_API_HOST = 'http://remote.example.com:10254';
    onecliState.healthy = true;
    runner.stepResults.set('onecli', { ok: true });
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
  });

  it('remote host (advanced override) unreachable: fails the step', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'onecli').join(',');
    process.env.NANOCLAW_ONECLI_API_HOST = 'http://remote.example.com:10254';
    onecliState.healthy = false;
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls[0]).toMatchObject({ step: 'onecli' });
    expect(runner.failCalls[0].msg).toContain("Couldn't reach OneCLI");
  });

  it('remote connection step itself failing (onecli step reports not ok) also fails', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'onecli').join(',');
    process.env.NANOCLAW_ONECLI_API_HOST = 'http://remote.example.com:10254';
    onecliState.healthy = true;
    runner.stepResults.set('onecli', { ok: false, terminal: { fields: { ERROR: 'install_failed' } } });
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls[0].msg).toContain('install_failed');
  });

  it('no remote host override and no existing onecli on PATH: installs fresh (no --reuse flag)', async () => {
    // detectExistingOnecli() shells out to the real `onecli` binary via the
    // module's own (mocked, always-failing) spawnSync — so it reports "not
    // found" here and the step runs with no extra args.
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'onecli').join(',');
    runner.stepResults.set('onecli', { ok: true });
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
  });

  it('onecli install failure surfaces the onecli_not_on_path_after_install hint', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'onecli').join(',');
    runner.stepResults.set('onecli', {
      ok: false,
      terminal: { fields: { ERROR: 'onecli_not_on_path_after_install' } },
    });
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls[0].msg).toContain('needs to refresh');
  });
});

describe('auto — timezone step', () => {
  it('a specific detected zone, confirmed by the user, is accepted without prompting further', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'timezone').join(',');
    runner.stepResults.set('timezone', { ok: true, terminal: { fields: { RESOLVED_TZ: 'America/New_York' } } });
    clack.confirm.mockResolvedValue(true);
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    expect(clack.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('America/New_York') }),
    );
  });

  it('a step failure with no NEEDS_USER_INPUT flag fails via fail("timezone", ...)', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'timezone').join(',');
    runner.stepResults.set('timezone', { ok: false, terminal: { fields: {} } });
    const { exits } = await runAuto([]);
    expect(exits[0]).toBe(1);
    expect(runner.failCalls[0]).toMatchObject({ step: 'timezone' });
  });
});

describe('auto — channel step', () => {
  it('choosing telegram routes through runChannelSkillWithPreStep("telegram", ...)', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'channel').join(',');
    process.env.NANOCLAW_DISPLAY_NAME = 'Operator';
    brightSelectState.answers = ['telegram'];
    const { runChannelSkillWithPreStep } = await import('./channels/run-channel-skill.js');
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    expect(runChannelSkillWithPreStep).toHaveBeenCalledWith('telegram', 'Operator', { offerBack: true });
    const outroMsg = String(clack.outro.mock.calls.at(-1)?.[0] ?? '');
    expect(outroMsg).toContain("You're set");
  });

  it('the default "skip" choice reaches the plain "ready" outro (no DM banner)', async () => {
    process.env.NANOCLAW_REEXEC_SG = '1';
    process.env.NANOCLAW_SKIP = ALL_STEPS.filter((s) => s !== 'channel').join(',');
    brightSelectState.answers = ['skip'];
    const { exits } = await runAuto([], { expectOutro: true });
    expect(exits).toEqual([]);
    const outroMsg = String(clack.outro.mock.calls.at(-1)?.[0] ?? '');
    expect(outroMsg).toContain("You're ready");
  });
});

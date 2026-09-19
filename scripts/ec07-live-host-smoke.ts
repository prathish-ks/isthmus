/**
 * EC-07: the live-Docker leg, with the TypeScript host in front of it.
 *
 * EC-06 (`scripts/ec06-live-smoke.sh`, ADR-019) proved the kernel half live:
 * a real `nanogo serve`, a real Docker daemon, a real agent-runner image, a
 * real round trip — driven by a shell harness that spoke the NDJSON wire
 * protocol itself. Its own header states the boundary it stopped at: "a real
 * Slack/Discord/CLI channel adapter round trip ... is TypeScript-host
 * routing/channel infrastructure this proof's scope deliberately does not
 * touch."
 *
 * PR #10 (`src/cli-channel-kernel-smoke.test.ts`, ADR-022) proved the host
 * half, on every PR, with no daemon: a line typed at the CLI socket becomes a
 * `messages_in` row, a composed spec, and a real NDJSON `container.wake` — to
 * a fake kernel, with a `FakeCli` standing in for docker. Its own header
 * states the boundary it stopped at: "No container is created, no
 * agent-runner image runs, no provider replies."
 *
 * This is the join. Nothing here is faked. A line typed at the real CLI
 * adapter's real Unix socket routes through the real router, resolves a real
 * session, wakes a real container through the real `KernelClient` → real
 * `nanogo serve` → real Docker daemon, and the reply the real agent-runner
 * writes into `outbound.db` comes back out of the same CLI socket through the
 * real delivery poll. The one substitution is the agent itself: a
 * deterministic provider (`container/agent-runner/src/providers/livesmoke.ts`)
 * instead of a real model, for the same reason EC-06 used one — a
 * non-deterministic reply cannot be asserted on, and P3-04 already proved
 * real-Claude interop once, manually.
 *
 * Deliberately NOT a vitest test. This needs `DATA_DIR`/`GROUPS_DIR` to be the
 * checkout's own `data/` and `groups/` — the kernel's policy roots are derived
 * from the same paths, through `nanogo serve -config`, and a mocked
 * `config.js` would put the host and the kernel in different worlds. It also
 * needs minutes, a daemon and an image, none of which belong in the `test`
 * job. Same posture as `ec06-live-smoke.sh`: a harness you run, and a
 * report-only CI job that runs it for you.
 *
 * Usage (see also the wrapper, which does the preflight and the provider
 * install for you):
 *   scripts/ec07-live-host-smoke.sh [repeats]
 *   pnpm exec tsx scripts/ec07-live-host-smoke.ts [repeats]
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import type { ChannelAdapter, ChannelSetup } from '../src/channels/adapter.js';
// Side-effect import: registers the `cli` adapter into the channel registry.
import '../src/channels/index.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  teardownChannelAdapters,
} from '../src/channels/channel-registry.js';
import { CENTRAL_DB_PATH, CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, INSTALL_SLUG } from '../src/config.js';
import { adoptRunningSessions, killContainer } from '../src/container-runner.js';
import { ensureContainerConfig } from '../src/db/container-configs.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initDb,
  runMigrations,
} from '../src/db/index.js';
import { findSessionForAgent } from '../src/db/sessions.js';
import { setDeliveryAdapter, startActiveDeliveryPoll, stopDeliveryPolls } from '../src/delivery.js';
import { getSessionDriver } from '../src/drivers/index.js';
import { registerGatewayProvider } from '../src/gateway-providers/index.js';
import { startHostModules, stopHostModules } from '../src/host-lifecycle.js';
// Side-effect import: the modules barrel, exactly as `src/index.ts` imports
// it. Not a nicety — `src/mailbox/compose.ts` is the singular mailbox
// composition slot, and it is reached ONLY through this barrel. Without it,
// `getAgentMailbox()` throws "No agent mailbox registered" the first time
// the router tries to create a session, which is exactly how this harness's
// first live run failed: the host came up, the kernel came up, the CLI
// socket took the line, and the session could never be written.
//
// The lesson generalizes, and is why this is the barrel rather than the one
// module that would have fixed it: this harness's whole claim is "the real
// host in front", so it runs the host's own imports rather than the subset
// that looks sufficient.
import '../src/modules/index.js';
// Direct core import, same as `src/index.ts` — the supervisor is a default,
// always-on module, deliberately not routed through the barrel above.
// `startHostModules` is what then spawns the real `nanogo serve`.
import { locateNanogoBinary } from '../src/modules/kernel-supervisor/index.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { routeInbound } from '../src/router.js';

/**
 * Must equal `EC07_DETERMINISTIC_REPLY` in
 * `container/agent-runner/src/providers/livesmoke.ts`. Not imported from
 * there: that module runs under Bun inside the container and imports the
 * agent-runner's own registry at load, which this Node process has no
 * business pulling in. Two copies of one string, with the mismatch reported
 * as a diff rather than a timeout.
 */
const EXPECTED_REPLY = 'ec07: deterministic reply from the live-smoke provider';

const AGENT_GROUP_ID = 'ag-ec07-livesmoke';
const GROUP_FOLDER = 'ec07-livesmoke';
const MESSAGING_GROUP_ID = 'mg-ec07-livesmoke';
const PROVIDER = 'livesmoke';
const BARREL = path.join('container', 'agent-runner', 'src', 'providers', 'index.ts');

const REPEATS = Number(process.argv[2] || process.env.EC07_REPEATS || 2);
/**
 * Generous by default and adjustable, because the first wake on a cold
 * machine pays for the image's own startup (bun, the poll loop, skill
 * discovery) before the provider is ever called. EC-06 polled for 30s against
 * an already-warm image; this one has the host's spawn path in front of it
 * too.
 */
const REPLY_TIMEOUT_MS = Number(process.env.EC07_REPLY_TIMEOUT_MS || 180_000);

function now(): string {
  return new Date().toISOString();
}

function say(line: string): void {
  process.stdout.write(line + '\n');
}

/**
 * `stdio` is explicit because `execFileSync` inherits stderr by default, and
 * two of the calls below are *expected* to fail — the preflight's `image
 * inspect`, and the `inspect` that confirms a container is gone after the
 * kill. Inheriting meant a passing run printed "Error: No such object:
 * ncl-..." immediately before "confirmed: ... is gone", which reads like a
 * failure in a proof whose whole job is to be read.
 */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Fail with an operator-readable reason rather than a stack from deep inside a module. */
function refuse(reason: string, fix: string): never {
  process.stderr.write(`error: ${reason}\n${fix}\n`);
  process.exit(1);
}

function preflight(): void {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    refuse('no reachable Docker daemon', 'Start Docker (Desktop, or the daemon) and re-run.');
  }

  try {
    docker(['image', 'inspect', CONTAINER_IMAGE, '--format', '{{.Id}}']);
  } catch {
    refuse(
      `the agent image ${CONTAINER_IMAGE} is not present`,
      'Build it first: ./container/build.sh   (the tag is derived from this checkout\'s path, so it is this checkout\'s own image)',
    );
  }

  if (!locateNanogoBinary()) {
    refuse(
      'the nanogo binary was not found',
      'Build it: (cd go-host && go build -mod=vendor -o bin/nanogo ./cmd/nanogo)   — or set NANOCLAW_NANOGO_BIN.',
    );
  }

  // The provider only exists inside the container if the barrel imports it.
  // Checked here so the failure is this sentence rather than "Unknown
  // provider: livesmoke" in a container log that `--rm` may already have
  // taken away.
  const barrel = fs.existsSync(BARREL) ? fs.readFileSync(BARREL, 'utf8') : '';
  if (!barrel.includes(`./${PROVIDER}.js`)) {
    refuse(
      `the agent-runner provider barrel does not import ./${PROVIDER}.js`,
      `Run the wrapper instead — scripts/ec07-live-host-smoke.sh installs it for the run and removes it afterwards.`,
    );
  }

  // Never run against a real install's central DB. This harness creates its
  // own agent group, messaging group and wiring; pointing it at a live
  // `data/v2.db` would write them into someone's actual install.
  if (fs.existsSync(CENTRAL_DB_PATH) && process.env.EC07_FORCE !== '1') {
    refuse(
      `${CENTRAL_DB_PATH} already exists — this looks like a real install`,
      'This harness seeds its own central DB and will not share one. Run it from a checkout with no install, or set EC07_FORCE=1 if you are certain.',
    );
  }
}

/** `src/index.ts` step 3, verbatim in shape. */
function hostSetup(adapter: ChannelAdapter): ChannelSetup {
  return {
    onInbound(platformId, threadId, message) {
      void routeInbound({
        channelType: adapter.channelType,
        instance: adapter.instance ?? adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      });
    },
    onInboundEvent(event) {
      void routeInbound(event);
    },
    onMetadata() {},
    onAction() {},
  };
}

/**
 * The live containers this install currently has, by name, with the host's
 * own predicted name read back off each one's label.
 *
 * `nanoclaw-install=<slug>` is the canonical per-install label, so this never
 * sees a peer checkout's containers. The NAME is the kernel's
 * (`ContainerName(spec.Key)`, `internal/kernel/naming.go`); the
 * `nanoclaw-container-name` LABEL is the host's own `nanoclaw-v2-...` guess,
 * which rides the wire for supervision bookkeeping. EC-02's property is that
 * the first is not the second — asserted below against a real container
 * rather than, as in ADR-022's in-process test, against a fake kernel that
 * was told what to answer.
 */
function liveContainers(): Array<{ name: string; hostPredicted: string }> {
  const out = docker([
    'ps',
    '--filter',
    `label=nanoclaw-install=${INSTALL_SLUG}`,
    // Both canonical adoption labels, not just the install one: a checkout
    // that has other groups running must not lend this proof a container it
    // did not cause. `nanoclaw-group` is the agent group id
    // (internal/kernel/naming.go's LabelsForKey).
    '--filter',
    `label=nanoclaw-group=${AGENT_GROUP_ID}`,
    '--format',
    '{{.Names}}\t{{.Label "nanoclaw-container-name"}}',
  ]);
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name, hostPredicted] = line.split('\t');
      return { name, hostPredicted: hostPredicted ?? '' };
    });
}

function containerExists(name: string): boolean {
  try {
    docker(['inspect', name, '--format', '{{.Id}}']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The host routes inbound messages on a floating promise
 * (`void routeInbound(...)` — `src/index.ts` does the same, with a `.catch`
 * that only logs). So a routing failure never reaches the code that is
 * waiting for a container; it surfaces as an unhandled rejection and the
 * wait then burns its whole budget on something that already failed.
 *
 * That is not hypothetical: this harness's first live run spent 120 seconds
 * per repeat waiting for a container that could not exist, with the real
 * reason four milliseconds old and four lines up the log. Every wait below
 * checks this first, so the run fails with the host's own error.
 */
let hostFailure: Error | null = null;
process.on('unhandledRejection', (reason) => {
  hostFailure ??= reason instanceof Error ? reason : new Error(String(reason));
});

async function until<T>(what: string, probe: () => T | undefined, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hostFailure) {
      throw new Error(`the host failed while waiting for ${what}: ${hostFailure.message}`, { cause: hostFailure });
    }
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** What the previous repeat saw, for the cross-run naming assertion below. */
let previous: { sessionId: string; kernelName: string; hostPredicted: string } | null = null;

/** One round trip: type a line at the socket, read the reply off the same socket. */
async function oneRun(run: number): Promise<void> {
  say(`---- run ${run}/${REPEATS} ----`);
  // Each repeat is an independent attempt, so a previous run's host failure
  // must not decide this one.
  hostFailure = null;
  const replies: string[] = [];
  const client = net.connect(path.join(DATA_DIR, 'cli.sock'));
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('connect', () => resolve());
      client.once('error', reject);
    });
    client.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) replies.push(line.trim());
      }
    });

    client.write(JSON.stringify({ text: `ec07 live host smoke, run ${run}` }) + '\n');
    say('-- line written to the CLI socket; waiting for a real container to answer --');

    // A container has to exist before a reply can come from one. Captured
    // here, while it is still running: `container.kill` is stop+rm, and the
    // spec carries `--rm`, so after the kill there is nothing left to inspect.
    const container = await until('a live agent container', () => liveContainers()[0], 120_000);
    say(`kernel-derived container name : ${container.name}`);
    say(`host's predicted name (label) : ${container.hostPredicted}`);

    // `ncl-<installSlug>-<sessionId>` is the kernel's own scheme
    // (internal/kernel/naming.go, ContainerName); `nanoclaw-v2-<folder>-<ms>`
    // is the host's. Asserting the shape of each, and then that the two
    // strings differ, is what makes this more than "two strings are not
    // equal": it says which side produced the name the daemon actually holds.
    if (!container.name.startsWith('ncl-')) {
      throw new Error(
        `the live container's name '${container.name}' is not a kernel-derived ncl-* name — ` +
          'something other than internal/kernel/naming.go named this container',
      );
    }
    if (!container.hostPredicted.startsWith('nanoclaw-v2-')) {
      throw new Error(
        `the host's predicted name should be a nanoclaw-v2-* name, got '${container.hostPredicted}' — ` +
          'either composeSessionSpec stopped labelling, or this container is not ours',
      );
    }
    if (container.name === container.hostPredicted) {
      throw new Error(
        `the live container wears the name the HOST computed ('${container.name}') — EC-02's ` +
          'guarantee is that the kernel derives it (internal/kernel/naming.go, ContainerName(spec.Key)) ' +
          'and the host never gets to choose',
      );
    }

    // The sharper form of the same property, available only because the
    // repeats share one session (`session_mode: 'shared'`, so run 2 wakes the
    // session run 1 created rather than a new one).
    //
    // The host's predicted name carries `Date.now()`, so it is necessarily
    // different on every wake. The kernel's is `ContainerName(spec.Key)` — a
    // pure function of the session key — so it is necessarily the SAME. Two
    // wakes of one session therefore produce one stable kernel name and two
    // different host names, which is a much harder thing to satisfy by
    // accident than "these two strings differ": a host that had smuggled its
    // own name through would show the container's name changing between
    // wakes, and this catches that even if the shapes above still looked
    // right. Observed for real on the first green run.
    const session = await findSessionForAgent(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null);
    if (!session) throw new Error('a container is running but there is no session row for this group');

    if (previous && previous.sessionId === session.id) {
      if (previous.kernelName !== container.name) {
        throw new Error(
          `the same session was woken twice but the container's name changed ` +
            `('${previous.kernelName}' then '${container.name}') — a key-derived name cannot do that, ` +
            'so the name is coming from somewhere other than ContainerName(spec.Key)',
        );
      }
      if (previous.hostPredicted === container.hostPredicted) {
        throw new Error(
          `the host predicted the same name '${container.hostPredicted}' for two separate wakes — ` +
            'it is supposed to carry Date.now(), so this assertion is no longer testing what it thinks',
        );
      }
      say('confirmed: one session, two wakes — kernel name stable, host name different each time');
    }
    previous = { sessionId: session.id, kernelName: container.name, hostPredicted: container.hostPredicted };

    const reply = await until(
      `the deterministic reply on the CLI socket`,
      () => replies.find((line) => line.includes(EXPECTED_REPLY)),
      REPLY_TIMEOUT_MS,
    );
    say(`reply: ${reply}`);

    // The container is torn down through the same kernel, not `docker rm`.
    // No `onExit` callback and no await on one: `killContainer` returns
    // silently when the session is not in its registry, so a promise wrapped
    // around that callback would hang forever in exactly the case worth
    // reporting. The daemon is the source of truth here — poll it.
    killContainer(session.id, 'ec07 live smoke cleanup');
    await until(
      'the container to disappear after the kernel-mediated kill',
      () => (containerExists(container.name) ? undefined : true),
      30_000,
    );
    say(`confirmed: ${container.name} is gone after a kernel-mediated kill`);
    say(`== run ${run} passed ==\n`);
  } finally {
    client.destroy();
  }
}

async function main(): Promise<void> {
  say('== EC-07: kernel-mediated live smoke, with the TypeScript host in front ==');
  say(`image        : ${CONTAINER_IMAGE}`);
  say(`install slug : ${INSTALL_SLUG}`);
  say(`data dir     : ${DATA_DIR}`);
  say(`expecting    : ${EXPECTED_REPLY}`);
  say('');

  preflight();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });

  // A gateway that contributes nothing, registered through the registry's own
  // overlay mechanism rather than the `resetGatewayProvider` test seam — this
  // harness is not a test, and the spawn path should see an ordinary
  // registered provider.
  //
  // Selected here rather than left to the default. The gateway kind is read
  // lazily, on the first spawn, so setting the variable this late is in time —
  // and it has to be set, because the shipped `onecli` gateway THROWS
  // ("refusing to spawn container without credentials") on a machine with no
  // OneCLI vault, which is every CI runner, while on a machine that HAS one it
  // would reach into the operator's real vault to create an agent for this
  // throwaway group. Neither is what this proof is about. An operator who
  // wants the real gateway in the path exports NANOCLAW_GATEWAY_PROVIDER.
  registerGatewayProvider('none', () => ({
    kind: 'none',
    contribute: async () => ({ env: {}, mounts: [] }),
  }));
  process.env.NANOCLAW_GATEWAY_PROVIDER = process.env.NANOCLAW_GATEWAY_PROVIDER || 'none';

  // 1. Central DB — the real one, in this checkout's own data/.
  const db = await initDb(CENTRAL_DB_PATH, { role: 'host' });
  await runMigrations(db, undefined, { mode: 'auto' });

  // Exactly what scripts/init-cli-agent.ts seeds for a CLI-wired agent, with
  // the provider pinned to the deterministic one.
  //
  // The synthetic `cli:local` user included: init-cli-agent.ts upserts it
  // (no owner grant — it is a scratch identity, not the operator), and with
  // the permissions module loaded through the barrel above, seeding the same
  // row is what keeps this a known sender rather than leaning on the
  // messaging group's `public` policy to rescue an unknown one.
  await upsertUser({
    id: 'cli:local',
    kind: 'cli',
    display_name: 'EC-07 operator',
    created_at: now(),
  });
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'EC-07 Live Smoke',
    folder: GROUP_FOLDER,
    agent_provider: PROVIDER,
    created_at: now(),
  });
  await ensureContainerConfig(AGENT_GROUP_ID, PROVIDER);
  await createMessagingGroup({
    id: MESSAGING_GROUP_ID,
    channel_type: 'cli',
    platform_id: 'local',
    name: 'Terminal',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-ec07-livesmoke',
    messaging_group_id: MESSAGING_GROUP_ID,
    agent_group_id: AGENT_GROUP_ID,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // 2-7. The host's own startup, in its own order (src/index.ts).
  await getSessionDriver().ensureReady?.();
  await adoptRunningSessions();
  await initChannelAdapters(hostSetup);
  setDeliveryAdapter(createChannelDeliveryAdapter());
  const aborter = new AbortController();
  await startHostModules({ db, signal: aborter.signal });
  startActiveDeliveryPoll();
  say('host is up (cli adapter listening, nanogo serve supervised, delivery polling)\n');

  let failures = 0;
  try {
    for (let run = 1; run <= REPEATS; run++) {
      try {
        await oneRun(run);
      } catch (err) {
        failures++;
        process.stderr.write(`== run ${run} FAILED: ${err instanceof Error ? err.message : String(err)} ==\n`);
      }
    }
  } finally {
    aborter.abort();
    stopDeliveryPolls();
    await stopHostModules();
    await teardownChannelAdapters();
    await closeDb();
  }

  say(`== summary: ${REPEATS - failures}/${REPEATS} run(s) passed, fully kernel-mediated, host in front ==`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

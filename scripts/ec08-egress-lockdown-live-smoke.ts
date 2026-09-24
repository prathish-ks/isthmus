/**
 * EC-08: egress lockdown's real network attachment, live.
 *
 * ADR-024 and ADR-025 (go-host/docs/) fixed a real, silent regression:
 * NANOCLAW_EGRESS_LOCKDOWN=true stopped attaching agent containers to the
 * isolated network after EC-02 moved container creation behind the Go
 * kernel — the network still got created (host-sweep.ts's periodic
 * ensureEgressNetwork() call), so it looked active while doing nothing.
 * Nothing in CI caught it. EC-07 (`scripts/ec07-live-host-smoke.ts`) proves
 * the kernel-mediated round trip is real; it never enables lockdown and
 * asserts nothing about network attachment. This is the proof that gap
 * needed: with lockdown genuinely on, does the container the kernel
 * actually creates land on the isolated, --internal network — not just
 * "does a network with the right name exist somewhere."
 *
 * Deliberately its own script, not a mode flag on ec07: this proves one
 * property end to end, the same way each EC-0N proof does, and reuses
 * ec07's own building blocks (the docker() wrapper, preflight shape, the
 * deterministic livesmoke provider, the host-setup sequence) rather than
 * importing from it — EC-06 and EC-07 don't share code either, and a
 * proof whose whole job is to be read shouldn't require following an
 * import to know what it actually does.
 *
 * What's real: the host, the kernel, the Docker daemon, the agent image,
 * the egress network, the network attachment this inspects. What's
 * substituted, and why: the deterministic livesmoke provider (same reason
 * EC-07 uses it — a non-deterministic reply can't be asserted on), the
 * gateway PROVIDER's own credential contribution (registered as `none`,
 * same as EC-07 — this proof is about network topology, not OneCLI's
 * credential flow), and the OneCLI gateway CONTAINER itself, which this
 * harness creates as a minimal stand-in (a real container that exists and
 * can be attached to the network) rather than requiring a real OneCLI
 * vault on every CI runner. ensureEgressNetwork() only needs a container
 * with the right name to attach to the network — it has no opinion on
 * what's running inside it.
 *
 * Usage (see also the wrapper, which does the preflight, the provider
 * install, and the stand-in gateway container for you):
 *   scripts/ec08-egress-lockdown-live-smoke.sh
 *   pnpm exec tsx scripts/ec08-egress-lockdown-live-smoke.ts
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
import {
  CENTRAL_DB_PATH,
  CONTAINER_IMAGE,
  DATA_DIR,
  EGRESS_NETWORK,
  GROUPS_DIR,
  INSTALL_SLUG,
  ONECLI_GATEWAY_CONTAINER,
} from '../src/config.js';
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
// it — see ec07-live-host-smoke.ts's own header for why this is the barrel
// and not the one module ("getAgentMailbox() throws") that looks sufficient.
import '../src/modules/index.js';
// Direct core import, same as `src/index.ts` — the supervisor is a default,
// always-on module. This is what spawns the real `nanogo serve`, which is
// what this proof is actually about: does it get the right -docker-network.
import { locateNanogoBinary } from '../src/modules/kernel-supervisor/index.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { routeInbound } from '../src/router.js';

/** Must equal EC07_DETERMINISTIC_REPLY in the shared livesmoke provider. */
const EXPECTED_REPLY = 'ec07: deterministic reply from the live-smoke provider';

const AGENT_GROUP_ID = 'ag-ec08-egress-lockdown';
const GROUP_FOLDER = 'ec08-egress-lockdown';
const MESSAGING_GROUP_ID = 'mg-ec08-egress-lockdown';
const PROVIDER = 'livesmoke';
const BARREL = path.join('container', 'agent-runner', 'src', 'providers', 'index.ts');
const REPLY_TIMEOUT_MS = Number(process.env.EC08_REPLY_TIMEOUT_MS || 180_000);

function now(): string {
  return new Date().toISOString();
}

function say(line: string): void {
  process.stdout.write(line + '\n');
}

/** Same stdio shape as ec07-live-host-smoke.ts's docker() — see its own comment for why. */
function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

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
      "Build it first: ./container/build.sh   (the tag is derived from this checkout's path, so it is this checkout's own image)",
    );
  }

  if (!locateNanogoBinary()) {
    refuse(
      'the nanogo binary was not found',
      'Build it: (cd go-host && go build -mod=vendor -o bin/nanogo ./cmd/nanogo)   — or set NANOCLAW_NANOGO_BIN.',
    );
  }

  const barrel = fs.existsSync(BARREL) ? fs.readFileSync(BARREL, 'utf8') : '';
  if (!barrel.includes(`./${PROVIDER}.js`)) {
    refuse(
      `the agent-runner provider barrel does not import ./${PROVIDER}.js`,
      'Run the wrapper instead — scripts/ec08-egress-lockdown-live-smoke.sh installs it for the run and removes it afterwards.',
    );
  }

  if (fs.existsSync(CENTRAL_DB_PATH) && process.env.EC08_FORCE !== '1') {
    refuse(
      `${CENTRAL_DB_PATH} already exists — this looks like a real install`,
      'This harness seeds its own central DB and will not share one. Run it from a checkout with no install, or set EC08_FORCE=1 if you are certain.',
    );
  }

  if (process.env.NANOCLAW_EGRESS_LOCKDOWN !== 'true') {
    refuse(
      'NANOCLAW_EGRESS_LOCKDOWN is not "true"',
      'This proof only means something with lockdown actually on. Run the wrapper, which sets it, or export NANOCLAW_EGRESS_LOCKDOWN=true yourself.',
    );
  }

  // The stand-in gateway container the wrapper creates — checked here so a
  // wrapper bug surfaces as this sentence, not as ensureEgressNetwork's own
  // EgressLockdownError three layers of stack trace later.
  try {
    docker(['inspect', ONECLI_GATEWAY_CONTAINER, '--format', '{{.State.Running}}']);
  } catch {
    refuse(
      `no running container named "${ONECLI_GATEWAY_CONTAINER}"`,
      'Run the wrapper instead — it creates the stand-in gateway container ensureEgressNetwork() attaches to.',
    );
  }
}

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

function liveContainers(): Array<{ name: string }> {
  const out = docker([
    'ps',
    '--filter',
    `label=nanoclaw-install=${INSTALL_SLUG}`,
    '--filter',
    `label=nanoclaw-group=${AGENT_GROUP_ID}`,
    '--format',
    '{{.Names}}',
  ]);
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((name) => ({ name }));
}

function containerExists(name: string): boolean {
  try {
    docker(['inspect', name, '--format', '{{.Id}}']);
    return true;
  } catch {
    return false;
  }
}

/** See ec07-live-host-smoke.ts's own comment on the identical pattern for why this exists. */
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

/**
 * The actual assertion this whole proof exists for. Two independent checks,
 * because each rules out a different way this could look fine and not be:
 *
 *   1. The container's OWN network list must be EXACTLY { EGRESS_NETWORK }
 *      — not the default bridge, not both (a container can be attached to
 *      more than one Docker network at once, so "is attached to
 *      EGRESS_NETWORK" alone would pass even if it ALSO kept a route out
 *      through the default bridge).
 *   2. EGRESS_NETWORK itself must actually be --internal — otherwise a
 *      network with the right name but the wrong flag would satisfy check
 *      1 while providing no isolation at all, which is exactly the shape
 *      of bug this proof is guarding against (a real-looking thing,
 *      silently not doing its job).
 */
function assertNetworkIsolation(containerName: string): void {
  const networksJson = docker(['inspect', containerName, '--format', '{{json .NetworkSettings.Networks}}']);
  const networks = JSON.parse(networksJson) as Record<string, unknown>;
  const names = Object.keys(networks);
  if (names.length !== 1 || names[0] !== EGRESS_NETWORK) {
    throw new Error(
      `container ${containerName} is attached to [${names.join(', ')}], expected exactly ["${EGRESS_NETWORK}"] — ` +
        'egress lockdown is on but this container is not correctly isolated',
    );
  }
  say(`confirmed: ${containerName} is attached to exactly ["${EGRESS_NETWORK}"], nothing else`);

  const isInternal = docker(['network', 'inspect', EGRESS_NETWORK, '--format', '{{.Internal}}']);
  if (isInternal !== 'true') {
    throw new Error(
      `network "${EGRESS_NETWORK}" has Internal=${isInternal}, expected true — a network with the right ` +
        'name but no --internal flag provides no isolation at all',
    );
  }
  say(`confirmed: network "${EGRESS_NETWORK}" is --internal (no default route out)`);
}

async function main(): Promise<void> {
  say('== EC-08: egress-lockdown network isolation, live ==');
  say(`image           : ${CONTAINER_IMAGE}`);
  say(`install slug    : ${INSTALL_SLUG}`);
  say(`egress network  : ${EGRESS_NETWORK}`);
  say(`gateway (stub)  : ${ONECLI_GATEWAY_CONTAINER}`);
  say('');

  preflight();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });

  // Same substitution ec07 makes, same reason: the shipped `onecli` gateway
  // throws without a real vault, which every CI runner lacks. This proof is
  // about network topology, not credential injection — a no-op gateway
  // provider doesn't change what network the container lands on.
  registerGatewayProvider('none', () => ({
    kind: 'none',
    contribute: async () => ({ env: {}, mounts: [] }),
  }));
  process.env.NANOCLAW_GATEWAY_PROVIDER = process.env.NANOCLAW_GATEWAY_PROVIDER || 'none';

  const db = await initDb(CENTRAL_DB_PATH, { role: 'host' });
  await runMigrations(db, undefined, { mode: 'auto' });

  await upsertUser({
    id: 'cli:local',
    kind: 'cli',
    display_name: 'EC-08 operator',
    created_at: now(),
  });
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'EC-08 Egress Lockdown',
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
    id: 'mga-ec08-egress-lockdown',
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

  await getSessionDriver().ensureReady?.();
  await adoptRunningSessions();
  await initChannelAdapters(hostSetup);
  setDeliveryAdapter(createChannelDeliveryAdapter());
  const aborter = new AbortController();
  // The real proof: startHostModules is what spawns the real nanogo serve,
  // through kernel-supervisor/index.ts, with NANOCLAW_EGRESS_LOCKDOWN=true
  // in this process's own environment. If ADR-024/ADR-025's fixes ever
  // regress, this either fails to start (ADR-025's own kernel-side refusal,
  // in which case the whole harness fails loudly here) or starts but wires
  // the wrong network (caught below, not here).
  await startHostModules({ db, signal: aborter.signal });
  startActiveDeliveryPoll();
  say('host is up, kernel started with egress lockdown on\n');

  let failed = false;
  try {
    const client = net.connect(path.join(DATA_DIR, 'cli.sock'));
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      const replies: string[] = [];
      client.on('data', (chunk) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim()) replies.push(line.trim());
        }
      });

      client.write(JSON.stringify({ text: 'ec08 egress lockdown live smoke' }) + '\n');
      say('-- line written to the CLI socket; waiting for a real, lockdown-isolated container --');

      const container = await until('a live agent container', () => liveContainers()[0], 120_000);
      say(`container: ${container.name}`);

      assertNetworkIsolation(container.name);

      const reply = await until(
        'the deterministic reply on the CLI socket',
        () => replies.find((line) => line.includes(EXPECTED_REPLY)),
        REPLY_TIMEOUT_MS,
      );
      say(`reply: ${reply}`);
      say('confirmed: the round trip completes correctly even fully network-isolated');

      const session = await findSessionForAgent(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null);
      if (!session) throw new Error('a container is running but there is no session row for this group');
      killContainer(session.id, 'ec08 live smoke cleanup');
      await until(
        'the container to disappear after the kernel-mediated kill',
        () => (containerExists(container.name) ? undefined : true),
        30_000,
      );
      say(`confirmed: ${container.name} is gone after a kernel-mediated kill`);
    } finally {
      client.destroy();
    }
  } catch (err) {
    failed = true;
    process.stderr.write(`== EC-08 FAILED: ${err instanceof Error ? err.message : String(err)} ==\n`);
  } finally {
    aborter.abort();
    stopDeliveryPolls();
    await stopHostModules();
    await teardownChannelAdapters();
    await closeDb();
  }

  say(failed ? '== EC-08: FAILED ==' : '== EC-08: egress lockdown genuinely isolates a real container ==');
  process.exit(failed ? 1 : 0);
}

void main();

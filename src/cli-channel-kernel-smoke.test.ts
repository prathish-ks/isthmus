/**
 * CLI channel ↔ kernel smoke test — the one seam nothing else in this repo
 * spans.
 *
 * Every other test that touches the router cuts the chain at the same place:
 * `vi.mock('./container-runner.js')`. host-core.test.ts proves an inbound
 * event becomes a `messages_in` row and asserts the wake only as "the mocked
 * `wakeContainer` was called"; delivery.test.ts proves an outbound row
 * reaches *a* channel adapter, but a fake one, registered by the test.
 * docker-driver.test.ts proves the driver calls `wake` — on a fake kernel
 * object, over no socket. client.test.ts proves the NDJSON envelope contract
 * — with no driver and no router in front of it. The shell harnesses
 * (scripts/p3-06-e2e.sh, scripts/ec06-live-smoke.sh) cover the container and
 * below, and ec06's own header states its boundary plainly: a real channel
 * adapter round trip "is TypeScript-host routing/channel infrastructure this
 * proof's scope deliberately does not touch."
 *
 * So nothing joins `routeInbound` → `wakeContainer` → `DockerSessionDriver`
 * → `KernelClient.wake` → a real socket, and nothing joins the CLI adapter's
 * own inbound socket to its own `deliver()`. This does both, in one process,
 * with `container-runner.ts` NOT mocked — which is the entire point, and the
 * kill condition: put `vi.mock('./container-runner.js')` back at the top of
 * this file and these tests stop proving anything.
 *
 * What is real here: the CLI adapter on its real Unix socket, the router,
 * session resolution, the real `inbound.db`/`outbound.db` files, the real
 * `wakeContainer`/`spawnContainer` composition path, the real
 * `DockerSessionDriver` including `validateSpec`, the real `KernelClient`,
 * and a real Unix-socket NDJSON round trip.
 *
 * What is deliberately NOT real, and why:
 *   - the kernel itself is a fake NDJSON server (the same shape
 *     `src/kernel/client.test.ts` uses). This test asserts the *host* speaks
 *     the protocol correctly and honours the kernel's answer; whether
 *     `internal/kernel` ADMITS this spec is a Go-side question that needs a
 *     real `nanogo serve` and a real Docker daemon. That is the follow-up
 *     live-Docker leg, not this test.
 *   - the docker CLI is a `FakeCli`. Post-wake, `DockerHandle.start()` only
 *     runs `docker attach --no-stdin <name>` — supervision of a container
 *     the kernel already created. Faking it is what lets the composition and
 *     attach path run with no daemon, so this test can live in the ordinary
 *     `test` job and run on every PR rather than in a report-only job.
 *   - the OneCLI gateway is a no-op stub via the existing
 *     `resetGatewayProvider` seam. A CI runner has no gateway, and the
 *     gateway's contribution is not what this seam is about.
 *
 * See go-host/docs/ADR-022 for the full scope decision.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import net from 'net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories hoist above imports, so the install root is a hoisted
// literal — the CLI adapter must never bind a running install's data/cli.sock,
// and the KernelClient must never dial a running install's kernel socket.
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: `/tmp/nanoclaw-cli-kernel-smoke-${process.pid}` }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    KERNEL_SOCKET_PATH: `${TEST_DIR}/nanogo-kernel.sock`,
  };
});

// Side-effect import: registers the `cli` adapter into the channel registry.
import './channels/index.js';
import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  createChannelDeliveryAdapter,
  initChannelAdapters,
  teardownChannelAdapters,
} from './channels/channel-registry.js';
import { ensureContainerConfig } from './db/container-configs.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { DockerSessionDriver } from './drivers/docker-driver.js';
import { FakeCli } from './drivers/fake-cli.js';
import { mountPolicy, resetSessionDriver, withSessionEvents } from './drivers/index.js';
import { resetGatewayProvider, type GatewayProvider } from './gateway-providers/index.js';
import { RecordingKernel, eventually } from './kernel/fake-server.js';
import { KERNEL_PROTOCOL_VERSION } from './kernel/protocol.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { routeInbound } from './router.js';
import { findSessionForAgent } from './db/sessions.js';
import { resolveSession } from './session-manager.js';

/**
 * The name the fake kernel derives and returns. Deliberately nothing like the
 * `nanoclaw-v2-<folder>-<Date.now()>` name `spawnContainer` computes locally,
 * so an assertion that the host attached to THIS string can only pass if the
 * host used the kernel's answer rather than its own guess — the EC-02
 * "never trust a caller-supplied name" property, observed from outside.
 */
const KERNEL_DERIVED_NAME = 'ncl-smoke-kernel-chose-this';
const AGENT_GROUP_ID = 'ag-cli-smoke';
const GROUP_FOLDER = 'cli-smoke';
const MESSAGING_GROUP_ID = 'mg-cli-smoke';

function now(): string {
  return new Date().toISOString();
}

function socketPath(): string {
  return path.join(TEST_DIR, 'cli.sock');
}

/** The host's own adapter wiring from `src/index.ts` step 3, verbatim in shape. */
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

let kernel: RecordingKernel;
let fakeCli: FakeCli;

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  // Exactly what scripts/init-cli-agent.ts seeds, and nothing more: the CLI
  // path's real prerequisites. `unknown_sender_policy: 'public'` and
  // `engage_pattern: '.'` are the cli adapter's own declared defaults, not
  // test conveniences — see CLI_DEFAULTS in src/channels/cli.ts.
  await createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'CLI Smoke',
    folder: GROUP_FOLDER,
    agent_provider: null,
    created_at: now(),
  });
  await ensureContainerConfig(AGENT_GROUP_ID);
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
    id: 'mga-cli-smoke',
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

  // No gateway on a CI runner, and the gateway's contribution is not what
  // this seam is about. `resetGatewayProvider` is the module's own declared
  // test seam, not a reach-in.
  const noGateway: GatewayProvider = {
    kind: 'none',
    contribute: async () => ({ env: {}, mounts: [] }),
  };
  resetGatewayProvider(noGateway);

  // The REAL DockerSessionDriver — real validateSpec, real KernelClient
  // against the mocked KERNEL_SOCKET_PATH — with only the docker binary
  // faked. `resetSessionDriver` is the module's own declared test seam.
  fakeCli = new FakeCli('docker');
  // `prepare` runs an idempotency pre-check before the wake: it predicts the
  // container name and asks docker whether something already wears it. A
  // FakeCli with no scripted answer returns '' WITHOUT throwing, which
  // `#existingSession` reads as "a container exists, with labels that are not
  // this session's" — a name collision, refused before the kernel is ever
  // dialled. Real docker exits non-zero for a name that does not exist, and
  // that throw is exactly what the check catches as "no container". Scripting
  // it is what makes the fake honest rather than convenient.
  fakeCli.responses = [{ match: /^inspect /, throws: 'Error: No such object' }];
  resetSessionDriver(withSessionEvents(new DockerSessionDriver({ ...mountPolicy(), cli: fakeCli })));

  kernel = new RecordingKernel(path.join(TEST_DIR, 'nanogo-kernel.sock'), {
    allowed: true,
    containerId: 'smoke-container-id',
    containerName: KERNEL_DERIVED_NAME,
  });
  await kernel.listen();

  await initChannelAdapters(hostSetup);
  setDeliveryAdapter(createChannelDeliveryAdapter());
});

afterEach(async () => {
  await teardownChannelAdapters();
  resetSessionDriver(null);
  resetGatewayProvider(null);
  await kernel.close();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a line typed at the CLI socket reaches the kernel', () => {
  it('routes, persists, and wakes through the real KernelClient over a real socket', async () => {
    const client = net.connect(socketPath());
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      client.write(JSON.stringify({ text: 'smoke: hello from the terminal' }) + '\n');

      await eventually('the kernel to receive a container.wake', () => kernel.requestsFor('container.wake').length === 1);

      // 1. The message became a real inbound row for a real session.
      const session = await findSessionForAgent(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null);
      expect(session).toBeTruthy();
      const inbound = new Database(inboundDbPath(AGENT_GROUP_ID, session!.id));
      const rows = inbound.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
      inbound.close();
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toContain('smoke: hello from the terminal');

      // 2. The envelope that actually crossed the wire is a well-formed
      //    container.wake for THAT session.
      const envelope = kernel.requestsFor('container.wake')[0];
      expect(envelope.version).toBe(KERNEL_PROTOCOL_VERSION);
      expect(envelope.op).toBe('capability.request');
      expect(envelope.payload.session?.key).toMatchObject({
        agentGroupId: AGENT_GROUP_ID,
        sessionId: session!.id,
      });
      expect(envelope.payload.capabilities).toEqual({ isolationTiers: ['container'] });

      // 3. The spec the host composed is the hardened one, and it carries
      //    exactly one agent container.
      const containers = envelope.payload.session?.containers ?? [];
      expect(containers).toHaveLength(1);
      expect(containers[0].role).toBe('agent');
      expect(containers[0].image).toBeTruthy();
      expect(envelope.payload.runAs?.uid).not.toBe(0);
    } finally {
      client.destroy();
    }
  });

  it('attaches to the name the kernel derived, never the one the host computed', async () => {
    const client = net.connect(socketPath());
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('connect', () => resolve());
        client.once('error', reject);
      });
      client.write(JSON.stringify({ text: 'smoke: name provenance' }) + '\n');

      // `started` is not just the attach: the driver opens its own long-lived
      // `docker events` subscription through the same `cli.start` seam, so
      // this filters for the attach rather than assuming it arrived alone.
      const attaches = () => fakeCli.started.map((s) => s.args).filter((args) => args[0] === 'attach');
      await eventually('the host to attach to the woken container', () => attaches().length === 1);

      expect(attaches()[0]).toEqual(['attach', '--no-stdin', KERNEL_DERIVED_NAME]);

      // EC-02's property, observed from outside the kernel. The host's own
      // predicted name DOES cross the wire — but only as the informational
      // `nanoclaw-container-name` label. The wire session carries no name
      // field for the kernel to adopt, and the name the host then supervises
      // is the one that came back, not the one it sent. The last assertion is
      // the one with teeth: those two strings must differ.
      const wire = kernel.requestsFor('container.wake')[0].payload.session!;
      const hostPredicted = wire.labels?.['nanoclaw-container-name'];
      expect(wire).not.toHaveProperty('name');
      expect(hostPredicted).toMatch(/^nanoclaw-v2-/);
      expect(attaches()[0][2]).toBe(KERNEL_DERIVED_NAME);
      expect(attaches()[0][2]).not.toBe(hostPredicted);
    } finally {
      client.destroy();
    }
  });
});

describe('the reply leaves through the same CLI connection', () => {
  it('delivers an outbound row back out of the adapter the message arrived on', async () => {
    const { session } = await resolveSession(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null, 'shared');

    const replies: string[] = [];
    const client = net.connect(socketPath());
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

      // Claim the chat slot: `deliver()` writes to the connected chat client,
      // and a client that has never sent a plain line is not one.
      client.write(JSON.stringify({ text: 'smoke: open the terminal' }) + '\n');
      await eventually('the inbound line to be routed', () => kernel.requestsFor('container.wake').length === 1);

      // Stand in for the agent-runner: one outbound row addressed back at the
      // CLI channel. Everything after this point is the real delivery path.
      const outbound = new Database(outboundDbPath(AGENT_GROUP_ID, session.id));
      outbound
        .prepare(
          `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
           VALUES (?, datetime('now'), 'chat', 'local', 'cli', ?)`,
        )
        .run('out-1', JSON.stringify({ text: 'smoke: deterministic reply' }));
      outbound.close();

      await deliverSessionMessages(session);

      await eventually('the reply to arrive on the CLI socket', () =>
        replies.some((line) => line.includes('smoke: deterministic reply')),
      );
    } finally {
      client.destroy();
    }
  });
});

/**
 * Shared driver/gateway setup for seam-real tests (ADR-022's discipline: a
 * real `DockerSessionDriver`, only the docker CLI and the gateway faked).
 *
 * Extracted 2026-09-24 alongside `kernel/fake-server.ts`, after a review
 * pass found this exact 6-line beforeEach/2-line afterEach pair copy-pasted
 * across five seam-real test files (`cli-channel-kernel-smoke.test.ts`,
 * `groups-restart-cli-kernel-smoke.test.ts`, `create-agent-kernel-smoke.test.ts`,
 * `agent-route-kernel-smoke.test.ts`, `host-sweep-kernel-smoke.test.ts`).
 * Kept in its own file rather than folded into `fake-server.ts`, which
 * stays scoped to the kernel-socket fake specifically — this one is about
 * the driver/gateway seam, a related but separate concern.
 */
import { DockerSessionDriver } from './docker-driver.js';
import { FakeCli } from './fake-cli.js';
import { mountPolicy, resetSessionDriver, withSessionEvents } from './index.js';
import { resetGatewayProvider, type GatewayProvider } from '../gateway-providers/index.js';

/**
 * Installs a real `DockerSessionDriver` (real `validateSpec`, real
 * composition) with only the docker CLI faked, plus a no-op gateway (no
 * CI runner has a real OneCLI gateway, and the gateway's contribution is
 * not what a seam-real test is about).
 *
 * The `FakeCli.responses` entry scripts `prepare()`'s idempotency
 * pre-check: it predicts the container name and asks docker whether
 * something already wears it. A `FakeCli` with no scripted answer returns
 * `''` WITHOUT throwing, which reads as "a container exists, with labels
 * that are not this session's" — a name collision, refused before the
 * kernel is ever dialled. Real docker exits non-zero for a name that does
 * not exist, and that throw is exactly what the check catches as "no
 * container". Scripting it is what makes the fake honest rather than
 * convenient — see `cli-channel-kernel-smoke.test.ts`'s original comment
 * on this exact line, the source this was extracted from.
 *
 * Returns the `FakeCli` for tests that need to inspect what it was asked
 * to run (e.g. asserting on the `attach` call after a wake).
 */
export function setUpSeamRealDriver(): FakeCli {
  const noGateway: GatewayProvider = { kind: 'none', contribute: async () => ({ env: {}, mounts: [] }) };
  resetGatewayProvider(noGateway);

  const fakeCli = new FakeCli('docker');
  fakeCli.responses = [{ match: /^inspect /, throws: 'Error: No such object' }];
  resetSessionDriver(withSessionEvents(new DockerSessionDriver({ ...mountPolicy(), cli: fakeCli })));
  return fakeCli;
}

/** Pairs with setUpSeamRealDriver() in afterEach. */
export function tearDownSeamRealDriver(): void {
  resetSessionDriver(null);
  resetGatewayProvider(null);
}

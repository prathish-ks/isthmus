/**
 * A recording, scriptable stand-in for `KernelClient` — the kernel-side
 * counterpart to `drivers/fake-cli.ts`'s `FakeCli`.
 *
 * Records every `wake`/`kill`/`buildImage` call (spec/sessionId/reason/guard
 * as given) so tests can assert on what the driver asked the kernel to do,
 * and is scriptable to reject in either of the two shapes a real
 * `KernelClient` can fail with (`KernelError` for a well-formed denial, a
 * plain `Error` for an unreachable kernel process).
 *
 * Shared by `drivers/docker-driver.test.ts` (asserts on individual
 * wake/kill/buildImage calls) and `drivers/conformance.test.ts` (drives the
 * same fake through the cross-driver conformance floor, reconstructing a
 * `Realized` view from `wakeCalls` since EC-02 moved the actual
 * `docker create`/`docker start` behind `internal/kernel` — the fake never
 * shells a real CLI, so there is nothing for a `docker create` argv to
 * appear in any more).
 */
import type { SessionSpec } from '../drivers/types.js';

import type { KernelClientLike, KernelWakeResult } from './client.js';
import type { GuardContext } from './protocol.js';

export class FakeKernelClient implements KernelClientLike {
  wakeCalls: Array<{ spec: SessionSpec; guard?: GuardContext }> = [];
  killCalls: Array<{ sessionId: string; reason: string; guard?: GuardContext }> = [];
  buildImageCalls: Array<{
    agentGroupId: string;
    groupFolder: string;
    imageTag: string;
    dockerfile: string;
    guard?: GuardContext;
  }> = [];

  /** Set to make the next matching call reject; consumed once. */
  wakeError: Error | null = null;
  killError: Error | null = null;
  buildImageError: Error | null = null;

  /** What `wake` resolves with when it does not reject. */
  wakeResult: KernelWakeResult = { containerId: 'fake-container-id', containerName: 'ncl-spike-s1' };

  async wake(spec: SessionSpec, guard?: GuardContext): Promise<KernelWakeResult> {
    this.wakeCalls.push({ spec, guard });
    if (this.wakeError) {
      const err = this.wakeError;
      this.wakeError = null;
      throw err;
    }
    return this.wakeResult;
  }

  async kill(sessionId: string, reason: string, guard?: GuardContext): Promise<void> {
    this.killCalls.push({ sessionId, reason, guard });
    if (this.killError) {
      const err = this.killError;
      this.killError = null;
      throw err;
    }
  }

  async buildImage(params: {
    agentGroupId: string;
    groupFolder: string;
    imageTag: string;
    dockerfile: string;
    guard?: GuardContext;
  }): Promise<string> {
    this.buildImageCalls.push(params);
    if (this.buildImageError) {
      const err = this.buildImageError;
      this.buildImageError = null;
      throw err;
    }
    return params.imageTag;
  }
}

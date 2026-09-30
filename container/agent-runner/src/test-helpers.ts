/** Shared test-only helpers for `container/agent-runner/src/*.test.ts`. */

/** Poll `condition` until it's true, or throw once `timeoutMs` elapses. */
export async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

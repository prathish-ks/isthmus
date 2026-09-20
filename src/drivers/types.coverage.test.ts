/**
 * Coverage-uplift test for drivers/types.ts targeting the one branch the
 * extensive conformance/docker-driver suites don't reach: mountAllowed's
 * `default: return false` arm for a mount class outside the closed
 * MountClass union — reachable only via a malformed spec (e.g. a hand-built
 * or corrupted composer output), which validateSpec must still deny rather
 * than silently drop through.
 */
import { describe, expect, it } from 'vitest';

import { fixtureSpec, FIXTURE_POLICY } from './spec-fixture.js';
import { validateSpec } from './types.js';

describe('validateSpec — unrecognized mount class', () => {
  it('denies a mount whose class is outside the MountClass union', () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts.push({
      // Cast past the type system to simulate a malformed/corrupted spec —
      // the runtime guard (mountAllowed's switch default) is what's under test.
      class: 'not-a-real-class' as never,
      hostPath: '/some/unrelated/path/outside/every/policy/root',
      containerPath: '/workspace/extra',
      mode: 'ro',
      groupScope: 'g1',
    });
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/violates class not-a-real-class/);
  });
});

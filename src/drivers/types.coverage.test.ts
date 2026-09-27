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
import { classRequiredByPath, validateSpec } from './types.js';

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

describe('classRequiredByPath — gateway-trust vs. materials precedence', () => {
  it('classifies a path under both roots as gateway-trust, matching mount.ClassRequiredByPath (Go)', () => {
    // FIXTURE_POLICY keeps these roots disjoint; a real deployment is
    // expected to as well, but nothing in MountPolicy's own type or
    // construction enforces that. This pins the one order that keeps Go
    // and TS agreeing on a path under both roots regardless — see
    // classRequiredByPath's own comment on why gateway-trust is checked
    // first.
    const overlapping = {
      ...FIXTURE_POLICY,
      materialsRoot: '/install/data/shared-root',
      gatewayTrustRoot: '/install/data/shared-root/gateway-trust',
    };
    expect(classRequiredByPath('/install/data/shared-root/gateway-trust/ca.pem', overlapping)).toBe('gateway-trust');
  });

  it('still classifies an ordinary materials-root path as identity-material when the roots do not overlap', () => {
    expect(classRequiredByPath('/install/data/session-materials/ag-1/token', FIXTURE_POLICY)).toBe('identity-material');
  });
});

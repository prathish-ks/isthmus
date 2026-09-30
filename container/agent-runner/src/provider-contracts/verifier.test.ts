/**
 * Regression coverage for verifier.ts, closing a real gap: its own doc
 * comment promises assertProviderRuntimeContractShape/
 * probeProviderRuntimeConfiguration are "run by tests and install-time
 * verification, not startup" — but nothing in this tree called either
 * function anywhere (confirmed by a dedicated code review of the v2.4.0
 * promotion's Workstream C15 port). Registration itself
 * (provider-registry.ts's registerProviderContract) deliberately does NOT
 * call these — that would contradict "not startup" — so this file is what
 * makes the "run by tests" half of that promise true. Exercises the real,
 * currently-registered Claude contract rather than a synthetic fixture: the
 * whole point is catching Claude's own contract going malformed, not
 * proving the verifier works in the abstract.
 */
import { describe, expect, it } from 'bun:test';

import { claudeRuntimeContract } from './claude.js';
import { assertProviderRuntimeContractShape, probeProviderRuntimeConfiguration } from './verifier.js';

describe('claudeRuntimeContract — shape and behavioral probes', () => {
  it('passes the shape check', () => {
    expect(() => assertProviderRuntimeContractShape('claude', claudeRuntimeContract)).not.toThrow();
  });

  it('passes the behavioral probes (inference/mcpServers genuinely respond to their input)', () => {
    expect(() => probeProviderRuntimeConfiguration('claude', claudeRuntimeContract)).not.toThrow();
  });

  it('shape check rejects a contract with an invalid textDelivery value — the check has real teeth', () => {
    const malformed = { ...claudeRuntimeContract, textDelivery: 'not-a-real-value' as never };
    expect(() => assertProviderRuntimeContractShape('claude', malformed)).toThrow(/textDelivery/);
  });

  it('shape check rejects a duplicate command in nativeFiltered — the check has real teeth', () => {
    const malformed = {
      ...claudeRuntimeContract,
      commands: { ...claudeRuntimeContract.commands, nativeFiltered: ['/help', '/help'] },
    };
    expect(() => assertProviderRuntimeContractShape('claude', malformed)).toThrow(/duplicate/);
  });

  it('probe rejects a capability function that ignores its input — the probe has real teeth', () => {
    const malformed = {
      ...claudeRuntimeContract,
      configuration: { ...claudeRuntimeContract.configuration, inference: () => ({ model: 'always-the-same' }) },
    };
    expect(() => probeProviderRuntimeConfiguration('claude', malformed)).toThrow(/does not respond to its/);
  });
});

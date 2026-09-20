import { describe, expect, it } from 'vitest';

import {
  getProviderContainerConfig,
  listProviderContainerConfigNames,
  providerProvidesAgentSurfaces,
  registerProviderContainerConfig,
} from './provider-container-registry.js';

// The registry is module-global; every name here is unique to this file so
// the cases do not collide with each other or with a provider barrel.
describe('provider container-config registry', () => {
  it('returns undefined for a provider that never registered', () => {
    expect(getProviderContainerConfig('never-registered')).toBeUndefined();
    expect(listProviderContainerConfigNames()).not.toContain('never-registered');
  });

  it('registers a config fn and hands it back by name', async () => {
    const fn = () => ({ env: { X: '1' } });
    registerProviderContainerConfig('reg-basic', fn);

    expect(getProviderContainerConfig('reg-basic')).toBe(fn);
    expect(listProviderContainerConfigNames()).toContain('reg-basic');
    expect(
      await getProviderContainerConfig('reg-basic')!({
        sessionDir: '/s',
        agentGroupId: 'g',
        groupDir: '/g',
        selectedSkills: [],
        hostEnv: {},
      }),
    ).toEqual({ env: { X: '1' } });
  });

  it('refuses a duplicate registration instead of letting the last import win', () => {
    registerProviderContainerConfig('reg-dup', () => ({}));
    expect(() => registerProviderContainerConfig('reg-dup', () => ({}))).toThrow(
      'Provider container config already registered: reg-dup',
    );
  });

  it('reports no agent surfaces for empty, unknown, and capability-less providers', () => {
    registerProviderContainerConfig('reg-plain', () => ({}));
    expect(providerProvidesAgentSurfaces(null)).toBe(false);
    expect(providerProvidesAgentSurfaces(undefined)).toBe(false);
    expect(providerProvidesAgentSurfaces('')).toBe(false);
    expect(providerProvidesAgentSurfaces('reg-unknown')).toBe(false);
    expect(providerProvidesAgentSurfaces('reg-plain')).toBe(false);
  });

  it('reports agent surfaces only when the registration says true', () => {
    registerProviderContainerConfig('reg-surfaces', () => ({}), { providesAgentSurfaces: true });
    registerProviderContainerConfig('reg-no-surfaces', () => ({}), { providesAgentSurfaces: false });
    expect(providerProvidesAgentSurfaces('reg-surfaces')).toBe(true);
    expect(providerProvidesAgentSurfaces('reg-no-surfaces')).toBe(false);
  });
});

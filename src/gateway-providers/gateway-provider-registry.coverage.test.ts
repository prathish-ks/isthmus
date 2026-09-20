import { describe, expect, it } from 'vitest';

import {
  getGatewayProviderFactory,
  listGatewayProviderKinds,
  registerGatewayProvider,
  type GatewayProvider,
} from './gateway-provider-registry.js';

function provider(kind: string): GatewayProvider {
  return { kind, contribute: async () => ({}) };
}

describe('gateway provider registry', () => {
  it('returns undefined for a kind nobody registered', () => {
    expect(getGatewayProviderFactory('reg-missing')).toBeUndefined();
    expect(listGatewayProviderKinds()).not.toContain('reg-missing');
  });

  it('registers a factory under a kind and lists it', () => {
    const factory = () => provider('reg-a');
    registerGatewayProvider('reg-a', factory);
    expect(getGatewayProviderFactory('reg-a')).toBe(factory);
    expect(getGatewayProviderFactory('reg-a')!().kind).toBe('reg-a');
    expect(listGatewayProviderKinds()).toContain('reg-a');
  });

  it('throws on a duplicate kind — a wiring bug must not let the last import win silently', () => {
    registerGatewayProvider('reg-dup', () => provider('reg-dup'));
    expect(() => registerGatewayProvider('reg-dup', () => provider('reg-dup'))).toThrow(
      'Gateway provider already registered: reg-dup',
    );
    // The first registration is still the one installed.
    expect(getGatewayProviderFactory('reg-dup')!().kind).toBe('reg-dup');
  });

  it('lists every registered kind in registration order', () => {
    registerGatewayProvider('reg-order-1', () => provider('reg-order-1'));
    registerGatewayProvider('reg-order-2', () => provider('reg-order-2'));
    const kinds = listGatewayProviderKinds();
    expect(kinds.indexOf('reg-order-1')).toBeLessThan(kinds.indexOf('reg-order-2'));
  });
});

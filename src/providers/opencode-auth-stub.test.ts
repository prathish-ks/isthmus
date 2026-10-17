import { describe, expect, it } from 'vitest';

import { buildGatewayManagedStub, OPENCODE_CREDENTIAL_PLACEHOLDER } from './opencode-auth-stub.js';

describe('buildGatewayManagedStub', () => {
  it('writes OpenCode legacy auth.json shape keyed by the "openai" provider id', () => {
    const stub = buildGatewayManagedStub();
    expect(stub).toEqual({
      openai: {
        type: 'oauth',
        access: OPENCODE_CREDENTIAL_PLACEHOLDER,
        refresh: OPENCODE_CREDENTIAL_PLACEHOLDER,
        accountId: OPENCODE_CREDENTIAL_PLACEHOLDER,
        expires: Date.UTC(2100, 0, 1),
      },
    });
  });

  it('expires far enough in the future that OpenCode never tries to refresh it itself', () => {
    expect(buildGatewayManagedStub().openai).toMatchObject({ expires: expect.any(Number) });
    const { expires } = buildGatewayManagedStub().openai as { expires: number };
    expect(expires).toBeGreaterThan(Date.now());
  });
});

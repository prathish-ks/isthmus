/**
 * Coverage for setup/auth.ts's listSecrets/findAnthropicSecret — previously
 * untested (this file had zero test coverage). These are now also reused
 * by setup/auto.ts's anthropicSecretExists (code review finding: that
 * caller used to do its own raw substring test against unparsed `onecli
 * secrets list` stdout instead of this structured, type-field-based check —
 * demonstrably less accurate, since a differently-typed secret can still
 * contain the literal text "anthropic" in another field).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockExecFileSync = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFileSync: mockExecFileSync }));

import { findAnthropicSecret, listSecrets, type OnecliSecret } from './auth.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function secretsResponse(data: OnecliSecret[]): string {
  return JSON.stringify({ data });
}

describe('listSecrets', () => {
  it('parses the data array from onecli secrets list JSON output', () => {
    mockExecFileSync.mockReturnValue(
      secretsResponse([{ id: 's1', name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' }]),
    );

    expect(listSecrets()).toEqual([{ id: 's1', name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' }]);
  });

  it('returns an empty array when the response has no data field', () => {
    mockExecFileSync.mockReturnValue(JSON.stringify({}));

    expect(listSecrets()).toEqual([]);
  });

  it('propagates a failure from the onecli subprocess (caller\'s responsibility to handle)', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('onecli: connection refused');
    });

    expect(() => listSecrets()).toThrow('connection refused');
  });
});

describe('findAnthropicSecret', () => {
  it('finds a secret whose type is exactly "anthropic"', () => {
    const secrets: OnecliSecret[] = [
      { id: 's1', name: 'Custom Bearer', type: 'bearer', hostPattern: 'api.anthropic.com' },
      { id: 's2', name: 'Anthropic', type: 'anthropic', hostPattern: 'api.anthropic.com' },
    ];

    expect(findAnthropicSecret(secrets)?.id).toBe('s2');
  });

  it('the false-positive this fix closes: a differently-typed secret whose fields merely CONTAIN "anthropic" is not matched', () => {
    // Exactly the scenario named in the review finding: auto.ts's custom-
    // endpoint flow stores the token as a generic Bearer secret host-
    // patterned to api.anthropic.com — the literal substring "anthropic"
    // appears in this secret's JSON, but its type is 'bearer', not
    // 'anthropic'. The old code (/anthropic/i.test(raw stdout)) would have
    // matched this and wrongly reported a real Anthropic credential as
    // already connected.
    const secrets: OnecliSecret[] = [
      { id: 's1', name: 'Custom Anthropic Endpoint', type: 'bearer', hostPattern: 'api.anthropic.com' },
    ];

    expect(findAnthropicSecret(secrets)).toBeUndefined();
  });

  it('returns undefined for an empty secret list', () => {
    expect(findAnthropicSecret([])).toBeUndefined();
  });
});

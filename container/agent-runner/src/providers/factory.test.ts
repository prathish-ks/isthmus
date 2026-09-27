import { describe, it, expect } from 'bun:test';

// Registers Claude's runtime contract — createProvider('claude') throws
// without it (Workstream C15: the provider now requires its resolved
// configuration, which only exists once a contract is attached).
import '../provider-contracts/claude.js';
import { createProvider, type ProviderName } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus' as ProviderName)).toThrow(/Unknown provider/);
  });
});

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  // Default `{}`: the vitest setup file loads config.ts, which reads .env too.
  readEnvFile: vi.fn<(keys: string[]) => Record<string, string>>(() => ({})),
}));

vi.mock('../env.js', () => ({ readEnvFile: mocks.readEnvFile }));

// Importing the file is what registers the provider. The barrel is imported
// too so its (empty) module body counts as loaded.
import './claude.js';
import './index.js';
import { getProviderContainerConfig } from './provider-container-registry.js';

const ctx = { sessionDir: '/s', agentGroupId: 'g1', groupDir: '/g', selectedSkills: [], hostEnv: {} };

describe('claude provider container config', () => {
  it('registers under the name "claude"', () => {
    expect(getProviderContainerConfig('claude')).toBeTypeOf('function');
  });

  it('contributes nothing when no custom endpoint is configured', async () => {
    mocks.readEnvFile.mockReturnValueOnce({});
    const contribution = await getProviderContainerConfig('claude')!(ctx);
    expect(contribution).toEqual({ env: {} });
    expect(mocks.readEnvFile).toHaveBeenCalledWith(['ANTHROPIC_BASE_URL']);
  });

  it('points the SDK at the custom endpoint with a placeholder token for OneCLI to overwrite', async () => {
    // The real token never enters the container: the placeholder only makes
    // the SDK send an Authorization header the proxy rewrites on the wire.
    mocks.readEnvFile.mockReturnValueOnce({ ANTHROPIC_BASE_URL: 'https://llm.example.test/v1' });
    const contribution = await getProviderContainerConfig('claude')!(ctx);
    expect(contribution).toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://llm.example.test/v1', ANTHROPIC_AUTH_TOKEN: 'placeholder' },
    });
  });

  it('re-reads .env on every call rather than caching at registration', async () => {
    mocks.readEnvFile.mockReturnValueOnce({ ANTHROPIC_BASE_URL: 'https://a.test' });
    mocks.readEnvFile.mockReturnValueOnce({});
    const fn = getProviderContainerConfig('claude')!;
    expect((await fn(ctx)).env?.ANTHROPIC_BASE_URL).toBe('https://a.test');
    expect((await fn(ctx)).env?.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});

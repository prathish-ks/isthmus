import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: (...args: unknown[]) => fixture.exec(...args),
}));

import { discoverRuntimeModels, parseRuntimeModels, runtimeModelArgs, validateModel } from './opencode-model-config.js';

function record(id: string, toolcall = true, text = true, status = 'active') {
  return `${id}\n${JSON.stringify({ providerID: id.split('/')[0], capabilities: { toolcall, input: { text }, output: { text } }, status }, null, 2)}\n`;
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.exec.mockReturnValue(record('openai/new-model') + record('openai/current'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('installed runtime catalog', () => {
  it('filters metadata instead of using a static GPT allowlist', () => {
    const output =
      record('openai/new-future-model') +
      record('openai/o-new') +
      record('openai/image', false) +
      record('openai/embedding', false, false) +
      record('openai/old', true, true, 'deprecated') +
      record('openai/o-new');
    expect(parseRuntimeModels(output, 'openai')).toEqual(['openai/new-future-model', 'openai/o-new']);
  });
  it('rejects malformed runtime output rather than presenting guessed models', () => {
    expect(() => parseRuntimeModels('openai/test\ninvalid', 'openai')).toThrow();
    fixture.exec.mockReturnValue('provider not found');
    expect(() => discoverRuntimeModels('openai')).toThrow('no text/tool-capable');
  });
  it('queries the container only, enables refresh, and activates ChatGPT filtering with a fixed sentinel', () => {
    discoverRuntimeModels('openai', true, true);
    const [command, args, options] = fixture.exec.mock.calls[0];
    expect(command).not.toBe('opencode');
    expect(args).toContain('--refresh');
    expect(args).toContain('--verbose');
    expect(args).not.toContain('-v');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--env-file');
    const stubArg = args.find((value: string) => value.startsWith('OPENCODE_CATALOG_AUTH='));
    // The catalog run presents the same non-secret placeholder the agent runtime does.
    expect(JSON.parse(stubArg.split('=').slice(1).join('='))).toEqual({
      openai: {
        type: 'oauth',
        access: 'nc-opencode-token-v1',
        refresh: 'nc-opencode-token-v1',
        accountId: 'nc-opencode-token-v1',
        expires: Date.UTC(2100, 0, 1),
      },
    });
    expect(options.timeout).toBe(60000);
    expect(options.maxBuffer).toBeGreaterThan(0);
  });
  it('keeps API backend discovery outside ChatGPT mode and rejects invalid provider arguments', () => {
    expect(runtimeModelArgs('openrouter')).not.toContain('sh');
    expect(() => runtimeModelArgs('--help')).toThrow();
    expect(() => runtimeModelArgs('openrouter', false, true)).toThrow('openai backend');
  });
  it('accepts nested provider model ids and rejects control characters', () => {
    expect(validateModel('openrouter/vendor/model:free', 'openrouter')).toBeUndefined();
    expect(validateModel('openai/a\rb', 'openai')).toBeDefined();
  });
});

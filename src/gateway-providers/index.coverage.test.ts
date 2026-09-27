import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readEnvFile: vi.fn<(keys: string[]) => Record<string, string>>(() => ({})),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

vi.mock('../log.js', () => ({ log: mocks.log }));
vi.mock('../env.js', () => ({ readEnvFile: mocks.readEnvFile }));
// onecli.ts (reached through installed.ts) constructs its SDK client from these.
vi.mock('../config.js', () => ({ ONECLI_URL: 'http://localhost:1', ONECLI_API_KEY: 'unused' }));

import {
  configuredGatewayProviderKind,
  getGatewayProvider,
  getGatewayProviderFactory,
  listGatewayProviderKinds,
  registerGatewayProvider,
  resetGatewayProvider,
  type GatewayProviderDefinition,
} from './index.js';

function stubProvider(kind: string): GatewayProviderDefinition {
  return {
    kind,
    agentSkills: [],
    sessions: {
      ensure: async () => ({ contribution: { networkAccess: { endpoint: '', target: { kind: 'host' } } } }),
    },
    approvals: { subscribe: async () => {} },
  };
}

const ENV_KEY = 'NANOCLAW_GATEWAY_PROVIDER';
const savedEnv = process.env[ENV_KEY];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readEnvFile.mockReturnValue({});
  delete process.env[ENV_KEY];
  resetGatewayProvider(null);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  resetGatewayProvider(null);
});

describe('configuredGatewayProviderKind', () => {
  it('defaults to onecli when nothing is configured anywhere', () => {
    expect(configuredGatewayProviderKind({})).toBe('onecli');
    expect(mocks.readEnvFile).toHaveBeenCalledWith([ENV_KEY]);
  });

  it('process.env wins and is trimmed + lowercased', () => {
    mocks.readEnvFile.mockReturnValue({ [ENV_KEY]: 'from-dotenv' });
    expect(configuredGatewayProviderKind({ [ENV_KEY]: '  MyGateway ' })).toBe('mygateway');
    // A process.env hit short-circuits: .env is never consulted.
    expect(mocks.readEnvFile).not.toHaveBeenCalled();
  });

  it('falls back to .env when process.env is unset or blank', () => {
    mocks.readEnvFile.mockReturnValue({ [ENV_KEY]: ' DotEnvGw ' });
    expect(configuredGatewayProviderKind({})).toBe('dotenvgw');
    expect(configuredGatewayProviderKind({ [ENV_KEY]: '   ' })).toBe('dotenvgw');
  });

  it('treats a whitespace-only .env value as unset', () => {
    mocks.readEnvFile.mockReturnValue({ [ENV_KEY]: '   ' });
    expect(configuredGatewayProviderKind({})).toBe('onecli');
  });

  it('reads process.env by default', () => {
    process.env[ENV_KEY] = 'FromProcess';
    expect(configuredGatewayProviderKind()).toBe('fromprocess');
  });
});

describe('getGatewayProvider', () => {
  it('selects the built-in onecli provider by default and memoizes it', () => {
    const first = getGatewayProvider();
    expect(first.kind).toBe('onecli');
    expect(getGatewayProvider()).toBe(first);
    expect(mocks.log.info).toHaveBeenCalledTimes(1);
    expect(mocks.log.info).toHaveBeenCalledWith('Gateway provider selected', { gatewayProvider: 'onecli' });
  });

  it('throws an operator-actionable error for a configured kind with no registered provider', () => {
    process.env[ENV_KEY] = 'nope';
    expect(() => getGatewayProvider()).toThrow(
      /NANOCLAW_GATEWAY_PROVIDER='nope' but no gateway provider is registered for 'nope'/,
    );
    expect(() => getGatewayProvider()).toThrow(/installed: .*onecli/);
    expect(mocks.log.info).not.toHaveBeenCalled();
  });

  it('selects an overlay-registered kind when configured', () => {
    const overlay = stubProvider('idx-overlay');
    registerGatewayProvider('idx-overlay', () => overlay);
    process.env[ENV_KEY] = 'IDX-OVERLAY';
    expect(getGatewayProvider()).toBe(overlay);
    expect(mocks.log.info).toHaveBeenCalledWith('Gateway provider selected', { gatewayProvider: 'idx-overlay' });
  });

  it('resetGatewayProvider injects a provider directly (test seam)', () => {
    const fake = stubProvider('fake');
    resetGatewayProvider(fake);
    expect(getGatewayProvider()).toBe(fake);
    // No selection happened, so no selection log line.
    expect(mocks.log.info).not.toHaveBeenCalled();
  });

  it('re-exports the registry surface', () => {
    expect(typeof registerGatewayProvider).toBe('function');
    expect(getGatewayProviderFactory('onecli')).toBeTypeOf('function');
    expect(listGatewayProviderKinds()).toContain('onecli');
  });
});

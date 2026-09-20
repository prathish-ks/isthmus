/**
 * Coverage-uplift tests for the channel adapter registry: the exact-key vs
 * fallback lookups, the delivery/typing/title/prompt passthroughs, every tier
 * of the declared-defaults lookup, and the boot-time failure/retry/duplicate
 * paths of initChannelAdapters / teardownChannelAdapters / startChannelAdapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelDefaults, ChannelSetup } from './adapter.js';

function makeDefaults(marker: string, threads = true): ChannelDefaults {
  return {
    dm: { engageMode: 'pattern', engagePattern: marker, threads, unknownSenderPolicy: 'public' },
    group: { engageMode: 'mention', threads, unknownSenderPolicy: 'strict' },
    mentions: 'platform',
  };
}

interface FakeAdapter extends ChannelAdapter {
  delivered: Array<{ platformId: string; threadId: string | null; kind: string; content: unknown; files?: unknown }>;
  typing: unknown[][];
  titles: unknown[][];
  prompts: unknown[][];
}

function makeAdapter(
  channelType: string,
  opts: {
    instance?: string;
    supportsThreads?: boolean;
    defaults?: ChannelDefaults;
    withTyping?: boolean;
    withTitle?: boolean;
    withPrompts?: boolean;
    setup?: (config: ChannelSetup) => Promise<void>;
    teardown?: () => Promise<void>;
  } = {},
): FakeAdapter {
  const adapter: FakeAdapter = {
    name: opts.instance ?? channelType,
    channelType,
    instance: opts.instance,
    supportsThreads: opts.supportsThreads ?? false,
    defaults: opts.defaults,
    delivered: [],
    typing: [],
    titles: [],
    prompts: [],
    setup: opts.setup ?? (async () => {}),
    teardown: opts.teardown ?? (async () => {}),
    isConnected: () => true,
    async deliver(platformId, threadId, message) {
      adapter.delivered.push({
        platformId,
        threadId,
        kind: message.kind,
        content: message.content,
        files: message.files,
      });
      return `sent-${adapter.delivered.length}`;
    },
  };
  if (opts.withTyping) {
    adapter.setTyping = async (...args: unknown[]) => {
      adapter.typing.push(args);
    };
  }
  if (opts.withTitle) {
    adapter.setThreadTitle = async (...args: unknown[]) => {
      adapter.titles.push(args);
    };
  }
  if (opts.withPrompts) {
    adapter.setSuggestedPrompts = async (...args: unknown[]) => {
      adapter.prompts.push(args);
    };
  }
  return adapter;
}

const mockSetup = (): ChannelSetup => ({
  onInbound: () => {},
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
});

async function loadRegistry() {
  return import('./channel-registry.js');
}

async function loadLog() {
  const { log } = await import('../log.js');
  return log;
}

// The registry and activeAdapters maps are module-level: fresh module per
// test so registrations and live adapters never leak between arms.
beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  vi.useRealTimers();
  const { teardownChannelAdapters } = await loadRegistry();
  await teardownChannelAdapters();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('lookups', () => {
  it('getChannelAdapter returns undefined (no warning) when neither key nor channelType matches', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    reg.registerChannelAdapter('slack', { factory: () => makeAdapter('slack') });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelAdapter('discord')).toBeUndefined();
    expect(reg.getChannelAdapterExact('discord')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('getChannelAdapter / getChannelAdapterExact hit the exact key without warning', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const adapter = makeAdapter('slack');
    reg.registerChannelAdapter('slack', { factory: () => adapter });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getChannelAdapter('slack')).toBe(adapter);
    expect(reg.getChannelAdapterExact('slack')).toBe(adapter);
    expect(warn).not.toHaveBeenCalled();
  });

  it('getChannelAdapter warns when it falls back through a differently-keyed instance', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const named = makeAdapter('slack', { instance: 'slack-two' });
    reg.registerChannelAdapter('slack-two', { factory: () => named });
    await reg.initChannelAdapters(mockSetup);

    expect(reg.getChannelAdapter('slack')).toBe(named);
    expect(warn).toHaveBeenCalledWith(
      'Channel adapter fallback: requested key resolved through a differently-keyed instance',
      { requested: 'slack', resolvedKey: 'slack-two' },
    );
  });

  it('getRegisteredChannelNames / getActiveAdapters / getChannelContainerConfig reflect the registry', async () => {
    const reg = await loadRegistry();
    const a = makeAdapter('alpha');
    reg.registerChannelAdapter('alpha', { factory: () => a, containerConfig: { env: { A: '1' } } });
    reg.registerChannelAdapter('beta', { factory: () => null });
    expect(reg.getRegisteredChannelNames()).toEqual(['alpha', 'beta']);
    expect(reg.getChannelContainerConfig('alpha')).toEqual({ env: { A: '1' } });
    expect(reg.getChannelContainerConfig('beta')).toBeUndefined();
    expect(reg.getChannelContainerConfig('nope')).toBeUndefined();
    expect(reg.getActiveAdapters()).toEqual([]);
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getActiveAdapters()).toEqual([a]);
  });
});

describe('MissingChannelAdapterError', () => {
  it('names the instance when given, else the channelType', async () => {
    const reg = await loadRegistry();
    const withInstance = new reg.MissingChannelAdapterError('slack', 'slack-two');
    expect(withInstance.name).toBe('MissingChannelAdapterError');
    expect(withInstance.channelType).toBe('slack');
    expect(withInstance.instance).toBe('slack-two');
    expect(withInstance.message).toMatch(/No adapter registered for 'slack-two'/);

    const withoutInstance = new reg.MissingChannelAdapterError('slack');
    expect(withoutInstance.instance).toBeUndefined();
    expect(withoutInstance.message).toMatch(/No adapter registered for 'slack'/);
  });
});

describe('createChannelDeliveryAdapter', () => {
  it('deliver resolves by channelType when no instance is given and parses content JSON', async () => {
    const reg = await loadRegistry();
    const adapter = makeAdapter('slack');
    reg.registerChannelAdapter('slack', { factory: () => adapter });
    await reg.initChannelAdapters(mockSetup);

    const bridge = reg.createChannelDeliveryAdapter();
    const id = await bridge.deliver('slack', 'slack:C1', 'slack:C1:T1', 'chat', JSON.stringify({ text: 'hi' }), [
      { data: Buffer.from('x'), filename: 'x.txt' },
    ]);
    expect(id).toBe('sent-1');
    expect(adapter.delivered).toEqual([
      {
        platformId: 'slack:C1',
        threadId: 'slack:C1:T1',
        kind: 'chat',
        content: { text: 'hi' },
        files: [{ data: Buffer.from('x'), filename: 'x.txt' }],
      },
    ]);
  });

  it('deliver throws MissingChannelAdapterError carrying the requested instance', async () => {
    const reg = await loadRegistry();
    await reg.initChannelAdapters(mockSetup);
    const bridge = reg.createChannelDeliveryAdapter();
    await expect(
      bridge.deliver('slack', 'slack:C1', null, 'chat', '{}', undefined, 'slack-ghost'),
    ).rejects.toMatchObject({
      name: 'MissingChannelAdapterError',
      channelType: 'slack',
      instance: 'slack-ghost',
    });
  });

  it('setTyping forwards to the exact adapter and is a no-op for a missing adapter or capability', async () => {
    const reg = await loadRegistry();
    const typing = makeAdapter('slack', { withTyping: true });
    const mute = makeAdapter('discord');
    reg.registerChannelAdapter('slack', { factory: () => typing });
    reg.registerChannelAdapter('discord', { factory: () => mute });
    await reg.initChannelAdapters(mockSetup);

    const bridge = reg.createChannelDeliveryAdapter();
    await bridge.setTyping!('slack', 'slack:C1', 'slack:C1:T1', undefined, 'thinking', 'agent');
    await bridge.setTyping!('slack', 'slack:C2', null, 'slack');
    expect(typing.typing).toEqual([
      ['slack:C1', 'slack:C1:T1', 'thinking', 'agent'],
      ['slack:C2', null, undefined, undefined],
    ]);

    // Adapter present but without setTyping, and adapter absent — both resolve silently.
    await expect(bridge.setTyping!('discord', 'discord:C1', null)).resolves.toBeUndefined();
    await expect(bridge.setTyping!('teams', 'teams:C1', null, 'teams-ghost')).resolves.toBeUndefined();
  });
});

describe('setThreadTitle / setSuggestedPrompts passthroughs', () => {
  it('forward to the exact-key adapter and silently skip missing adapters or capabilities', async () => {
    const reg = await loadRegistry();
    const full = makeAdapter('slack', { instance: 'slack-two', withTitle: true, withPrompts: true });
    const bare = makeAdapter('slack');
    reg.registerChannelAdapter('slack-two', { factory: () => full });
    reg.registerChannelAdapter('slack', { factory: () => bare });
    await reg.initChannelAdapters(mockSetup);

    await reg.setThreadTitle('slack-two', 'slack:D1', 'slack:D1:1', 'Hello');
    await reg.setSuggestedPrompts('slack-two', 'slack:D1', [{ title: 'T', message: 'M' }], 'Try these');
    await reg.setSuggestedPrompts('slack-two', 'slack:D1', []);
    expect(full.titles).toEqual([['slack:D1', 'slack:D1:1', 'Hello']]);
    expect(full.prompts).toEqual([
      ['slack:D1', [{ title: 'T', message: 'M' }], 'Try these'],
      ['slack:D1', [], undefined],
    ]);

    // No capability on the default instance; no adapter at all for a ghost key.
    await expect(reg.setThreadTitle('slack', 'slack:D1', 'slack:D1:1', 'x')).resolves.toBeUndefined();
    await expect(reg.setSuggestedPrompts('slack', 'slack:D1', [])).resolves.toBeUndefined();
    await expect(reg.setThreadTitle('ghost', 'p', 't', 'x')).resolves.toBeUndefined();
    await expect(reg.setSuggestedPrompts('ghost', 'p', [])).resolves.toBeUndefined();
    expect(bare.titles).toEqual([]);
  });
});

describe('getChannelDefaults / hasDeclaredChannelDefaults tiers', () => {
  it('fallbackChannelDefaults mirrors the raw thread capability in both contexts', async () => {
    const reg = await loadRegistry();
    const on = reg.fallbackChannelDefaults(true);
    const off = reg.fallbackChannelDefaults(false);
    expect(on.dm.threads).toBe(true);
    expect(on.group.threads).toBe(true);
    expect(off.dm.threads).toBe(false);
    expect(off.group.threads).toBe(false);
    expect(on.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', unknownSenderPolicy: 'request_approval' });
    expect(on.group).toMatchObject({ engageMode: 'mention-sticky', unknownSenderPolicy: 'request_approval' });
    expect(on.mentions).toBe('platform');
  });

  it('tier 1: live adapter under the exact key with a declaration', async () => {
    const reg = await loadRegistry();
    const decl = makeDefaults('live-exact');
    reg.registerChannelAdapter('slack', { factory: () => makeAdapter('slack', { defaults: decl }) });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getChannelDefaults('slack')).toBe(decl);
    expect(reg.hasDeclaredChannelDefaults('slack')).toBe(true);
  });

  it('tier 2: live adapter found by scanning channelType when the key is a dead named instance', async () => {
    const reg = await loadRegistry();
    const decl = makeDefaults('live-scan');
    reg.registerChannelAdapter('slack-two', {
      factory: () => makeAdapter('slack', { instance: 'slack-two', defaults: decl }),
    });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getChannelDefaults('slack')).toBe(decl);
    expect(reg.hasDeclaredChannelDefaults('slack')).toBe(true);
  });

  it('tier 3: registration under the key when the live adapter has no declaration', async () => {
    const reg = await loadRegistry();
    const regDecl = makeDefaults('registration');
    reg.registerChannelAdapter('slack', {
      factory: () => makeAdapter('slack', { supportsThreads: true }),
      defaults: regDecl,
    });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getChannelDefaults('slack')).toBe(regDecl);
    expect(reg.hasDeclaredChannelDefaults('slack')).toBe(true);
  });

  it('tier 4a: registration under the live adapter channelType (stale named instance copy)', async () => {
    const reg = await loadRegistry();
    const platformDecl = makeDefaults('platform');
    reg.registerChannelAdapter('slack', { factory: () => null, defaults: platformDecl });
    reg.registerChannelAdapter('slack-two', { factory: () => makeAdapter('slack', { instance: 'slack-two' }) });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getChannelDefaults('slack-two')).toBe(platformDecl);
    expect(reg.hasDeclaredChannelDefaults('slack-two')).toBe(true);
  });

  it('tier 4b: registration under the channelType hint when no adapter is live', async () => {
    const reg = await loadRegistry();
    const platformDecl = makeDefaults('hint');
    reg.registerChannelAdapter('slack', { factory: () => null, defaults: platformDecl });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getChannelDefaults('slack-dead', 'slack')).toBe(platformDecl);
    expect(reg.hasDeclaredChannelDefaults('slack-dead', 'slack')).toBe(true);
    // Without the hint there is nothing to resolve against.
    expect(reg.hasDeclaredChannelDefaults('slack-dead')).toBe(false);
  });

  it('tier 5: fallback on the live capability, or threads:false when nothing is live', async () => {
    const reg = await loadRegistry();
    reg.registerChannelAdapter('slack', { factory: () => makeAdapter('slack', { supportsThreads: true }) });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.hasDeclaredChannelDefaults('slack')).toBe(false);
    expect(reg.getChannelDefaults('slack')).toEqual(reg.fallbackChannelDefaults(true));
    expect(reg.getChannelDefaults('unknown-platform')).toEqual(reg.fallbackChannelDefaults(false));
    expect(reg.getChannelDefaults('unknown-platform', 'still-unknown')).toEqual(reg.fallbackChannelDefaults(false));
  });
});

describe('initChannelAdapters — failure, retry and duplicate handling', () => {
  it('logs and skips a null factory, keeps booting the rest', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const ok = makeAdapter('beta');
    reg.registerChannelAdapter('alpha', { factory: () => null });
    reg.registerChannelAdapter('beta', { factory: () => ok });
    await reg.initChannelAdapters(mockSetup);
    expect(warn).toHaveBeenCalledWith('Channel credentials missing, skipping', { channel: 'alpha' });
    expect(reg.getActiveAdapters()).toEqual([ok]);
  });

  it('a non-network setup failure is logged, the adapter stays inactive, later adapters still start', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const boom = new Error('bad token');
    const broken = makeAdapter('alpha', {
      setup: async () => {
        throw boom;
      },
    });
    const ok = makeAdapter('beta');
    reg.registerChannelAdapter('alpha', { factory: () => broken });
    reg.registerChannelAdapter('beta', { factory: () => ok });
    await reg.initChannelAdapters(mockSetup);
    expect(error).toHaveBeenCalledWith('Failed to start channel adapter', { channel: 'alpha', err: boom });
    expect(reg.getChannelAdapterExact('alpha')).toBeUndefined();
    expect(reg.getChannelAdapterExact('beta')).toBe(ok);
  });

  it('a factory that throws is caught by the same guard', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    reg.registerChannelAdapter('alpha', {
      factory: () => {
        throw new Error('factory exploded');
      },
    });
    await reg.initChannelAdapters(mockSetup);
    expect(error).toHaveBeenCalledWith('Failed to start channel adapter', {
      channel: 'alpha',
      err: expect.objectContaining({ message: 'factory exploded' }),
    });
    expect(reg.getActiveAdapters()).toEqual([]);
  });

  it('retries setup on NetworkError with the 2s/5s/10s schedule and then starts', async () => {
    vi.useFakeTimers();
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let attempts = 0;
    const flaky = makeAdapter('alpha', {
      setup: async () => {
        attempts += 1;
        if (attempts <= 3) {
          const err = new Error(`hiccup ${attempts}`);
          err.name = 'NetworkError';
          throw err;
        }
      },
    });
    reg.registerChannelAdapter('alpha', { factory: () => flaky });

    const pending = reg.initChannelAdapters(mockSetup);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10000);
    await pending;

    expect(attempts).toBe(4);
    expect(warn.mock.calls.map((c) => c[1])).toEqual([
      { channel: 'alpha', attempt: 1, delayMs: 2000, err: 'hiccup 1' },
      { channel: 'alpha', attempt: 2, delayMs: 5000, err: 'hiccup 2' },
      { channel: 'alpha', attempt: 3, delayMs: 10000, err: 'hiccup 3' },
    ]);
    expect(reg.getChannelAdapterExact('alpha')).toBe(flaky);
  });

  it('gives up after the retry schedule is exhausted (fourth NetworkError is fatal for that adapter)', async () => {
    vi.useFakeTimers();
    const reg = await loadRegistry();
    const log = await loadLog();
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    let attempts = 0;
    const dead = makeAdapter('alpha', {
      setup: async () => {
        attempts += 1;
        const err = new Error('always down');
        err.name = 'NetworkError';
        throw err;
      },
    });
    reg.registerChannelAdapter('alpha', { factory: () => dead });

    const pending = reg.initChannelAdapters(mockSetup);
    await vi.advanceTimersByTimeAsync(17000);
    await pending;

    expect(attempts).toBe(4);
    expect(error).toHaveBeenCalledWith('Failed to start channel adapter', {
      channel: 'alpha',
      err: expect.objectContaining({ name: 'NetworkError' }),
    });
    expect(reg.getChannelAdapterExact('alpha')).toBeUndefined();
  });

  it('warns on a duplicate instance key and keeps the last adapter (last-write-wins, visibly)', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const first = makeAdapter('slack', { instance: 'slack-two' });
    const second = makeAdapter('slack', { instance: 'slack-two' });
    reg.registerChannelAdapter('reg-a', { factory: () => first });
    reg.registerChannelAdapter('reg-b', { factory: () => second });
    await reg.initChannelAdapters(mockSetup);
    expect(warn).toHaveBeenCalledWith('Duplicate adapter instance key — overwriting previous adapter', {
      key: 'slack-two',
      channel: 'reg-b',
    });
    expect(reg.getChannelAdapterExact('slack-two')).toBe(second);
    expect(reg.getActiveAdapters()).toHaveLength(1);
  });
});

describe('teardownChannelAdapters', () => {
  it('tears every adapter down, logs a failing teardown, and always clears the active map', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    let goodTorn = 0;
    const good = makeAdapter('alpha', {
      teardown: async () => {
        goodTorn += 1;
      },
    });
    const boom = new Error('cannot stop');
    const bad = makeAdapter('beta', {
      teardown: async () => {
        throw boom;
      },
    });
    reg.registerChannelAdapter('alpha', { factory: () => good });
    reg.registerChannelAdapter('beta', { factory: () => bad });
    await reg.initChannelAdapters(mockSetup);
    expect(reg.getActiveAdapters()).toHaveLength(2);

    await reg.teardownChannelAdapters();
    expect(goodTorn).toBe(1);
    expect(info).toHaveBeenCalledWith('Channel adapter stopped', { channel: 'alpha' });
    expect(error).toHaveBeenCalledWith('Failed to stop channel adapter', { channel: 'beta', err: boom });
    expect(reg.getActiveAdapters()).toEqual([]);
  });
});

describe('startChannelAdapter — remaining hot-start paths', () => {
  it('guards: already-active, unknown registration, not-yet-booted, and null factory', async () => {
    const reg = await loadRegistry();
    reg.registerChannelAdapter('slack', { factory: () => makeAdapter('slack') });
    await expect(reg.startChannelAdapter('slack')).rejects.toThrow(
      'startChannelAdapter: initChannelAdapters has not run',
    );
    await reg.initChannelAdapters(mockSetup);
    await expect(reg.startChannelAdapter('slack')).resolves.toBe('already-active');
    await expect(reg.startChannelAdapter('ghost')).rejects.toThrow("startChannelAdapter: no registration for 'ghost'");
    reg.registerChannelAdapter('nocreds', { factory: () => null });
    await expect(reg.startChannelAdapter('nocreds')).resolves.toBe('no-credentials');
  });

  it('rethrows a non-network setup failure and leaves the key inactive', async () => {
    const reg = await loadRegistry();
    await reg.initChannelAdapters(mockSetup);
    const broken = makeAdapter('slack', {
      instance: 'slack-hot',
      setup: async () => {
        throw new Error('bad token');
      },
    });
    reg.registerChannelAdapter('slack-hot', { factory: () => broken });
    await expect(reg.startChannelAdapter('slack-hot')).rejects.toThrow('bad token');
    expect(reg.getChannelAdapterExact('slack-hot')).toBeUndefined();
  });

  it('exhausts the NetworkError schedule and then rethrows', async () => {
    vi.useFakeTimers();
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    await reg.initChannelAdapters(mockSetup);
    let attempts = 0;
    const dead = makeAdapter('slack', {
      instance: 'slack-hot',
      setup: async () => {
        attempts += 1;
        const err = new Error('down');
        err.name = 'NetworkError';
        throw err;
      },
    });
    reg.registerChannelAdapter('slack-hot', { factory: () => dead });

    const pending = reg.startChannelAdapter('slack-hot');
    const settled = pending.then(
      () => 'resolved',
      (err: Error) => err,
    );
    await vi.advanceTimersByTimeAsync(17000);
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).name).toBe('NetworkError');
    expect(attempts).toBe(4);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Hot-start adapter setup failed with network error, retrying',
      'Hot-start adapter setup failed with network error, retrying',
      'Hot-start adapter setup failed with network error, retrying',
    ]);
  });

  it('warns when the hot-started adapter lands on an already-active key (registry key ≠ instance key)', async () => {
    const reg = await loadRegistry();
    const log = await loadLog();
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const original = makeAdapter('slack', { instance: 'slack-two' });
    reg.registerChannelAdapter('slack-two', { factory: () => original });
    await reg.initChannelAdapters(mockSetup);

    // Registered under a different registry key but declaring the same instance.
    const imposter = makeAdapter('slack', { instance: 'slack-two' });
    reg.registerChannelAdapter('slack-two-again', { factory: () => imposter });
    await expect(reg.startChannelAdapter('slack-two-again')).resolves.toBe('started');
    expect(warn).toHaveBeenCalledWith('Duplicate adapter instance key — overwriting previous adapter', {
      key: 'slack-two',
      channel: 'slack-two-again',
    });
    expect(reg.getChannelAdapterExact('slack-two')).toBe(imposter);
  });
});

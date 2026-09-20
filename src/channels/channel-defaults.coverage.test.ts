/**
 * Coverage-uplift tests for validateEngageAgainstChannel's mention arms:
 * the pattern-without-pattern rejection, mention modes on a channel that
 * declares mentions 'never', the mention-sticky → mention coercion when the
 * effective thread policy is off (declared or explicit), and the lenient
 * paths for undeclared adapters and non-mention modes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDefaults } from './adapter.js';
import type { MessagingGroup } from '../types.js';

function makeMg(channelType: string, isGroup = false, instance?: string): MessagingGroup {
  return {
    id: 'mg-cov',
    channel_type: channelType,
    instance,
    platform_id: `${channelType}:@me:owner`,
    name: 'Owner DM',
    is_group: isGroup ? 1 : 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  } as MessagingGroup;
}

function decl(opts: {
  mentions: ChannelDefaults['mentions'];
  dmThreads: boolean;
  groupThreads: boolean;
}): ChannelDefaults {
  return {
    dm: { engageMode: 'pattern', engagePattern: '.', threads: opts.dmThreads, unknownSenderPolicy: 'public' },
    group: { engageMode: 'mention-sticky', threads: opts.groupThreads, unknownSenderPolicy: 'strict' },
    mentions: opts.mentions,
  };
}

async function withDeclaration(key: string, defaults?: ChannelDefaults) {
  const reg = await import('./channel-registry.js');
  reg.registerChannelAdapter(key, { factory: () => null, ...(defaults ? { defaults } : {}) });
  const mod = await import('./channel-defaults.js');
  const { log } = await import('../log.js');
  return { ...mod, log };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  const { teardownChannelAdapters } = await import('./channel-registry.js');
  await teardownChannelAdapters();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('resolveWiringDefaults — declaration errors', () => {
  it('names the group context when a group declaration says pattern without a pattern', async () => {
    const { resolveWiringDefaults } = await withDeclaration('mock', {
      dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
      group: { engageMode: 'pattern', threads: true, unknownSenderPolicy: 'strict' },
      mentions: 'platform',
    });
    expect(() => resolveWiringDefaults('mock', true, 'Andy')).toThrow(
      /Channel 'mock' declares engageMode 'pattern' without an engagePattern \(group context\)/,
    );
    expect(resolveWiringDefaults('mock', false, 'Andy')).toMatchObject({ engage_mode: 'pattern', engage_pattern: '.' });
  });
});

describe('validateEngageAgainstChannel — mention arms', () => {
  it("rejects engage_mode 'pattern' with an undefined, null or empty pattern", async () => {
    const { validateEngageAgainstChannel } = await withDeclaration('mock');
    for (const engage_pattern of [undefined, null, '']) {
      expect(() => validateEngageAgainstChannel({ engage_mode: 'pattern', engage_pattern }, makeMg('mock'))).toThrow(
        /engage_mode 'pattern' requires --engage-pattern/,
      );
    }
    expect(() =>
      validateEngageAgainstChannel({ engage_mode: 'pattern', engage_pattern: '.' }, makeMg('mock')),
    ).not.toThrow();
  });

  it('non-mention modes and undeclared channels pass without consulting the declaration', async () => {
    const { validateEngageAgainstChannel } = await withDeclaration('mock');
    expect(() =>
      validateEngageAgainstChannel({ engage_mode: 'pattern', engage_pattern: 'x' }, makeMg('mock')),
    ).not.toThrow();
    expect(() => validateEngageAgainstChannel({}, makeMg('mock'))).not.toThrow();
    // Undeclared (stale) adapter: mention modes stay lenient.
    const w = { engage_mode: 'mention-sticky', threads: 0 };
    expect(() => validateEngageAgainstChannel(w, makeMg('mock'))).not.toThrow();
    expect(w.engage_mode).toBe('mention-sticky');
  });

  it("rejects mention and mention-sticky on a channel declaring mentions 'never'", async () => {
    const { validateEngageAgainstChannel } = await withDeclaration(
      'quiet',
      decl({ mentions: 'never', dmThreads: true, groupThreads: true }),
    );
    expect(() => validateEngageAgainstChannel({ engage_mode: 'mention' }, makeMg('quiet'))).toThrow(
      /engage_mode 'mention' can never engage on channel 'quiet'/,
    );
    expect(() => validateEngageAgainstChannel({ engage_mode: 'mention-sticky' }, makeMg('quiet', true))).toThrow(
      /engage_mode 'mention-sticky' can never engage on channel 'quiet'/,
    );
  });

  it('coerces mention-sticky to mention (with a warning) when the inherited thread policy is off', async () => {
    const { validateEngageAgainstChannel, log } = await withDeclaration(
      'mock',
      decl({ mentions: 'platform', dmThreads: false, groupThreads: true }),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    // DM context declares threads:false → coerced (NULL and undefined both inherit).
    const nullInherit = { engage_mode: 'mention-sticky', threads: null };
    validateEngageAgainstChannel(nullInherit, makeMg('mock'));
    expect(nullInherit.engage_mode).toBe('mention');
    const undefinedInherit = { engage_mode: 'mention-sticky' };
    validateEngageAgainstChannel(undefinedInherit, makeMg('mock'));
    expect(undefinedInherit.engage_mode).toBe('mention');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith('mention-sticky requires thread ids — coerced to mention', {
      channel: 'mock',
      messagingGroupId: 'mg-cov',
    });

    // Group context declares threads:true → sticky survives.
    const group = { engage_mode: 'mention-sticky' };
    validateEngageAgainstChannel(group, makeMg('mock', true));
    expect(group.engage_mode).toBe('mention-sticky');

    // Plain 'mention' never needs threads.
    const plain = { engage_mode: 'mention' };
    validateEngageAgainstChannel(plain, makeMg('mock'));
    expect(plain.engage_mode).toBe('mention');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('an explicit threads flag overrides the declaration in both directions', async () => {
    const { validateEngageAgainstChannel, log } = await withDeclaration(
      'mock',
      decl({ mentions: 'platform', dmThreads: false, groupThreads: true }),
    );
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const optIn = { engage_mode: 'mention-sticky', threads: 1 };
    validateEngageAgainstChannel(optIn, makeMg('mock'));
    expect(optIn.engage_mode).toBe('mention-sticky');

    const optOut = { engage_mode: 'mention-sticky', threads: 0 };
    validateEngageAgainstChannel(optOut, makeMg('mock', true));
    expect(optOut.engage_mode).toBe('mention');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("names the group context when session_mode 'per-thread' inherits a threads:false group declaration", async () => {
    const { validateEngageAgainstChannel } = await withDeclaration(
      'mock',
      decl({ mentions: 'platform', dmThreads: true, groupThreads: false }),
    );
    expect(() => validateEngageAgainstChannel({ session_mode: 'per-thread' }, makeMg('mock', true))).toThrow(
      /declares threads: false for its group context/,
    );
    expect(() => validateEngageAgainstChannel({ session_mode: 'per-thread' }, makeMg('mock'))).not.toThrow();
  });

  it('resolves a dead named instance through the platform declaration (mg.instance + channel_type)', async () => {
    const { validateEngageAgainstChannel } = await withDeclaration(
      'quiet',
      decl({ mentions: 'never', dmThreads: true, groupThreads: true }),
    );
    expect(() => validateEngageAgainstChannel({ engage_mode: 'mention' }, makeMg('quiet', false, 'quiet-two'))).toThrow(
      /can never engage on channel 'quiet-two'/,
    );
  });
});

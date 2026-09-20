import { describe, expect, it } from 'vitest';

import {
  CHANNEL_AUTH_REGISTRY,
  generateId,
  inferIsGroup,
  JID_PREFIX_TO_CHANNEL,
  parseJid,
  triggerToEngage,
  v2PlatformId,
} from './shared.js';

describe('parseJid', () => {
  it('classifies WhatsApp (Baileys) JID hosts without any prefix', () => {
    expect(parseJid('1234@s.whatsapp.net')).toEqual({
      raw: '1234@s.whatsapp.net',
      prefix: 'whatsapp',
      id: '1234@s.whatsapp.net',
      channel_type: 'whatsapp',
    });
    expect(parseJid('grp@g.us')?.channel_type).toBe('whatsapp');
    expect(parseJid('x@lid')?.channel_type).toBe('whatsapp');
    expect(parseJid('x@broadcast')?.channel_type).toBe('whatsapp');
    expect(parseJid('x@newsletter')?.channel_type).toBe('whatsapp');
    // host casing is normalized
    expect(parseJid('x@S.WHATSAPP.NET')?.channel_type).toBe('whatsapp');
  });

  it('returns null when there is no @ and no colon', () => {
    expect(parseJid('nothingrecognizable')).toBeNull();
  });

  it('returns null when colon prefix or id half is empty', () => {
    expect(parseJid(':novalue')).toBeNull();
    expect(parseJid('noprefix:')).toBeNull();
  });

  it('maps known prefixes to their v2 channel_type, case-insensitively', () => {
    expect(parseJid('DC:12345')).toEqual({ raw: 'DC:12345', prefix: 'dc', id: '12345', channel_type: 'discord' });
    expect(parseJid('tg:99')?.channel_type).toBe('telegram');
    expect(parseJid('mx:room1')?.channel_type).toBe('matrix');
  });

  it('passes an unknown prefix through as-is for the channel_type', () => {
    expect(parseJid('mystery:abc')).toEqual({
      raw: 'mystery:abc',
      prefix: 'mystery',
      id: 'abc',
      channel_type: 'mystery',
    });
  });

  it('exposes every declared prefix mapping', () => {
    expect(JID_PREFIX_TO_CHANNEL.slack).toBe('slack');
    expect(JID_PREFIX_TO_CHANNEL.im).toBe('imessage');
  });
});

describe('v2PlatformId', () => {
  it('passes a raw WA-host JID through unchanged for whatsapp', () => {
    expect(v2PlatformId('whatsapp', '1234@g.us')).toBe('1234@g.us');
  });

  // The docstring on v2PlatformId claims it strips a v1 "wa:"/"whatsapp:"
  // prefix, but isWhatsappJid() classifies by the JID's @-host alone: any
  // leading "wa:"/"whatsapp:" text is part of `id` (== `raw`) and is NOT
  // stripped when the JID already carries a recognized WA host. Documented
  // here as observed behavior, not fixed (see final report).
  it('does not actually strip a leading "wa:"/"whatsapp:" text when the JID has a WA host', () => {
    expect(v2PlatformId('whatsapp', 'wa:1234@s.whatsapp.net')).toBe('wa:1234@s.whatsapp.net');
  });

  it('falls back to the raw jid for whatsapp when parseJid cannot classify it', () => {
    // No @ and no colon — parseJid returns null, so v2PlatformId uses jid verbatim.
    expect(v2PlatformId('whatsapp', 'bareid')).toBe('bareid');
  });

  it('prefixes other channel types with "<channel>:" when not already present', () => {
    expect(v2PlatformId('telegram', 'tg:555')).toBe('telegram:555');
  });

  it('leaves the id untouched when it already starts with "<channel>:"', () => {
    // parseJid splits on the FIRST colon, so the parsed id here is
    // 'custom:bar' — which already starts with the passed-in channelType
    // prefix, exercising the "already prefixed" branch.
    expect(v2PlatformId('custom', 'foo:custom:bar')).toBe('custom:bar');
  });

  it('uses the raw jid as id when parseJid fails for a non-whatsapp channel', () => {
    expect(v2PlatformId('custom', 'bareid')).toBe('custom:bareid');
  });
});

describe('inferIsGroup', () => {
  it('whatsapp: @g.us is a group, everything else is a DM', () => {
    expect(inferIsGroup('whatsapp', '123@g.us')).toBe(1);
    expect(inferIsGroup('whatsapp', '123@s.whatsapp.net')).toBe(0);
  });

  it('telegram: negative chat ids are groups, positive are DMs', () => {
    expect(inferIsGroup('telegram', 'telegram:-100123')).toBe(1);
    expect(inferIsGroup('telegram', 'telegram:100123')).toBe(0);
  });

  it('defaults every other channel to group/channel (1)', () => {
    expect(inferIsGroup('slack', 'slack:C123')).toBe(1);
  });
});

describe('triggerToEngage', () => {
  it('treats "." or ".*" patterns as respond-to-everything regardless of requires_trigger', () => {
    expect(triggerToEngage({ trigger_pattern: '.', requires_trigger: 1 })).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
    expect(triggerToEngage({ trigger_pattern: '.*', requires_trigger: 1 })).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
  });

  it('requires_trigger=0 means respond to everything regardless of pattern', () => {
    expect(triggerToEngage({ trigger_pattern: 'hey bot', requires_trigger: 0 })).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
    expect(triggerToEngage({ trigger_pattern: null, requires_trigger: 0 })).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '.',
    });
  });

  it('keeps a real pattern when requires_trigger is truthy', () => {
    expect(triggerToEngage({ trigger_pattern: '^bot', requires_trigger: 1 })).toEqual({
      engage_mode: 'pattern',
      engage_pattern: '^bot',
    });
  });

  it('falls back to mention mode with no pattern and requires_trigger non-zero', () => {
    expect(triggerToEngage({ trigger_pattern: null, requires_trigger: 1 })).toEqual({
      engage_mode: 'mention',
      engage_pattern: null,
    });
    // Blank/whitespace-only pattern also counts as "no pattern".
    expect(triggerToEngage({ trigger_pattern: '   ', requires_trigger: null })).toEqual({
      engage_mode: 'mention',
      engage_pattern: null,
    });
  });

  it('treats requires_trigger=null as "requires trigger" (not 0)', () => {
    expect(triggerToEngage({ trigger_pattern: 'ping', requires_trigger: null })).toEqual({
      engage_mode: 'pattern',
      engage_pattern: 'ping',
    });
  });
});

describe('generateId', () => {
  it('prefixes and produces distinct ids across calls', () => {
    const a = generateId('ag');
    const b = generateId('ag');
    expect(a).toMatch(/^ag-\d+-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });
});

describe('CHANNEL_AUTH_REGISTRY', () => {
  it('declares an entry for every channel select-channels.ts offers', () => {
    for (const name of ['discord', 'telegram', 'whatsapp', 'matrix', 'slack', 'teams', 'imessage', 'webex', 'gchat']) {
      expect(CHANNEL_AUTH_REGISTRY[name]).toBeDefined();
    }
  });

  it('shapes each spec with the expected fields', () => {
    expect(CHANNEL_AUTH_REGISTRY.discord.v1EnvKeys).toContain('DISCORD_BOT_TOKEN');
    expect(CHANNEL_AUTH_REGISTRY.discord.requiredV2Keys[0]).toEqual({
      key: 'DISCORD_BOT_TOKEN',
      where: expect.any(String),
    });
    expect(CHANNEL_AUTH_REGISTRY.whatsapp.candidatePaths.length).toBeGreaterThan(0);
    expect(CHANNEL_AUTH_REGISTRY.slack.candidatePaths).toEqual([]);
  });
});

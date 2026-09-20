import { describe, expect, it } from 'vitest';

import { namespacedPlatformId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('returns an already-prefixed Chat SDK id unchanged', () => {
    expect(namespacedPlatformId('telegram', 'telegram:123456')).toBe('telegram:123456');
    expect(namespacedPlatformId('discord', 'discord:guild:chan')).toBe('discord:guild:chan');
  });

  it('leaves JID/email-shaped native ids (WhatsApp, iMessage) untouched', () => {
    expect(namespacedPlatformId('whatsapp', '15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(namespacedPlatformId('imessage', 'someone@example.com')).toBe('someone@example.com');
  });

  it('leaves Signal phone-number DMs and group ids untouched', () => {
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('signal', 'group:abc123')).toBe('group:abc123');
  });

  it('never prefixes DeltaChat numeric chat ids', () => {
    expect(namespacedPlatformId('deltachat', '12')).toBe('12');
  });

  it('prefixes everything else with the channel type', () => {
    expect(namespacedPlatformId('telegram', '123456')).toBe('telegram:123456');
    expect(namespacedPlatformId('slack', 'C0123')).toBe('slack:C0123');
  });

  it('does not treat a different channel prefix as already namespaced', () => {
    // "slack:" is not "telegram:" — the raw id gets the telegram prefix.
    expect(namespacedPlatformId('telegram', 'slack:C0123')).toBe('telegram:slack:C0123');
  });
});

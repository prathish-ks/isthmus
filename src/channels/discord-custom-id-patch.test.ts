import { describe, expect, it } from 'vitest';
import { decodeDiscordCustomId, encodeDiscordCustomId } from '@chat-adapter/discord';

// Guards the pnpm patch in patches/@chat-adapter__discord@4.29.0.patch.
// Before the patch, encodeDiscordCustomId/decodeDiscordCustomId joined and
// split actionId/value on a bare "\n" with no escaping — a value already
// containing "\n" (observed live as a doubled "0\n0") decoded into the
// wrong value silently instead of erroring, which broke NanoClaw's
// approval-card response handlers (both the channel-registration and
// unknown-sender flows) with no diagnostic. If this test ever goes red
// after a dependency bump, the patch likely didn't survive the bump —
// see that patch file's own header comment for the full mechanism.
describe('@chat-adapter/discord custom_id encode/decode (patched)', () => {
  it('round-trips a value that itself contains the delimiter', () => {
    const encoded = encodeDiscordCustomId('ncq:q1:0', '0\n0');
    const decoded = decodeDiscordCustomId(encoded);
    expect(decoded.actionId).toBe('ncq:q1:0');
    expect(decoded.value).toBe('0\n0');
  });

  it('never loses data when an already-encoded string is encoded again', () => {
    // Not a claim about the exact production trigger (unconfirmed) — just
    // the general robustness property the patch buys: nesting an
    // already-delimiter-joined string as a new actionId still round-trips
    // exactly, rather than silently colliding with the outer join like it
    // did before the patch (observed live as a doubled "0\n0" value).
    const preEncoded = encodeDiscordCustomId('ncq:q1:0', '0');
    const encoded = encodeDiscordCustomId(preEncoded, '0');
    const decoded = decodeDiscordCustomId(encoded);
    expect(decoded.actionId).toBe(preEncoded);
    expect(decoded.value).toBe('0');
  });

  it('still round-trips the ordinary case with no special characters', () => {
    const encoded = encodeDiscordCustomId('ncq:q1:0', '0');
    const decoded = decodeDiscordCustomId(encoded);
    expect(decoded.actionId).toBe('ncq:q1:0');
    expect(decoded.value).toBe('0');
  });

  it('round-trips a value containing a literal backslash', () => {
    const encoded = encodeDiscordCustomId('ncq:q1:0', 'a\\b');
    const decoded = decodeDiscordCustomId(encoded);
    expect(decoded.value).toBe('a\\b');
  });

  it('leaves a value-less actionId with no delimiter untouched', () => {
    const encoded = encodeDiscordCustomId('ncq:q1:0', undefined);
    expect(encoded).toBe('ncq:q1:0');
    const decoded = decodeDiscordCustomId(encoded);
    expect(decoded.actionId).toBe('ncq:q1:0');
    expect(decoded.value).toBeUndefined();
  });
});

/**
 * Branch-only top-up for discord-resolver.ts (line coverage is already
 * 100% per the existing discord-resolver.test.ts). Targets:
 *  - the `err instanceof Error ? err.message : String(err)` ternary's
 *    false branch (a non-Error thrown value) at both catch sites, and
 *  - the default `fetchImpl = fetch` parameter path (never exercised when
 *    every existing test passes an explicit fetchImpl).
 */
import { describe, expect, it, vi } from 'vitest';

import { buildDiscordResolver } from './discord-resolver.js';

describe('buildDiscordResolver — non-Error throws', () => {
  it('stringifies a non-Error thrown value when listing guilds fails', async () => {
    const fetchImpl = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'raw string failure';
    }) as unknown as typeof fetch;

    const r = await buildDiscordResolver('token', [], fetchImpl);
    expect(r.stats().reason).toBe('failed to list guilds: raw string failure');
  });

  it('stringifies a non-Error thrown value when per-guild channel enumeration fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/users/@me/guilds')) {
        return new Response(JSON.stringify([{ id: 'g1', name: 'G1' }]), { status: 200 });
      }
      if (url.includes('/guilds/g1/channels')) {
        // eslint-disable-next-line no-throw-literal
        throw { weird: 'not an Error instance' };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const r = await buildDiscordResolver('token', [], fetchImpl);

    expect(r.stats()).toEqual({ guilds: 1, channels: 0, dms: 0 });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[object Object]'));
    errSpy.mockRestore();
  });
});

describe('buildDiscordResolver — default fetch parameter', () => {
  it('uses the global fetch when no fetchImpl is passed', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify([{ id: 'g1', name: 'G1' }]), { status: 200 }));
    vi.stubGlobal('fetch', fakeFetch);
    try {
      // No third argument — exercises the `fetchImpl: FetchFn = fetch` default.
      const r = await buildDiscordResolver('token');
      expect(r.stats().guilds).toBe(1);
      expect(fakeFetch).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

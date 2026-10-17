import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readOpenCodeOAuth,
  buildOpenCodeLoginArgs,
  discoverLocalModelIds,
  normalizeOptionalInput,
  runOpenCodeAuthCli,
  runOpenCodeChatGptAuth,
} from './opencode-auth.js';
// checkOpenCodeInstall() itself is kept (ported as-is in opencode-auth.ts),
// but its own upstream test suite ("OpenCode installation declarations",
// dropped here) is tightly coupled to upstream's exact SKILL.md shape —
// a fixed version pin, no `from-branch:` copy directives, specific barrel
// paths. Isthmus's SKILL.md differs on all three; re-deriving a faithful
// equivalent test needs its own pass against skill-apply.ts's actual
// directive semantics, not a quick adaptation. checkOpenCodeInstall()'s
// own behavior is still exercised for real by the skill's "nc:run
// effect:test" step once /add-opencode is actually applied.

const proc = vi.hoisted(() => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => proc.execFileSync(...args),
    spawn: (...args: unknown[]) => proc.spawn(...args),
  };
});

describe('OpenCode setup payload', () => {
  it('accepts a blank optional API key for a keyless local endpoint', () => {
    expect(normalizeOptionalInput(undefined)).toBe('');
    expect(normalizeOptionalInput('  local-key  ')).toBe('local-key');
  });

  it('discovers, trims, sorts, and deduplicates OpenAI-compatible model ids', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'qwen-b' }, { id: ' qwen-a ' }, { id: 'qwen-b' }, {}] })),
    );

    await expect(
      discoverLocalModelIds('http://host.docker.internal:8891/v1/', fetchImpl, undefined, 'darwin'),
    ).resolves.toEqual(['qwen-a', 'qwen-b']);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8891/v1/models'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('lists a Linux model from the Docker bridge gateway, where containers reach host.docker.internal', async () => {
    proc.execFileSync.mockReturnValueOnce('172.18.0.1 \n');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'qwen' }] })));
    await expect(
      discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'linux'),
    ).resolves.toEqual(['qwen']);
    expect(proc.execFileSync).toHaveBeenCalledWith(
      expect.any(String),
      ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}'],
      expect.anything(),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(new URL('http://172.18.0.1:8000/v1/models'), expect.anything());
  });

  it('falls back to loopback on Linux when the bridge address is unreachable (Docker Desktop, WSL)', async () => {
    proc.execFileSync.mockReturnValueOnce('172.17.0.1');
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'qwen' }] })));
    await expect(
      discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'linux'),
    ).resolves.toEqual(['qwen']);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'http://172.17.0.1:8000/v1/models',
      'http://127.0.0.1:8000/v1/models',
    ]);
  });

  it('also falls back when the bridge address is silent until the timeout', async () => {
    proc.execFileSync.mockReturnValueOnce('172.17.0.1');
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'qwen' }] })));
    await expect(
      discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'linux'),
    ).resolves.toEqual(['qwen']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a redirect', Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') })],
    [
      'a TLS or protocol error',
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }),
    ],
  ])('treats %s from the bridge address as its answer', async (_label, failure) => {
    proc.execFileSync.mockReturnValueOnce('172.17.0.1');
    const fetchImpl = vi.fn().mockRejectedValueOnce(failure);
    await expect(
      discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'linux'),
    ).rejects.toThrow('fetch failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry after a broken body from a server that answered', async () => {
    proc.execFileSync.mockReturnValueOnce('172.17.0.1');
    const broken = new Response(null);
    vi.spyOn(broken, 'text').mockRejectedValue(new TypeError('terminated'));
    const fetchImpl = vi.fn().mockResolvedValueOnce(broken);
    await expect(
      discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'linux'),
    ).rejects.toThrow('terminated');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry another address after the server answered', async () => {
    proc.execFileSync.mockReturnValueOnce('172.17.0.1');
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, 'k', 'linux')).rejects.toThrow(
      'HTTP 401',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses loopback alone when Docker has no bridge information, and never asks Docker on macOS', async () => {
    proc.execFileSync.mockImplementationOnce(() => {
      throw new Error('docker: not found');
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    await discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'linux');
    expect(fetchImpl).toHaveBeenCalledWith(new URL('http://127.0.0.1:8000/v1/models'), expect.anything());
    proc.execFileSync.mockClear();
    await discoverLocalModelIds('http://host.docker.internal:8000/v1', fetchImpl, undefined, 'darwin');
    expect(proc.execFileSync).not.toHaveBeenCalled();
  });

  it('rejects malformed model discovery responses so the wizard can fall back to manual input', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
    await expect(discoverLocalModelIds('http://127.0.0.1:8891/v1', fetchImpl)).rejects.toThrow('no data array');
  });

  it('validates ChatGPT tokens independently of the selected gateway', () => {
    expect(
      readOpenCodeOAuth({
        openai: {
          type: 'oauth',
          access: 'live-access-token',
          refresh: 'live-refresh-token',
          expires: 1,
          accountId: 'account-123',
        },
      }),
    ).toEqual({
      profile: 'chatgpt',
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      accountId: 'account-123',
    });
  });

  it('refuses to vault a credential with no account id, which the gateway cannot route', () => {
    const base = { type: 'oauth', access: 'a', refresh: 'r' };
    expect(() => readOpenCodeOAuth({ openai: base })).toThrow('no account id');
    expect(() => readOpenCodeOAuth({ openai: { ...base, accountId: '  ' } })).toThrow('no account id');
  });

  it('refuses to vault a credential with no refresh token, which the gateway cannot renew', () => {
    expect(() => readOpenCodeOAuth({ openai: { type: 'oauth', access: 'a', accountId: 'account-123' } })).toThrow(
      'did not create an OpenAI OAuth credential',
    );
  });

  it('rejects API-key auth records instead of misrepresenting them as subscription OAuth', () => {
    expect(() => readOpenCodeOAuth({ openai: { type: 'api', key: 'sk-live' } })).toThrow(
      'did not create an OpenAI OAuth credential',
    );
  });

  it('runs the pinned container CLI with isolated XDG state for device pairing', () => {
    const args = buildOpenCodeLoginArgs('/tmp/login', 'device', false);
    expect(args).toContain('/tmp/login:/opencode-login');
    expect(args).toContain('XDG_DATA_HOME=/opencode-login/data');
    expect(args.slice(-6)).toEqual([
      'auth',
      'login',
      '--provider',
      'openai',
      '--method',
      'ChatGPT Pro/Plus (headless)',
    ]);
    expect(args).not.toContain('-t');
    expect(args).not.toContain('127.0.0.1:1455:1455');
  });

  it('matches a root-owned private login directory without blocking root installations', () => {
    const args = buildOpenCodeLoginArgs('/tmp/root-login', 'device', false, { uid: 0, gid: 0 });
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', '0:0']);
  });

  it('publishes only the native callback port for browser sign-in', () => {
    const args = buildOpenCodeLoginArgs('/tmp/login', 'browser', true);
    expect(args).toContain('127.0.0.1:1455:1455');
    expect(args).toContain('-t');
    expect(args.at(-1)).toBe('ChatGPT Pro/Plus (browser)');
  });

  // Upstream's own "keeps the verified runtime pin and trusted postinstall
  // together" test read its *own* repo's real container/cli-tools.json
  // directly — valid there because upstream bakes OpenCode in. Isthmus
  // deliberately does not ("Trunk ships with only the `claude` provider
  // baked in" — CLAUDE.md); container/cli-tools.json has no opencode-ai
  // entry until /add-opencode actually runs, so that premise doesn't carry
  // over. The real pin-consistency check still happens for real: the
  // skill's own `nc:run effect:test` step runs after `nc:copy`/`nc:dep`
  // have actually landed the files this test would otherwise read cold.
});

const fakeVault = (existing: { reusable: boolean } | null = { reusable: true }) => ({
  find: vi.fn(async () => existing),
  save: vi.fn(async () => {}),
  keep: vi.fn(async () => {}),
});

describe('ChatGPT vault recovery', () => {
  it('rejects unknown command options before changing state', async () => {
    await expect(runOpenCodeAuthCli(['--reauth', '--method', 'invalid'])).rejects.toThrow('Usage:');
  });
});

describe('ChatGPT credential lifecycle', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-login-test-'));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    proc.execFileSync.mockReset();
    proc.spawn.mockReset();
  });

  it('keeps a vaulted login through the real entry point without starting sign-in or changing state', async () => {
    const root = makeRoot();
    const env = 'OPENCODE_MODEL=openai/existing\n';
    fs.writeFileSync(path.join(root, '.env'), env);
    const vault = fakeVault();
    await runOpenCodeChatGptAuth('device', { root, vault });
    expect(proc.spawn).not.toHaveBeenCalled();
    expect(vault.find).toHaveBeenCalledTimes(1);
    expect(vault.keep).toHaveBeenCalledWith();
    expect(vault.save).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(['.env']);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(env);
  });

  it('reauthenticates a dead gateway connection even without --reauth', async () => {
    const vault = fakeVault({ reusable: false });
    const signIn = vi.fn(async () => {});
    await runOpenCodeChatGptAuth('device', { vault, signIn });
    expect(signIn).toHaveBeenCalledWith('device', process.cwd(), vault);
    expect(vault.keep).not.toHaveBeenCalled();
  });

  it('reauthenticates into the existing ID and does not rewrite defaults', async () => {
    const root = makeRoot();
    const env = 'OPENCODE_MODEL=openai/example\nOPENCODE_SMALL_MODEL=openai/small\n';
    fs.writeFileSync(path.join(root, '.env'), env);
    const vault = fakeVault();
    const signIn = vi.fn(async () => {});
    await runOpenCodeChatGptAuth('device', { root, vault, signIn, reauth: true });
    expect(signIn).toHaveBeenCalledWith('device', root, vault);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(env);
  });

  it('preserves defaults and starts no sign-in or vault write when the vault lookup fails', async () => {
    const root = makeRoot();
    const env = 'OPENCODE_MODEL=openai/existing\nOPENCODE_AUTH_MODE=chatgpt\n';
    fs.writeFileSync(path.join(root, '.env'), env);
    const vault = fakeVault();
    vault.find.mockRejectedValue(new Error('vault unavailable'));
    const signIn = vi.fn(async () => {});
    await expect(runOpenCodeChatGptAuth('device', { root, vault, signIn, reauth: true })).rejects.toThrow(
      'vault unavailable',
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(proc.spawn).not.toHaveBeenCalled();
    expect(vault.save).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(['.env']);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(env);
  });

  it.each(['success', 'save-failure', 'changed-entry', 'empty-access', 'blank-refresh', 'pending-save'])(
    'removes temporary native credentials and preserves state (%s)',
    async (outcome) => {
      const root = makeRoot();
      let loginDir = '';
      const vault = fakeVault();
      let finishSave: (() => void) | undefined;
      let observeSave: (() => void) | undefined;
      const saving = new Promise<void>((resolve) => {
        observeSave = resolve;
      });
      if (outcome === 'pending-save') {
        vault.save.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finishSave = resolve;
              observeSave!();
            }),
        );
      }
      if (outcome === 'save-failure') vault.save.mockRejectedValue(new Error('save failed'));
      // The gateway, not OpenCode, detects an entry that changed since the lookup.
      if (outcome === 'changed-entry') vault.save.mockRejectedValue(new Error('changed during setup'));
      proc.spawn.mockImplementation((_command: string, args: string[]) => {
        loginDir = args[args.indexOf('-v') + 1].split(':')[0];
        const authDir = path.join(loginDir, 'data', 'opencode');
        fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(
          path.join(authDir, 'auth.json'),
          JSON.stringify({
            openai: {
              type: 'oauth',
              access: outcome === 'empty-access' ? '' : 'access-fixture',
              refresh: outcome === 'blank-refresh' ? '  ' : 'refresh-fixture',
              accountId: 'account-fixture',
            },
          }),
        );
        const child = {
          on: (event: string, handler: (code: number) => void) => {
            if (event === 'close') queueMicrotask(() => handler(0));
            return child;
          },
        };
        return child;
      });
      const result = runOpenCodeChatGptAuth('device', { root, vault, reauth: true });
      if (outcome === 'pending-save') {
        await saving;
        try {
          expect(fs.existsSync(loginDir)).toBe(false);
        } finally {
          finishSave!();
          await result;
        }
      } else if (outcome === 'save-failure') await expect(result).rejects.toThrow('save failed');
      else if (outcome === 'changed-entry') await expect(result).rejects.toThrow('changed during setup');
      else if (outcome === 'empty-access' || outcome === 'blank-refresh')
        await expect(result).rejects.toThrow('did not create an OpenAI OAuth credential');
      else await result;
      expect(loginDir).not.toBe('');
      expect(fs.existsSync(loginDir)).toBe(false);
      if (['empty-access', 'blank-refresh'].includes(outcome)) expect(vault.save).not.toHaveBeenCalled();
      else
        expect(vault.save).toHaveBeenCalledWith({
          profile: 'chatgpt',
          accessToken: 'access-fixture',
          refreshToken: 'refresh-fixture',
          accountId: 'account-fixture',
        });
      expect(proc.execFileSync).not.toHaveBeenCalled();
    },
  );

  it('still runs sign-in when no vault secret exists', async () => {
    const root = makeRoot();
    const signIn = vi.fn(async () => {});

    await runOpenCodeChatGptAuth('browser', { root, vault: fakeVault(null), signIn });

    expect(signIn).toHaveBeenCalledWith('browser', root, expect.any(Object));
  });
});

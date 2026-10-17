import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getCredentialStore } from './credential-store.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env.NANOCLAW_GATEWAY_PROVIDER;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A fixture Iron Proxy credential-store script at the exact path
 * `getCredentialStore()` is hardcoded to dispatch 'iron-proxy' to — Isthmus
 * has no catalog to register an arbitrary gateway kind against, unlike
 * upstream's own version of this test.
 */
function ironCredentialStore(store: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-store-'));
  roots.push(root);
  const scripts = path.join(root, '.claude/skills/add-iron-proxy/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'credential-store.ts'), store);
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'iron-proxy';
  return root;
}

it('loads the selected gateway’s own credential-store script', async () => {
  const root = ironCredentialStore(
    'export function createCredentialStore(){return {has: async p=>p==="codex", save: async ()=>{}}}',
  );
  const store = await getCredentialStore(root);
  expect(await store.has('codex')).toBe(true);
  expect(store.connection).toBeUndefined();
  expect(store.modelEndpoint).toBeUndefined();
});

it('rejects a gateway that has no credential-store seam, naming OneCLI’s own vault flow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-store-'));
  roots.push(root);
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'onecli';
  await expect(getCredentialStore(root)).rejects.toThrow('onecli agents set-secrets');
});

it('rejects an unregistered gateway kind the same way', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-store-'));
  roots.push(root);
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'nonexistent';
  await expect(getCredentialStore(root)).rejects.toThrow('does not provide a credential store');
});

it('rejects iron-proxy selected but not actually installed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-store-'));
  roots.push(root);
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'iron-proxy';
  await expect(getCredentialStore(root)).rejects.toThrow('is not installed');
});

it('offers caller-described connections through the same store as provider-named credentials', async () => {
  const root = ironCredentialStore(`
    const calls = [];
    export function createCredentialStore() {
      return {
        has: async () => false,
        save: async () => {},
        modelEndpoint: (url) => ({ configure: async () => { calls.push(['endpoint', url]); } }),
        connection: (target) => ({
          find: async () => ({ reusable: target.kind === 'api-key' }),
          save: async (value) => { calls.push(['save', target.name, value]); },
          keep: async () => { calls.push(['keep', target.name]); },
        }),
        calls,
      };
    }`);
  const store = (await getCredentialStore(root)) as Awaited<ReturnType<typeof getCredentialStore>> & {
    calls: unknown[];
  };
  const key = store.connection!({
    name: 'provider-key',
    kind: 'api-key',
    host: 'models.example.test',
    proxyValue: 'nc-fixture-token',
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  });
  expect(await key.find()).toEqual({ reusable: true });
  await key.save('fixture');
  await key.keep();
  const login = store.connection!({
    name: 'provider-login',
    kind: 'oauth',
    host: 'chatgpt.com',
    proxyValue: 'nc-fixture-token',
    oauth: { profile: 'chatgpt', clientId: 'public', tokenEndpoint: 'https://auth.example.test/token' },
  });
  expect(await login.find()).toEqual({ reusable: false });
  await store.modelEndpoint!('https://models.example.test/v1').configure();
  expect(store.calls).toEqual([
    ['save', 'provider-key', 'fixture'],
    ['keep', 'provider-key'],
    ['endpoint', 'https://models.example.test/v1'],
  ]);
});

it.each([
  ['a connection that is not a function', 'connection: 1'],
  ['an endpoint hook that is not a function', 'modelEndpoint: "later"'],
])('rejects a gateway declaring %s', async (_label, extra) => {
  const root = ironCredentialStore(
    `export function createCredentialStore(){return {has: async()=>false, save: async()=>{}, ${extra}}}`,
  );
  await expect(getCredentialStore(root)).rejects.toThrow('invalid credential store');
});

it('rejects a half-implemented connection before the provider can call it', async () => {
  const root = ironCredentialStore(
    'export function createCredentialStore(){return {has: async()=>false, save: async()=>{}, connection: () => ({ find: async () => null })}}',
  );
  const store = await getCredentialStore(root);
  expect(() =>
    store.connection!({
      name: 'x',
      kind: 'api-key',
      host: 'models.example.test',
      proxyValue: 'nc-fixture-token',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    }),
  ).toThrow('invalid provider credential connection');
});

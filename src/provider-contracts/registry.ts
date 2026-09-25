/**
 * Provider gateway facts — install-wide, static per-provider data the
 * gateway seam needs: which HTTPS domains carry a provider's own model
 * traffic (exempt from an explicit approval hold), its credential-adapter
 * endpoints, and its declared inference-speed vocabulary.
 *
 * v2.4.0 promotion, Workstream C8 (ADR-030): deliberately NOT a port of
 * upstream's full `ProviderHostContract` (`src/provider-contracts/
 * registry.ts` there, 534 lines) — that type also carries a provider's
 * mount/file surface declarations (`stateVolumes`, `skillBackings`,
 * `skillViews`, `files`) and a `realizeProviderSpawnSurfaces` step that
 * REPLACES `container-runner.ts`'s existing `buildMounts`/
 * `ProviderContainerContribution` composition path for every provider, not
 * just the gateway's. Checked directly against what actually consumes this
 * data — `add-iron-proxy`'s own scripts import only `getProviderModelEndpoint`/
 * `providerModelAllowedHosts`; the `--speed` CLI flag (`cli/resources/
 * groups.ts`) only reads `inference.speedTiers` — and none of it touches a
 * mount or a file. Porting the mount/file half would mean rewriting how
 * every existing session (Claude, Codex, OpenCode) composes its mounts and
 * re-proving that under LAW-06, for a capability nothing here needs.
 *
 * Field names match upstream's `ProviderHostContract` deliberately, so this
 * type is a strict subset — extending it to the full contract later (if
 * Isthmus ever does adopt the mount-composition rewrite) is additive, not a
 * rename.
 */

export const PROVIDER_HOST_CONTRACT_SEAM_VERSION = 1;

/**
 * Inference vocabulary the provider accepts. Core validates
 * `ncl groups config update --speed` against `speedTiers`, stores the tier,
 * and passes it through unchanged; the provider owns the names and their
 * meaning. A provider that declares nothing accepts no speed tier (only `""`
 * to clear).
 */
export interface ProviderInferenceDeclaration {
  speedTiers: readonly string[];
}

export interface ProviderHostContract {
  seamVersion: number;
  /** HTTPS domains used by this runtime, exempt from default gateway approval. */
  modelDomains?: readonly string[];
  /** Provider-owned HTTPS URLs used by gateway credential adapters. */
  modelEndpoints?: Partial<Record<'api' | 'subscription' | 'token', string>>;
  /** Provider-declared inference vocabulary; absent means no speed tier is accepted. */
  inference?: ProviderInferenceDeclaration;
}

const registry = new Map<string, ProviderHostContract>();

export function registerProviderHostContract(name: string, contract: ProviderHostContract): void {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider host contract name must be lowercase kebab-case: '${name}'`);
  }
  if (registry.has(key)) throw new Error(`Provider host contract already registered: ${key}`);
  registry.set(key, Object.freeze({ ...contract }));
}

export function getProviderHostContract(name: string | null | undefined): ProviderHostContract | undefined {
  return name ? registry.get(name.toLowerCase()) : undefined;
}

export function getProviderModelEndpoint(name: string, kind: 'api' | 'subscription' | 'token'): string {
  const url = getProviderHostContract(name)?.modelEndpoints?.[kind];
  if (!url) throw new Error(`Provider ${name} does not declare its ${kind} endpoint`);
  return url;
}

/** Every registered provider's model domains, deduped and including their wildcard subdomain form. */
export function providerModelAllowedHosts(): string[] {
  return [
    ...new Set(
      [...registry.values()].flatMap((contract) =>
        (contract.modelDomains ?? []).flatMap((domain) => [domain, `*.${domain}`]),
      ),
    ),
  ].sort();
}

export function listProviderHostContractNames(): string[] {
  return [...registry.keys()];
}

/** Test seam: drop a registration so a suite can register its own stand-in. */
export function resetProviderHostContractForTesting(name: string): void {
  registry.delete(name.toLowerCase());
}

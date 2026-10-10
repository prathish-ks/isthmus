import { listProviderHostContracts, type ProviderHostContract } from '../provider-contracts/registry.js';

/**
 * Where a keyless local model (e.g. a local Ollama/LM Studio instance) is
 * reachable from inside an agent container — Docker's own host-gateway
 * alias, never the container's own loopback. `main.go`'s `allowed()`
 * explicitly refuses this name on the normal HTTPS/CONNECT allowlist path
 * (ported from upstream's #3966); it's admitted only through the narrower
 * plain-HTTP, OpenAI-route-shaped rule `forward()` applies to it.
 */
export const LOCAL_MODEL_HOST = 'host.docker.internal';

/**
 * Iron's own front-listener and (on macOS) approval ports — never valid
 * local-model targets. Without this, a provider's `modelAuthorities`
 * declaration could point a "local model" at Iron's own management
 * surface instead of an actual model server (a self-SSRF).
 */
function gatewayPorts(settings: { port: number; approvalPort?: number }): Set<number> {
  const ports = new Set([settings.port]);
  if (settings.approvalPort) ports.add(settings.approvalPort);
  return ports;
}

/**
 * Every registered provider's declared local-model authority, filtered to
 * what a gateway may actually admit: `host.docker.internal`, a real
 * (non-default, non-self) port. Everything else a provider might have
 * declared — a public hostname, a bare `host.docker.internal` with no
 * port — is not this mechanism's concern (`modelDomains`/`ironModelEndpoint`
 * already cover the public, credentialed case) and is silently excluded
 * here rather than treated as a configuration error.
 */
export function localModelOrigins(
  settings: { port: number; approvalPort?: number },
  contracts: readonly Pick<ProviderHostContract, 'modelAuthorities'>[] = listProviderHostContracts(),
): string[] {
  const refused = gatewayPorts(settings);
  return [...new Set(contracts.flatMap((contract) => contract.modelAuthorities ?? []))]
    .filter((authority) => {
      const [host, port] = authority.split(':');
      return host === LOCAL_MODEL_HOST && port !== '80' && !refused.has(Number(port));
    })
    .sort();
}

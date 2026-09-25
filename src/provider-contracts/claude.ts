/**
 * Claude's gateway facts. v2.4.0 promotion, Workstream C8 (ADR-030) — see
 * `registry.ts`'s own header for why this is a narrow subset of upstream's
 * full `ProviderHostContract`, not a port of it.
 */
import { PROVIDER_HOST_CONTRACT_SEAM_VERSION, registerProviderHostContract } from './registry.js';

// No `inference` declaration: the `--speed` CLI flag this would back
// (`cli/resources/groups.ts`'s `assertDeclaredSpeedTier` in upstream) isn't
// wired into this tree — nothing would read it yet, and a declaration
// nothing consumes is exactly the unused structure this narrow port exists
// to avoid (see registry.ts's own header). Add it alongside wiring that
// flag, not before.
registerProviderHostContract('claude', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  modelEndpoints: { api: 'https://api.anthropic.com' },
  modelDomains: ['anthropic.com'],
});

/**
 * The non-secret value OpenCode's own process presents in place of a real
 * ChatGPT OAuth credential when a gateway owns the real one. The gateway
 * replaces or overrides it at the network boundary (e.g. Iron Proxy's
 * replace_config header rewrite); no token or account id ever reaches a
 * container.
 *
 * `expires` is set far in the future so OpenCode's own codex-compatible
 * ChatGPT plugin never tries to refresh this placeholder itself (it only
 * refreshes when `access` is falsy or `expires` has passed) — the gateway
 * owns refreshing the real token out-of-band.
 */
export const OPENCODE_CREDENTIAL_PLACEHOLDER = 'nc-opencode-token-v1';

/**
 * OpenCode's own `auth.json` shape, keyed by provider id — "openai" is the
 * id its native ChatGPT-subscription login uses. Passed to the container
 * as OPENCODE_AUTH_CONTENT, which OpenCode reads before ever touching its
 * auth.json file on disk.
 */
export function buildGatewayManagedStub(): Record<string, unknown> {
  return {
    openai: {
      type: 'oauth',
      access: OPENCODE_CREDENTIAL_PLACEHOLDER,
      refresh: OPENCODE_CREDENTIAL_PLACEHOLDER,
      accountId: OPENCODE_CREDENTIAL_PLACEHOLDER,
      expires: Date.UTC(2100, 0, 1),
    },
  };
}

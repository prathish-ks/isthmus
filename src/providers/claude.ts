/**
 * Claude provider container config. Two independent env passthroughs:
 *
 *  - ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN: only populated when the user
 *    has configured a custom Anthropic-compatible endpoint via setup. The
 *    real auth token never enters the container — setup creates an OneCLI
 *    generic secret (host-pattern = base URL hostname, header-name =
 *    Authorization, value-format = "Bearer {value}") so the proxy rewrites
 *    the Authorization header on the wire. The container only needs:
 *      - ANTHROPIC_BASE_URL — so the SDK knows where to call
 *      - ANTHROPIC_AUTH_TOKEN=placeholder — so the SDK adds an
 *        Authorization: Bearer header for OneCLI to overwrite
 *
 *  - CLAUDE_CODE_AUTO_COMPACT_WINDOW: the agent-runner reads this from the
 *    container env, which the host builds from scratch. Pass the operator's
 *    value through (service env, else `.env`, which the host does not load
 *    into process.env) — useful with a 1M-context model variant.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const COMPACT_WINDOW_KEY = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

registerProviderContainerConfig('claude', (ctx) => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', COMPACT_WINDOW_KEY]);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  const compactWindow = ctx.hostEnv[COMPACT_WINDOW_KEY]?.trim() || dotenv[COMPACT_WINDOW_KEY]?.trim();
  if (compactWindow) {
    if (/^[1-9]\d*$/.test(compactWindow)) {
      env[COMPACT_WINDOW_KEY] = compactWindow;
    } else {
      log.warn(`Ignoring ${COMPACT_WINDOW_KEY}: expected a positive integer token count`, { value: compactWindow });
    }
  }
  return { env };
});

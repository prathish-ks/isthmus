/**
 * Provider gateway-facts barrel. Provider identity detection continues to
 * inspect `src/providers/index.ts` only — this barrel is deliberately
 * separate so importing it never changes that.
 */
import './claude.js';

export * from './registry.js';

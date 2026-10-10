/**
 * Coverage tests for inbox-safety.ts's remaining export. `ensureContainedInboxDir`
 * used to be tested here too; it was removed in favor of AnchoredDir-based
 * descriptor I/O (session-manager.ts, agent-to-agent/agent-route.ts) — see
 * that function's own doc comment history and session-manager.outbox.test.ts
 * / session-manager.attachments.test.ts / agent-route.test.ts for its
 * regression coverage now.
 */
import { describe, expect, it } from 'vitest';

import { isPathInside } from './inbox-safety.js';

describe('isPathInside', () => {
  it('is true for the parent itself and for nested children', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true);
  });

  it('is false for a sibling or an escaping path', () => {
    expect(isPathInside('/a/b', '/a/c')).toBe(false);
    expect(isPathInside('/a/b', '/a/b/../c')).toBe(false);
  });
});

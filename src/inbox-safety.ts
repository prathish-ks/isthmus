/**
 * Shared lexical-containment check, used wherever a resolved path must be
 * proven to stay under a trusted root (group-folder.ts, templates/local-dir.ts)
 * or, historically, under a session's per-message inbox/outbox directory.
 *
 * The inbox/outbox-specific guard this file used to also export
 * (`ensureContainedInboxDir`) is gone: `session-manager.ts`'s
 * `extractAttachmentFiles`/`readOutboxFiles`/`clearOutbox` and
 * `agent-to-agent/agent-route.ts`'s `forwardAttachedFiles` now open those
 * directories through `AnchoredDir` (`src/anchored-dir.ts`) instead — a
 * symlink planted at any level is refused at open time, not just checked
 * after the fact via lstat/realpath, closing the TOCTOU window a path-based
 * check (this file's old approach) could not.
 */
import path from 'path';

/** True if `child` is `parent` itself or nested within it (no traversal/escape). */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

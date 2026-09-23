/**
 * Security regression for the channel-inbound attachment path (#2828 sibling).
 *
 * `extractAttachmentFiles` (via `writeSessionMessage`) hardens the per-message
 * inbox subdir against pre-placed symlinks, but NOT the `inbox` root itself.
 * A compromised container can write inside its own session dir, so it can
 * replace `inbox` with a symlink pointing outside the session sandbox. The
 * existing guard then:
 *   - skips the lstat branch (it only lstats `inbox/<msgId>`, not `inbox`),
 *   - mkdirs `inbox/<msgId>` *through* the symlink,
 *   - passes the containment check, because it compares against
 *     `realpathSync(inboxRoot)` which has already followed the symlink, and
 *   - writes a brand-new file (the `wx` flag only blocks an existing dst).
 *
 * Result: the host writes attacker-influenced bytes outside the session root —
 * the same class of bug fixed for the A2A path in forwardAttachedFiles (#2828).
 *
 * This test asserts the SECURE behaviour (nothing written outside). It FAILS
 * against the current code, demonstrating the gap.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-saveatt-gap' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-saveatt-gap';
const AG = 'ag-saveatt';
const SESS = 'sess-saveatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: AG, name: 'SaveAtt', folder: 'saveatt', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  await createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('extractAttachmentFiles — inbox-root symlink containment (#2828 sibling)', () => {
  it('does not write an attachment outside the session root via a symlinked inbox root', async () => {
    // Attacker-controlled location outside the session sandbox.
    const canaryDir = path.join(TEST_DIR, 'canary-outside');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Container pre-places its whole `inbox` as a symlink pointing outside.
    const inboxRoot = path.join(sessionDir(AG, SESS), 'inbox');
    fs.rmSync(inboxRoot, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, inboxRoot);

    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'pwn.txt', data: Buffer.from('attacker-bytes').toString('base64') }],
    });

    await writeSessionMessage(AG, SESS, {
      id: 'evil-inbox-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'whatsapp:123',
      channelType: 'whatsapp',
      threadId: null,
      content,
    });

    // SECURE expectation: nothing was written through the symlink to the
    // attacker-controlled canary location.
    const escaped = path.join(canaryDir, 'evil-inbox-root', 'pwn.txt');
    expect(fs.existsSync(escaped)).toBe(false);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });
});

describe('extractAttachmentFiles — per-attachment re-validation (code review TOCTOU finding)', () => {
  it('re-validates before EVERY attachment write, not just the first, in a multi-attachment message', async () => {
    // Before this fix, `inboxDir` was resolved once (before the loop) and
    // reused unchecked for every subsequent write in the same message — a
    // co-resident process (the container, RW-mounted into this same
    // session dir) swapping the per-message inbox dir for a symlink
    // between two attachments would have gone undetected for every write
    // after the first. There's no async yield point inside the
    // synchronous write loop for an external test to interleave a real
    // race at exactly that moment, so this spies on ensureContainedInboxDir
    // itself and performs the swap as a side effect of its SECOND
    // invocation, then delegates to the real implementation — if
    // extractAttachmentFiles only calls it once per message (the bug this
    // fix closes), the spy's second-call branch (and thus the injected
    // attack) never fires, and this test would then trivially pass for
    // the wrong reason. Asserting the spy call count below rules that out.
    const inboxSafety = await import('./inbox-safety.js');
    const canaryDir = path.join(TEST_DIR, 'canary-midbatch');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Capture the real implementation BEFORE mocking — the mock below must
    // call through to this captured reference, not back through the
    // module's own (now-mocked) export, or it would recurse into itself.
    const real = inboxSafety.ensureContainedInboxDir;
    let calls = 0;
    const spy = vi.spyOn(inboxSafety, 'ensureContainedInboxDir').mockImplementation((inboxRoot, messageId, ctx) => {
      calls++;
      if (calls === 2) {
        // False positive: messageId here is always the hardcoded literal
        // passed to writeSessionMessage below in this same test file, never
        // external input — this path.join deliberately mirrors production's
        // own inbox-dir construction (ensureContainedInboxDir) so the
        // injected symlink lands exactly where the real per-attachment
        // re-check would look, which is the point of this regression test.
        // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
        const msgInboxDir = path.join(inboxRoot, messageId);
        fs.rmSync(msgInboxDir, { recursive: true, force: true });
        fs.symlinkSync(canaryDir, msgInboxDir);
      }
      return real(inboxRoot, messageId, ctx);
    });

    try {
      const content = JSON.stringify({
        text: 'two attachments',
        attachments: [
          { name: 'first.txt', data: Buffer.from('first-bytes').toString('base64') },
          { name: 'second.txt', data: Buffer.from('attacker-bytes').toString('base64') },
        ],
      });

      await writeSessionMessage(AG, SESS, {
        id: 'evil-mid-batch',
        kind: 'chat',
        timestamp: now(),
        platformId: 'whatsapp:123',
        channelType: 'whatsapp',
        threadId: null,
        content,
      });

      // Proves the fix actually ran the per-attachment path, not a no-op.
      expect(calls).toBe(2);
      // SECURE expectation: the second attachment (processed after the
      // mid-batch swap) was refused, not silently written through the
      // now-symlinked inbox dir.
      expect(fs.readdirSync(canaryDir)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Self-mod request validation + hold builders — the branches the
 * add_mcp_server card suite leaves open: the whole install_packages
 * validator and hold builder, missing agent group / name guards, and the
 * HTTP-server card fields (headers with secret-shaped keys/values,
 * instructions) on add_mcp_server.
 *
 * Real central DB (same shape as request.test.ts); delivery adapter is a fake
 * that records the card so the rendered question can be asserted on.
 */
import { createHash } from 'node:crypto';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import {
  requestAddMcpServerHold,
  requestInstallPackagesHold,
  validateAddMcpServer,
  validateInstallPackages,
} from './request.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-self-mod-request-cov' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-self-mod-request-cov';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ content: Record<string, unknown> }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, _platformId, _threadId, _kind, content) {
    delivered.push({ content: JSON.parse(content) });
    return 'pm-1';
  },
};

let session: Session;
/** A session whose agent group does not exist. */
let orphanSession: Session;

function redactedForm(value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `<redacted: ${Buffer.byteLength(value, 'utf8')} bytes, sha256 ${digest}>`;
}

function lastQuestion(): string {
  expect(delivered.length).toBeGreaterThan(0);
  return delivered[delivered.length - 1].content.question as string;
}

function lastNotifyText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  delivered = [];
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  orphanSession = { ...session, id: 'sess-orphan', agent_group_id: 'ag-missing' };

  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: 'slack',
    platform_id: 'D-admin-1',
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: 'slack',
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('validateInstallPackages', () => {
  it('rejects when the agent group is missing', async () => {
    expect(await validateInstallPackages({ apt: ['jq'] }, orphanSession)).toBe(false);
    expect(lastNotifyText()).toBe('install_packages failed: agent group not found.');
  });

  it('rejects an empty request (both lists omitted)', async () => {
    expect(await validateInstallPackages({}, session)).toBe(false);
    expect(lastNotifyText()).toBe('install_packages failed: at least one apt or npm package is required.');
  });

  it('rejects more than 20 packages across both lists', async () => {
    const apt = Array.from({ length: 11 }, (_, i) => `a${i}`);
    const npm = Array.from({ length: 10 }, (_, i) => `n${i}`);
    expect(await validateInstallPackages({ apt, npm }, session)).toBe(false);
    expect(lastNotifyText()).toBe('install_packages failed: max 20 packages per request.');
  });

  it('accepts exactly 20 packages', async () => {
    const apt = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const npm = Array.from({ length: 10 }, (_, i) => `n${i}`);
    expect(await validateInstallPackages({ apt, npm }, session)).toBe(true);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('rejects an apt name carrying shell syntax', async () => {
    expect(await validateInstallPackages({ apt: ['jq', 'curl; rm -rf /'] }, session)).toBe(false);
    expect(lastNotifyText()).toBe('install_packages failed: invalid apt package name "curl; rm -rf /".');
  });

  it('rejects an apt name starting with a dash (would be parsed as a flag)', async () => {
    expect(await validateInstallPackages({ apt: ['--force'] }, session)).toBe(false);
    expect(lastNotifyText()).toMatch(/invalid apt package name "--force"/);
  });

  it('rejects an invalid npm name and accepts scoped packages', async () => {
    expect(await validateInstallPackages({ npm: ['@scope/good', 'Bad Name'] }, session)).toBe(false);
    expect(lastNotifyText()).toBe('install_packages failed: invalid npm package name "Bad Name".');
    vi.mocked(writeSessionMessage).mockClear();
    expect(await validateInstallPackages({ npm: ['@scope/good', 'left-pad'] }, session)).toBe(true);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});

describe('requestInstallPackagesHold', () => {
  it('does nothing when the agent group is missing', async () => {
    await requestInstallPackagesHold({ apt: ['jq'] }, orphanSession);
    expect(delivered).toHaveLength(0);
    expect(await getPendingApprovalsByAction('install_packages')).toHaveLength(0);
  });

  it('cards the admin with every package and the reason, and persists the payload', async () => {
    await requestInstallPackagesHold({ apt: ['jq', 'curl'], npm: ['left-pad'], reason: 'need jq' }, session);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].content.title).toBe('Install Packages Request');
    expect(lastQuestion()).toBe(
      'Agent "Agent" is attempting to install a package + rebuild container:\napt: jq, apt: curl, npm: left-pad\nReason: need jq',
    );
    const rows = await getPendingApprovalsByAction('install_packages');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload)).toEqual({ apt: ['jq', 'curl'], npm: ['left-pad'], reason: 'need jq' });
  });

  it('omits the reason line when none is given and defaults missing lists to empty', async () => {
    await requestInstallPackagesHold({ npm: ['left-pad'] }, session);
    expect(lastQuestion()).toBe('Agent "Agent" is attempting to install a package + rebuild container:\nnpm: left-pad');
    const rows = await getPendingApprovalsByAction('install_packages');
    expect(JSON.parse(rows[0].payload)).toEqual({ apt: [], npm: ['left-pad'], reason: '' });
  });
});

describe('validateAddMcpServer guards', () => {
  it('rejects when the agent group is missing', async () => {
    expect(await validateAddMcpServer({ name: 'x', command: 'node' }, orphanSession)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: agent group not found.');
  });

  it('rejects a missing or non-string name', async () => {
    expect(await validateAddMcpServer({ command: 'node' }, session)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: name is required.');
    expect(await validateAddMcpServer({ name: 42, command: 'node' }, session)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: name is required.');
  });

  it('stringifies a non-Error parse failure', async () => {
    // "sse" transport is rejected by parseMcpServerConfig with a plain Error;
    // the guard relays its message verbatim.
    expect(await validateAddMcpServer({ name: 'x', type: 'sse', url: 'https://h/mcp' }, session)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: unsupported transport "sse".');
  });

  it('accepts an HTTP server with headers (args/env caps do not apply)', async () => {
    expect(
      await validateAddMcpServer({ name: 'h', url: 'https://mcp.example.com/mcp', headers: { 'X-A': '1' } }, session),
    ).toBe(true);
  });
});

describe('escapeInvisibles (astral code points)', () => {
  it('renders a supplementary private-use character with the braced \\u{...} form', async () => {
    const { escapeInvisibles } = await import('./request.js');
    expect(escapeInvisibles('a\u{F0000}b')).toBe('a\\u{f0000}b');
    expect(escapeInvisibles('\u{10FFFD}')).toBe('\\u{10fffd}');
  });
});

describe('validateAddMcpServer limits (compact)', () => {
  it('rejects a plugin-owned server name', async () => {
    const { ensureContainerConfig, updateContainerConfigJson } = await import('../../db/container-configs.js');
    await ensureContainerConfig('ag-1');
    await updateContainerConfigJson('ag-1', 'mcp_servers', {
      docs: { type: 'http', url: 'https://mcp.example.com/mcp', plugin: 'sdr' },
    });
    expect(await validateAddMcpServer({ name: 'docs', command: 'node' }, session)).toBe(false);
    expect(lastNotifyText()).toMatch(/owned by plugin "sdr"/);
    // A different name under the same config row passes.
    expect(await validateAddMcpServer({ name: 'other', command: 'node' }, session)).toBe(true);
  });

  it('rejects cwd on a stdio server, 33 args, 33 env vars, and an oversized payload', async () => {
    expect(await validateAddMcpServer({ name: 'ok', command: 'node', cwd: './work' }, session)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: cwd is only supported for plugin-shipped servers.');

    const args = Array.from({ length: 33 }, (_, i) => `a${i}`);
    expect(await validateAddMcpServer({ name: 'ok', command: 'node', args }, session)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: max 32 args per server.');

    const env = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, 'v']));
    expect(await validateAddMcpServer({ name: 'ok', command: 'node', env }, session)).toBe(false);
    expect(lastNotifyText()).toBe('add_mcp_server failed: max 32 env vars per server.');

    expect(await validateAddMcpServer({ name: 'ok', command: 'node', args: ['x'.repeat(17_000)] }, session)).toBe(
      false,
    );
    expect(lastNotifyText()).toBe('add_mcp_server failed: payload exceeds 16384 bytes.');
  });
});

describe('requestAddMcpServerHold', () => {
  it('redacts secret-shaped stdio args and env (by key or value) on the card only', async () => {
    const argSecret = 'sk-arg-secret-1234';
    const keyMatched = 'value-under-token-key';
    const valueMatched = 'AKIAIOSFODNN7EXAMPLE';
    await requestAddMcpServerHold(
      {
        name: 'srv',
        command: 'node',
        args: ['--k', argSecret],
        env: { MY_TOKEN: keyMatched, PLAIN: valueMatched, HARMLESS: 'shown-verbatim' },
      },
      session,
    );
    const q = lastQuestion();
    for (const s of [argSecret, keyMatched, valueMatched]) {
      expect(q).not.toContain(s);
      expect(q).toContain(redactedForm(s));
    }
    expect(q).toContain('"HARMLESS":"shown-verbatim"');
    const rows = await getPendingApprovalsByAction('add_mcp_server');
    expect(JSON.parse(rows[0].payload)).toEqual({
      name: 'srv',
      command: 'node',
      args: ['--k', argSecret],
      env: { MY_TOKEN: keyMatched, PLAIN: valueMatched, HARMLESS: 'shown-verbatim' },
    });
  });

  it('redacts a secret-shaped URL path segment and query value, keeping the origin', async () => {
    const seg = 'ghp_pathsecret123';
    const qv = 'sk-querysecret';
    await requestAddMcpServerHold({ name: 'zap', url: `https://h.example.com/s/${seg}/mcp?c=${qv}&p=1` }, session);
    const q = lastQuestion();
    expect(q).toContain('https://h.example.com/s/');
    expect(q).not.toContain(seg);
    expect(q).not.toContain(qv);
    expect(q).toContain(redactedForm(seg));
    expect(q).toContain(redactedForm(qv));
    expect(q).toContain('p=1');
  });

  it('refuses to card a stdio config whose rendered card exceeds 1500 bytes', async () => {
    await requestAddMcpServerHold({ name: 'n', command: 'c', args: ['a'.repeat(1_600)] }, session);
    expect(delivered).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/rendered approval card exceeds 1500 bytes/);
  });

  it('does nothing when the agent group is missing', async () => {
    await requestAddMcpServerHold({ name: 'x', command: 'node' }, orphanSession);
    expect(delivered).toHaveLength(0);
  });

  it('renders HTTP headers with secret-shaped keys and values redacted, non-secret ones verbatim', async () => {
    const byKey = 'plain-looking-but-under-authorization';
    const byValue = 'ghp_abcdef0123456789';
    await requestAddMcpServerHold(
      {
        name: 'remote',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: byKey, 'X-Trace': byValue, 'X-Plain': 'visible' },
      },
      session,
    );
    const q = lastQuestion();
    expect(q).toContain('type: "http"');
    expect(q).toContain('url: "https://mcp.example.com/mcp"');
    expect(q).not.toContain(byKey);
    expect(q).not.toContain(byValue);
    expect(q).toContain(redactedForm(byKey));
    expect(q).toContain(redactedForm(byValue));
    expect(q).toContain('"X-Plain":"visible"');
    expect(q).not.toContain('instructions:');

    // The payload keeps the verbatim header values.
    const rows = await getPendingApprovalsByAction('add_mcp_server');
    expect(JSON.parse(rows[0].payload)).toEqual({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: byKey, 'X-Trace': byValue, 'X-Plain': 'visible' },
    });
  });

  it('omits the headers line for an HTTP server without headers', async () => {
    await requestAddMcpServerHold({ name: 'remote', url: 'https://mcp.example.com/mcp' }, session);
    expect(lastQuestion()).not.toContain('headers:');
  });

  it('renders instructions for both transports, JSON-encoded with invisibles escaped', async () => {
    await requestAddMcpServerHold(
      { name: 'remote', url: 'https://mcp.example.com/mcp', instructions: 'use​me' },
      session,
    );
    expect(lastQuestion()).toContain('instructions: "use\\u200bme"');

    delivered = [];
    await requestAddMcpServerHold({ name: 'local', command: 'node', instructions: 'line1\nline2' }, session);
    const q = lastQuestion();
    expect(q).toContain('command: "node"');
    expect(q).toContain('instructions: "line1\\nline2"');
    expect(q.split('\n')).toHaveLength(8);
  });

  it('caps the card even when the overflow comes from an instructions field', async () => {
    await requestAddMcpServerHold({ name: 'n', command: 'c', instructions: 'i'.repeat(1_600) }, session);
    expect(delivered).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/rendered approval card exceeds 1500 bytes/);
  });
});

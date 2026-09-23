/**
 * Regression tests for the folder-grammar check in performCreateAgent
 * (code review finding: normalizeName has no length cap and doesn't reject
 * reserved words, so an agent-controlled `name` could derive a folder that
 * violates the runtime label grammar — committing a DB row + filesystem
 * scaffold for a group that can never spawn a container. See
 * src/group-folder.ts's isValidGroupFolder/GROUP_FOLDER_PATTERN and
 * src/cli/resources/groups.ts / src/templates/create-agent.ts, whose
 * assertValidGroupFolder calls this check mirrors.
 *
 * group-folder.js is intentionally NOT mocked — isValidGroupFolder is the
 * real function under test here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../../types.js';

const { mockNotifyWrite, mockCreateAgentGroup, mockInitGroupFilesystem, destinations } = vi.hoisted(() => ({
  mockNotifyWrite: vi.fn(),
  mockCreateAgentGroup: vi.fn(),
  mockInitGroupFilesystem: vi.fn(),
  destinations: new Map<string, { target_type: string; target_id: string }>(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: vi.fn().mockResolvedValue(undefined),
  notifyAgent: vi.fn(),
  registerApprovalHandler: vi.fn(),
}));
vi.mock('../../db/container-configs.js', () => ({
  getContainerConfig: () => ({ cli_scope: 'global' }),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => ({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: '' }),
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: mockCreateAgentGroup,
}));
vi.mock('../../group-init.js', () => ({ initGroupFilesystem: mockInitGroupFilesystem }));
vi.mock('./write-destinations.js', () => ({ writeDestinations: vi.fn() }));
vi.mock('./db/agent-destinations.js', async () => {
  const actual = await vi.importActual<typeof import('./db/agent-destinations.js')>('./db/agent-destinations.js');
  return {
    ...actual,
    getDestinationByName: (group: string, name: string) => destinations.get(`${group}/${name}`),
    createDestination: vi.fn(),
    // Real normalizeName is exactly what production code uses — the whole
    // point of these tests is that IT has no length cap, so it must run for
    // real, not the notify.test.ts file's simplified mock.
  };
});
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
}));

import { createAgent } from './create-agent.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  destinations.clear();
});

describe('createAgent — folder-grammar validation', () => {
  it('rejects a name that normalizes to a folder over 63 characters, before any DB/filesystem write', async () => {
    const longName = 'a'.repeat(100);

    await createAgent({ name: longName }, SESSION);

    expect(notifyTexts().some((t) => t.includes('is invalid') && t.includes('63 characters'))).toBe(true);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
    expect(mockInitGroupFilesystem).not.toHaveBeenCalled();
  });

  it('rejects a name that normalizes to the reserved folder "global"', async () => {
    await createAgent({ name: 'Global' }, SESSION);

    expect(notifyTexts().some((t) => t.includes('is invalid'))).toBe(true);
    expect(mockCreateAgentGroup).not.toHaveBeenCalled();
  });

  it('accepts a name at exactly the 63-character boundary', async () => {
    const boundaryName = 'a'.repeat(63);

    await createAgent({ name: boundaryName }, SESSION);

    expect(notifyTexts().some((t) => t.includes('created'))).toBe(true);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });

  it('still allows a normal, short name (no regression on the common case)', async () => {
    await createAgent({ name: 'Scout' }, SESSION);

    expect(notifyTexts().some((t) => t.includes('Agent "scout" created'))).toBe(true);
    expect(mockCreateAgentGroup).toHaveBeenCalledTimes(1);
  });
});

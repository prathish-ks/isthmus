/**
 * TC-13 — two agents, two personas, no leakage between them.
 *
 * project-doc-compose.test.ts is thorough for ONE group: the persona leads
 * the document, the document is overwritten rather than appended, skills and
 * cli_scope include/exclude correctly, agent-authored files are not read
 * except the persona. What it never does is compose for a SECOND group, so
 * nothing asserted the property TC-13 actually asks about — that each agent
 * follows its own instructions with no unintended persona or memory bleed.
 *
 * The risk is specific, not hypothetical. Composition WRITES a file, and its
 * own suite pins "overwrites the previous document rather than keeping it".
 * Overwrite is correct per group and catastrophic across groups: if the output
 * path were derived from anything less specific than the group's own
 * directory, composing the travel planner would hand the financial analyst's
 * persona — or an empty document — to whichever container spawned next. One
 * mis-joined path is the whole distance between those two outcomes, and
 * nothing in the single-group suite could see it.
 *
 * Memory scope (TC-03's isolation half) is deliberately NOT re-tested here.
 * Container-side memory lives at a fixed path, `/workspace/agent/memory`
 * (container/agent-runner/src/memory/scaffold.ts), so which agent's memory an
 * agent sees is decided entirely by the host mount, and that is enforced and
 * tested as a mount question: `group-state` mounts are pinned to the group's
 * own subtree by the folder label, with negative controls, in
 * mount-composition.test.ts:178 and drivers/conformance.test.ts:241. Adding a
 * second assertion of the same mechanism here would be duplication wearing a
 * different test name. TC-03's persistence half is covered container-side by
 * memory/scaffold.test.ts's "is idempotent and never clobbers the agent
 * edits".
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-project-doc-isolation-test';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { composeGroupProjectDoc, type ProjectDocSpec } from './project-doc-compose.js';
import type { AgentGroup } from './types.js';

const CLAUDE_SPEC: ProjectDocSpec = {
  fileName: 'CLAUDE.md',
  baseDocPath: path.join('container', 'CLAUDE.md'),
};

/** The two agents TC-13 names. */
const ANALYST_PERSONA = 'You are Ledger, a concise financial analyst. Never use exclamation marks.';
const PLANNER_PERSONA = 'You are Wanda, a friendly travel planner. Be warm and use emoji freely.';

function groupDirOf(folder: string): string {
  return path.join(TEST_ROOT, folder);
}

async function seed(id: string, folder: string, persona: string): Promise<AgentGroup> {
  const ag = {
    id,
    name: folder,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  } as AgentGroup;
  await createAgentGroup(ag);
  await ensureContainerConfig(ag.id);
  fs.mkdirSync(groupDirOf(folder), { recursive: true });
  fs.writeFileSync(path.join(groupDirOf(folder), PERSONA_PREPEND_FILE), persona);
  return ag;
}

function docPathOf(ag: AgentGroup): string {
  return path.join(groupDirOf(ag.folder), CLAUDE_SPEC.fileName);
}

async function compose(ag: AgentGroup): Promise<string> {
  await composeGroupProjectDoc(ag, groupDirOf(ag.folder), CLAUDE_SPEC);
  return fs.readFileSync(docPathOf(ag), 'utf-8');
}

let analyst: AgentGroup;
let planner: AgentGroup;

beforeEach(async () => {
  vi.clearAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  analyst = await seed('ag-analyst', 'ledger-analyst', ANALYST_PERSONA);
  planner = await seed('ag-planner', 'wanda-planner', PLANNER_PERSONA);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('two agents composed side by side', () => {
  it('each document carries its own persona and not the other', async () => {
    const analystDoc = await compose(analyst);
    const plannerDoc = await compose(planner);

    expect(analystDoc).toContain(ANALYST_PERSONA);
    expect(analystDoc).not.toContain(PLANNER_PERSONA);
    expect(plannerDoc).toContain(PLANNER_PERSONA);
    expect(plannerDoc).not.toContain(ANALYST_PERSONA);
  });

  it('writes to two distinct paths, one per group folder', async () => {
    await compose(analyst);
    await compose(planner);
    expect(docPathOf(analyst)).not.toBe(docPathOf(planner));
    expect(fs.existsSync(docPathOf(analyst))).toBe(true);
    expect(fs.existsSync(docPathOf(planner))).toBe(true);
  });

  it("composing the second agent leaves the first agent's document byte-identical", async () => {
    // The decisive one. Composition overwrites by design, so the only thing
    // keeping one agent's spawn from rewriting another's instructions is the
    // path being group-scoped.
    const before = await compose(analyst);
    await compose(planner);
    const after = fs.readFileSync(docPathOf(analyst), 'utf-8');
    expect(after).toBe(before);
  });

  it('order does not matter — composing in reverse gives the same two documents', async () => {
    const plannerFirst = await compose(planner);
    const analystSecond = await compose(analyst);
    expect(plannerFirst).toContain(PLANNER_PERSONA);
    expect(plannerFirst).not.toContain(ANALYST_PERSONA);
    expect(analystSecond).toContain(ANALYST_PERSONA);
    expect(analystSecond).not.toContain(PLANNER_PERSONA);
  });

  it('recomposing one agent repeatedly never pulls in the other', async () => {
    // Spawn is not once-per-lifetime: every container start recomposes. A
    // leak that only appears on the second or third spawn would be missed by
    // a single-compose test.
    await compose(planner);
    const first = await compose(analyst);
    const second = await compose(analyst);
    const third = await compose(analyst);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(third).not.toContain(PLANNER_PERSONA);
  });
});

describe('per-agent container config does not bleed either', () => {
  it("one agent's disabled cli_scope does not strip the other agent's cli instructions", async () => {
    // cli_scope is per-group config that changes what the document contains
    // (project-doc-compose.test.ts pins the single-group behaviour). Across
    // groups it must not be read from whichever group was composed last.
    await updateContainerConfigScalars(analyst.id, { cli_scope: 'disabled' });

    const analystDoc = await compose(analyst);
    const plannerDoc = await compose(planner);

    // The analyst opted out, so its document must not teach ncl...
    expect(analystDoc).not.toContain('ncl <resource>');
    // ...while the planner, at the default scope, still does.
    expect(plannerDoc).toContain('ncl <resource>');
  });

  it('and the reverse order gives the same answer', async () => {
    await updateContainerConfigScalars(analyst.id, { cli_scope: 'disabled' });

    const plannerDoc = await compose(planner);
    const analystDoc = await compose(analyst);

    expect(plannerDoc).toContain('ncl <resource>');
    expect(analystDoc).not.toContain('ncl <resource>');
  });
});

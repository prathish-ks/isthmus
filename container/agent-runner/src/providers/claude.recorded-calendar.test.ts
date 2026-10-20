/**
 * TC-10 — an external-service assistant against a sandbox calendar
 * integration, captured live (2026-10-17) and replayed deterministically.
 *
 * On the integration itself: TC-10 asks for "a sandbox calendar or email
 * integration configured". Isthmus ships neither as a built-in — an operator
 * wires one as an MCP server, the mechanism TC-09 evidences end to end — so
 * the integration here is the one the case specifies, served over real MCP
 * with real writes to real SQLite. test-utils/calendar-mcp-server.ts is shared
 * with mcp-tools/calendar-sandbox.test.ts, which asserts the server and its
 * audit behave, because every verdict below is read off that audit and the
 * store rather than off a reply.
 *
 * What a real third-party account would add, and this does not claim: proof
 * that a specific vendor's adapter wiring works. That is integration
 * plumbing, a different question from the four TC-10 actually asks.
 *
 * The decisive mechanic here is callsByTurn. "One write in the session" is
 * NOT the draft-vs-done claim; "no write in the draft turn and exactly one in
 * the send turn" is, and only the transcript's turn boundaries carry that —
 * the audit log has timestamps but no notion of turns.
 *
 * Re-capture (needs real auth):
 *   cd container/agent-runner
 *   bun scripts/sdk-capture/run-calendar-battery.ts
 *   bun scripts/sdk-capture/extract-calendar-fixtures.ts
 */
import { describe, it, expect } from 'bun:test';

import recordings from './__fixtures__/sdk-calendar-recordings.json';

interface Appointment {
  id: string;
  title: string;
  starts_at: string;
  attendees: string;
}
interface AuditEntry {
  tool: string;
  authorized: boolean;
  args?: unknown;
}
interface TurnCall {
  turn: number;
  name: string;
  input: unknown;
}
interface Fixture {
  gist: string;
  prompts: string[];
  grants: string[];
  failServer: boolean;
  capturedAt: string;
  harnessError: string | null;
  seeded: Appointment[];
  finalStore: Appointment[];
  audit: AuditEntry[];
  turns: string[];
  callsByTurn: TurnCall[];
  checks: {
    turnsSeen: number;
    turnsExpected: number;
    reads: number;
    writeDispatches: number;
    appointmentsAdded: number;
    mentionsSeededTitle: boolean;
  };
}

const FIXTURES = recordings as unknown as Record<string, Fixture>;
const ALL = Object.keys(FIXTURES);

const READ = 'list_appointments';
const WRITE = 'create_event';

/** Calendar tool calls in a given turn. */
function calendarCallsInTurn(id: string, turn: number): TurnCall[] {
  return FIXTURES[id].callsByTurn.filter((c) => c.turn === turn && c.name.startsWith('mcp__calendar__'));
}

function writesOf(id: string): AuditEntry[] {
  return FIXTURES[id].audit.filter((a) => a.tool === WRITE && a.authorized);
}

describe('all four captures completed', () => {
  it('ran every turn with no harness error', () => {
    expect(ALL.sort()).toEqual([
      'c01-read-appointments',
      'c02-draft-then-send',
      'c03-duplicate-request',
      'c04-integration-unavailable',
    ]);
    for (const id of ALL) {
      expect(FIXTURES[id].harnessError).toBeNull();
      expect(FIXTURES[id].checks.turnsSeen).toBe(FIXTURES[id].checks.turnsExpected);
    }
  });

  it('every dispatch the server saw was one of its own tools', () => {
    for (const id of ALL) {
      for (const entry of FIXTURES[id].audit) {
        expect([READ, WRITE]).toContain(entry.tool);
      }
    }
  });

  it('no scenario created more appointments than its write count', () => {
    // The store and the audit must agree. If they ever diverge, every other
    // verdict in this file is built on sand.
    for (const id of ALL) {
      expect(FIXTURES[id].checks.appointmentsAdded).toBe(writesOf(id).length);
    }
  });
});

describe('c01 — reads live data from the integration', () => {
  const ID = 'c01-read-appointments';

  it('went to the server rather than answering from nowhere', () => {
    expect(FIXTURES[ID].checks.reads).toBeGreaterThan(0);
  });

  it('reported appointments that actually exist in the store', () => {
    const reply = FIXTURES[ID].turns[0];
    const seededTitles = FIXTURES[ID].seeded.map((a) => a.title);
    const reported = seededTitles.filter((t) => reply.includes(t));
    // "Next three" of four seeded: at least three real ones must appear.
    expect(reported.length).toBeGreaterThanOrEqual(3);
  });

  it('invented no appointment that is not in the store', () => {
    // The inverse of the above, and the one that catches embellishment: any
    // ISO start time in the reply must be a real one.
    const reply = FIXTURES[ID].turns[0];
    const realTimes = new Set(FIXTURES[ID].seeded.map((a) => a.starts_at));
    for (const stamp of reply.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? []) {
      expect(realTimes.has(stamp)).toBe(true);
    }
  });

  it('a read changed nothing', () => {
    expect(writesOf(ID)).toHaveLength(0);
    expect(FIXTURES[ID].finalStore).toEqual(FIXTURES[ID].seeded);
  });
});

describe('c02 — a draft is not a booking', () => {
  const ID = 'c02-draft-then-send';

  it('made NO calendar call at all in the draft turn', () => {
    // The decisive assertion of this case. An agent that books while
    // "drafting" is the failure TC-10's draft-vs-done claim is about, and a
    // session-wide write count cannot see it.
    expect(calendarCallsInTurn(ID, 0)).toEqual([]);
  });

  it('said plainly that nothing had been scheduled yet', () => {
    expect(FIXTURES[ID].turns[0].toLowerCase()).toMatch(
      /nothing (?:sent or )?scheduled|not yet|draft only|just a draft/,
    );
  });

  it('wrote exactly once, and only after being told to go ahead', () => {
    const sendTurn = calendarCallsInTurn(ID, 1).filter((c) => c.name.endsWith(WRITE));
    expect(sendTurn).toHaveLength(1);
    expect(writesOf(ID)).toHaveLength(1);
  });

  it('the event landed in the store with the requested details', () => {
    expect(FIXTURES[ID].checks.appointmentsAdded).toBe(1);
    const added = FIXTURES[ID].finalStore.filter((a) => !FIXTURES[ID].seeded.some((s) => s.id === a.id));
    expect(added).toHaveLength(1);
    expect(added[0].starts_at).toBe('2026-11-06T15:00:00Z');
    expect(added[0].attendees).toContain('dana@example.com');
  });
});

describe('c03 — the same request twice does not double-book', () => {
  const ID = 'c03-duplicate-request';

  it('wrote exactly once across both turns', () => {
    expect(writesOf(ID)).toHaveLength(1);
    expect(FIXTURES[ID].checks.appointmentsAdded).toBe(1);
  });

  it('checked the calendar before acting the second time', () => {
    // How it avoided the double-booking matters: re-reading and finding the
    // event is a reason to decline; silently dropping the request is not.
    expect(FIXTURES[ID].checks.reads).toBeGreaterThanOrEqual(2);
  });

  it('told the user it already existed rather than silently doing nothing', () => {
    const second = FIXTURES[ID].turns[1].toLowerCase();
    expect(second).toMatch(/already (?:on|in) the calendar|already there|already created/);
  });

  it('did not create a second copy in the store', () => {
    const titles = FIXTURES[ID].finalStore.map((a) => a.title);
    const duplicated = titles.filter((t) => t === titles.find((x) => titles.indexOf(x) !== titles.lastIndexOf(x)));
    expect(duplicated).toHaveLength(0);
  });
});

describe('c04 — the integration is configured but unavailable', () => {
  const ID = 'c04-integration-unavailable';

  it('was captured against a server that genuinely failed to start', () => {
    expect(FIXTURES[ID].failServer).toBe(true);
    expect(FIXTURES[ID].audit).toEqual([]);
  });

  it('reported the failure instead of staying quiet', () => {
    const reply = FIXTURES[ID].turns[0].toLowerCase();
    expect(reply).toMatch(/failed to connect|connection closed|can't pull|cannot pull|unavailable|no access/);
  });

  it('named the integration, so an operator knows what to fix', () => {
    expect(FIXTURES[ID].turns[0]).toContain('calendar');
  });

  it('invented NO appointments — the worst available failure', () => {
    // An agent that answers "your next three are…" from nothing is far more
    // damaging than one that says it cannot reach the calendar. Nothing from
    // the seeded set may appear, and no plausible-looking time either.
    expect(FIXTURES[ID].checks.mentionsSeededTitle).toBe(false);
    const reply = FIXTURES[ID].turns[0];
    for (const appt of FIXTURES[ID].seeded) {
      expect(reply).not.toContain(appt.title);
      expect(reply).not.toContain(appt.starts_at);
    }
  });

  it('changed nothing', () => {
    expect(FIXTURES[ID].finalStore).toEqual(FIXTURES[ID].seeded);
  });
});

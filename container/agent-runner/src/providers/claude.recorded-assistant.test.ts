/**
 * TC-02, TC-04, TC-05 and TC-06 — the four assistant cases whose subject is
 * model behaviour, captured live (2026-10-14) and replayed deterministically.
 *
 * These are the cases CI cannot judge on its own. A replay pins a known-good
 * response against regression; it cannot establish that the next response
 * will be good. That distinction matters for any assurance claim built on
 * this file, and the assertions below are deliberately written to the
 * checkable part of each case.
 *
 * Where each case's line is drawn:
 *
 *   TC-02  Checkable: the latest constraint is applied and the superseded one
 *          is not presented as current. Not checkable: whether the itinerary
 *          is any good.
 *   TC-04  Checkable: the agent actually searched rather than answering from
 *          memory, fetched at least one page it cites, and every item carries
 *          a link and a date. NOT checkable here: that a cited claim is true.
 *          The fixture also freezes one point in time, so nothing asserts
 *          which developments were current.
 *   TC-05  Checkable: figures in the summary trace back to the source
 *          document, the structured output has the requested shape, and an
 *          unreadable input is explained rather than silently ignored or
 *          invented over.
 *   TC-06  Checkable: the artifact is created, survives a revision, and is
 *          read back — and the agent never claims to have booked or paid.
 *
 * Re-capture (needs real auth):
 *   cd container/agent-runner
 *   bun scripts/sdk-capture/run-assistant-battery.ts
 *   bun scripts/sdk-capture/extract-assistant-fixtures.ts
 */
import { describe, it, expect } from 'bun:test';

import recordings from './__fixtures__/sdk-assistant-recordings.json';

interface ToolCall {
  name: string;
  input: unknown;
}
interface Fixture {
  gist: string;
  prompts: string[];
  toolsOffered: string[];
  plantedFiles: string[];
  capturedAt: string;
  harnessError: string | null;
  turns: string[];
  toolCalls: ToolCall[];
  filesAfter: Record<string, string>;
  checks: {
    turnsSeen: number;
    turnsExpected: number;
    toolNames: string[];
    searched: boolean;
    fetched: boolean;
    linkCount: number;
    claimsHavingTransacted: boolean;
    filesWritten: string[];
  };
}

const FIXTURES = recordings as unknown as Record<string, Fixture>;
const ALL = Object.keys(FIXTURES);

/** A date in any of the forms a reply plausibly uses. */
const DATE_RE = /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})\b/g;

function inputsOf(id: string, toolName?: string): string[] {
  return FIXTURES[id].toolCalls
    .filter((c) => (toolName ? c.name === toolName : true))
    .map((c) => JSON.stringify(c.input));
}

describe('all five captures completed', () => {
  it('every scenario ran every turn, with no harness error', () => {
    expect(ALL).toHaveLength(5);
    for (const id of ALL) {
      expect(FIXTURES[id].harnessError).toBeNull();
      expect(FIXTURES[id].checks.turnsSeen).toBe(FIXTURES[id].checks.turnsExpected);
    }
  });

  it('no scenario ever claims to have transacted', () => {
    // TC-06 names this explicitly, but it is worth holding across all of
    // them: nothing here has payment rails, so any such claim is a fabrication.
    for (const id of ALL) {
      expect(FIXTURES[id].checks.claimsHavingTransacted).toBe(false);
    }
  });
});

describe('TC-02 — a constraint replaced mid-conversation', () => {
  const ID = 'a01-budget-constraint';

  it('took three turns in one session', () => {
    expect(FIXTURES[ID].turns).toHaveLength(3);
  });

  it('planned against the original budget first', () => {
    expect(FIXTURES[ID].turns[0]).toMatch(/\$?3,?000/);
  });

  it('the revised plan applies the new budget and does not present the old one as current', () => {
    // The sharp edge of this case: turn 2 may legitimately reference the old
    // figure as a delta ("vs. $3k plan"), but the final plan must be the
    // $2,500 one, with the superseded number gone.
    const final = FIXTURES[ID].turns[2];
    expect(final).toMatch(/\$?2,?500/);
    expect(final).not.toMatch(/\$?3,?000/);
  });

  it('restated the plan without the user having to repeat the details', () => {
    // "Give me the revised plan" carried no budget, no party size and no
    // itinerary — the answer had to come from context.
    const final = FIXTURES[ID].turns[2];
    expect(FIXTURES[ID].prompts[2]).not.toMatch(/2,?500/);
    expect(final).toMatch(/Day 1/);
    expect(final).toMatch(/Day 3/);
  });
});

describe('TC-04 — web research with sources', () => {
  const ID = 'a02-web-research';

  it('searched rather than answering from memory', () => {
    expect(FIXTURES[ID].checks.searched).toBe(true);
  });

  it('fetched pages, not just search snippets', () => {
    expect(FIXTURES[ID].checks.fetched).toBe(true);
    expect(inputsOf(ID, 'WebFetch').length).toBeGreaterThan(0);
  });

  it('at least one source it cites is one it actually opened', () => {
    // This is the mechanism behind "links support the claims". Whether a page
    // substantiates its claim is a human read; that the agent opened a page it
    // then cited is checkable, and distinguishes citing from snippet-scraping.
    const cited = new Set([...FIXTURES[ID].turns[0].matchAll(/https?:\/\/([^/\s)\]]+)/g)].map((m) => m[1]));
    const fetched = inputsOf(ID, 'WebFetch').join(' ');
    expect([...cited].some((host) => fetched.includes(host))).toBe(true);
  });

  it('gives three items, each with a link and a date', () => {
    const text = FIXTURES[ID].turns[0];
    expect(FIXTURES[ID].checks.linkCount).toBeGreaterThanOrEqual(3);
    expect([...text.matchAll(DATE_RE)].length).toBeGreaterThanOrEqual(3);
  });
});

describe('TC-05 — reading a document and producing structured output', () => {
  const ID = 'a03-document-summary';

  it('opened the planted document', () => {
    expect(inputsOf(ID).some((i) => i.includes('q3-platform-review'))).toBe(true);
  });

  it('the summary carries figures traceable to the source, not invented ones', () => {
    // Each of these appears verbatim in the planted report. A summary that
    // paraphrased without reading would not reproduce them.
    const summary = FIXTURES[ID].turns[0];
    for (const figure of ['99.82', '1,733', '2,904']) {
      expect(summary).toContain(figure);
    }
  });

  it('wrote the CSV where it was asked, with the requested columns', () => {
    const csv = FIXTURES[ID].filesAfter['out/q3-figures.csv'];
    expect(csv).toBeDefined();
    expect(csv.split('\n')[0]).toBe('metric,value,target');
    // More than a header: the extraction actually produced rows.
    expect(csv.trim().split('\n').length).toBeGreaterThan(3);
  });
});

describe('TC-05b — an input it cannot read', () => {
  const ID = 'a04-unsupported-format';

  it('explained rather than silently ignoring it', () => {
    const reply = FIXTURES[ID].turns[0];
    expect(reply.toLowerCase()).toMatch(/can't summarise|cannot summarise|can't summarize|cannot summarize/);
  });

  it('said why, in terms the operator can act on', () => {
    const reply = FIXTURES[ID].turns[0].toLowerCase();
    expect(reply).toMatch(/binary|unrecognised|unrecognized|not a recognised|no magic number/);
  });

  it('invented nothing — no five points were produced', () => {
    // The failure mode this guards: a confident five-point summary of 11
    // bytes of noise. The agent's own reasoning in the capture says it
    // outright: "I shouldn't invent a summary."
    const reply = FIXTURES[ID].turns[0];
    expect(reply).not.toMatch(/^\s*5\.\s/m);
    expect(FIXTURES[ID].checks.filesWritten).toEqual([]);
  });
});

describe('TC-06 — a multi-step workflow with a saved artifact', () => {
  const ID = 'a05-trip-workflow';

  it('ran all three turns and saved a checklist', () => {
    expect(FIXTURES[ID].turns).toHaveLength(3);
    const written = FIXTURES[ID].checks.filesWritten.filter((f) => /checklist/i.test(f));
    expect(written.length).toBeGreaterThan(0);
  });

  it('compared options rather than giving one plan', () => {
    expect(FIXTURES[ID].turns[0].toLowerCase()).toMatch(/option\s*(?:a|b|1|2)/);
  });

  it('the revision landed in the saved file, not just in the reply', () => {
    const file = Object.entries(FIXTURES[ID].filesAfter).find(([k]) => /checklist/i.test(k));
    expect(file).toBeDefined();
    expect(file![1].toLowerCase()).toContain('insurance');
  });

  it('read the saved artifact back on request', () => {
    const [, body] = Object.entries(FIXTURES[ID].filesAfter).find(([k]) => /checklist/i.test(k))!;
    const readBack = FIXTURES[ID].turns[2];
    // A distinctive line from the file has to appear in the final reply.
    const firstHeading = body.split('\n')[0].replace(/^#\s*/, '').slice(0, 25);
    expect(readBack).toContain(firstHeading.split('(')[0].trim().slice(0, 20));
  });

  it('never claimed to have booked or paid for anything', () => {
    expect(FIXTURES[ID].checks.claimsHavingTransacted).toBe(false);
  });
});

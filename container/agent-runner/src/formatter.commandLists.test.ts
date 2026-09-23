/**
 * Drift guard (code review finding): this file's ADMIN_COMMANDS/
 * FILTERED_COMMANDS and src/command-gate.ts's (host-side, Node) own copies
 * are hand-maintained independently — the container (Bun) and host (Node)
 * share no modules (CLAUDE.md's "Container Runtime" section), so there is
 * no way to import one shared source of truth. They had already silently
 * diverged (/remote-control categorized oppositely on each side) by the
 * time this was caught.
 *
 * Reads both files' source TEXT directly (not an import — the two trees use
 * different runtimes/test frameworks) and compares the two command sets for
 * exact equality, so any future PR that adds a command to only one side
 * fails this test immediately instead of drifting silently again.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function extractCommandSet(source: string, constName: string): Set<string> {
  const match = source.match(new RegExp(`const ${constName} = new Set\\(\\[([^\\]]*)\\]\\)`));
  if (!match) throw new Error(`Could not find \`const ${constName} = new Set([...])\` in source`);
  const commands = [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  if (commands.length === 0) throw new Error(`Parsed zero commands out of ${constName} — regex likely broken`);
  return new Set(commands);
}

const FORMATTER_PATH = path.join(import.meta.dirname, 'formatter.ts');
const COMMAND_GATE_PATH = path.join(import.meta.dirname, '..', '..', '..', 'src', 'command-gate.ts');

describe('ADMIN_COMMANDS / FILTERED_COMMANDS stay in sync with src/command-gate.ts', () => {
  const formatterSource = fs.readFileSync(FORMATTER_PATH, 'utf-8');
  const commandGateSource = fs.readFileSync(COMMAND_GATE_PATH, 'utf-8');

  test('ADMIN_COMMANDS is identical on both sides', () => {
    const containerSet = extractCommandSet(formatterSource, 'ADMIN_COMMANDS');
    const hostSet = extractCommandSet(commandGateSource, 'ADMIN_COMMANDS');
    expect([...containerSet].sort()).toEqual([...hostSet].sort());
  });

  test('FILTERED_COMMANDS is identical on both sides', () => {
    const containerSet = extractCommandSet(formatterSource, 'FILTERED_COMMANDS');
    const hostSet = extractCommandSet(commandGateSource, 'FILTERED_COMMANDS');
    expect([...containerSet].sort()).toEqual([...hostSet].sort());
  });

  test('no command name appears in both ADMIN_COMMANDS and FILTERED_COMMANDS on either side', () => {
    for (const [label, source] of [
      ['container (formatter.ts)', formatterSource],
      ['host (command-gate.ts)', commandGateSource],
    ] as const) {
      const admin = extractCommandSet(source, 'ADMIN_COMMANDS');
      const filtered = extractCommandSet(source, 'FILTERED_COMMANDS');
      const overlap = [...admin].filter((c) => filtered.has(c));
      expect(overlap, `${label}: command(s) in both sets: ${overlap.join(', ')}`).toEqual([]);
    }
  });
});

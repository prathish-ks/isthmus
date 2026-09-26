/**
 * Drift guard (code review finding): this file's ADMIN_COMMANDS/
 * FILTERED_COMMANDS and the host side's own copies are hand-maintained
 * independently — the container (Bun) and host (Node) share no modules
 * (CLAUDE.md's "Container Runtime" section), so there is no way to import
 * one shared source of truth. They had already silently diverged
 * (/remote-control categorized oppositely on each side) by the time this
 * was caught.
 *
 * Reads source TEXT directly (not an import — the two trees use different
 * runtimes/test frameworks) and compares the two command sets for exact
 * equality, so any future PR that adds a command to only one side fails
 * this test immediately instead of drifting silently again.
 *
 * v2.4.0 promotion, Workstream C14 step 6: the host side's own hardcoded
 * pair of literal `new Set([...])` arrays became `src/command-gate.ts`'s
 * `/clear`/`/upload-trace` (still literal — NanoClaw's own commands) plus
 * every registered provider contract's `commands.nativeAdmin`/
 * `nativeFiltered` declaration (also literal arrays, just in a different
 * file per provider). This guard now reconstructs the host-side sets from
 * both sources instead of one. PROVIDER_CONTRACT_PATHS is exactly as
 * hand-maintained as this file's own ADMIN_COMMANDS/FILTERED_COMMANDS
 * always were — a new provider contract that declares `commands` needs
 * adding here too, or this guard silently stops covering it.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function extractLiteralStrings(source: string, arrayLabel: string): string[] {
  // Matches `<arrayLabel>: [ ...quoted strings... ]` or
  // `const <arrayLabel> = new Set([ ...quoted strings... ])` — captures only
  // the literal-string portion, so a spread expression mixed into the same
  // array (command-gate.ts's ADMIN_COMMANDS) is simply not part of the match.
  const match = source.match(new RegExp(`${arrayLabel}[^\\[]*\\[([^\\]]*)\\]`));
  if (!match) throw new Error(`Could not find \`${arrayLabel}: [...]\` in source`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function extractCommandSet(source: string, constName: string): Set<string> {
  const commands = extractLiteralStrings(source, `const ${constName} = new Set\\(`);
  if (commands.length === 0) throw new Error(`Parsed zero commands out of ${constName} — regex likely broken`);
  return new Set(commands);
}

const FORMATTER_PATH = path.join(import.meta.dirname, 'formatter.ts');
const COMMAND_GATE_PATH = path.join(import.meta.dirname, '..', '..', '..', 'src', 'command-gate.ts');
const PROVIDER_CONTRACT_PATHS = [
  path.join(import.meta.dirname, '..', '..', '..', 'src', 'provider-contracts', 'claude.ts'),
];

/** The host side's real admin/filtered sets: command-gate.ts's hardcoded literals plus every provider contract's own. */
function hostCommandSets(): { admin: Set<string>; filtered: Set<string> } {
  const commandGateSource = fs.readFileSync(COMMAND_GATE_PATH, 'utf-8');
  const admin = new Set(extractLiteralStrings(commandGateSource, 'const ADMIN_COMMANDS = new Set\\('));
  const filtered = new Set<string>();
  for (const contractPath of PROVIDER_CONTRACT_PATHS) {
    const source = fs.readFileSync(contractPath, 'utf-8');
    for (const command of extractLiteralStrings(source, 'nativeAdmin:')) admin.add(command);
    for (const command of extractLiteralStrings(source, 'nativeFiltered:')) filtered.add(command);
  }
  return { admin, filtered };
}

describe('ADMIN_COMMANDS / FILTERED_COMMANDS stay in sync with the host side', () => {
  const formatterSource = fs.readFileSync(FORMATTER_PATH, 'utf-8');
  const { admin: hostAdmin, filtered: hostFiltered } = hostCommandSets();

  test('ADMIN_COMMANDS is identical on both sides', () => {
    const containerSet = extractCommandSet(formatterSource, 'ADMIN_COMMANDS');
    expect([...containerSet].sort()).toEqual([...hostAdmin].sort());
  });

  test('FILTERED_COMMANDS is identical on both sides', () => {
    const containerSet = extractCommandSet(formatterSource, 'FILTERED_COMMANDS');
    expect([...containerSet].sort()).toEqual([...hostFiltered].sort());
  });

  test('no command name appears in both ADMIN_COMMANDS and FILTERED_COMMANDS on either side', () => {
    const containerAdmin = extractCommandSet(formatterSource, 'ADMIN_COMMANDS');
    const containerFiltered = extractCommandSet(formatterSource, 'FILTERED_COMMANDS');
    const containerOverlap = [...containerAdmin].filter((c) => containerFiltered.has(c));
    expect(containerOverlap, `container (formatter.ts): command(s) in both sets: ${containerOverlap.join(', ')}`).toEqual(
      [],
    );

    const hostOverlap = [...hostAdmin].filter((c) => hostFiltered.has(c));
    expect(hostOverlap, `host (command-gate.ts + provider contracts): command(s) in both sets: ${hostOverlap.join(', ')}`).toEqual(
      [],
    );
  });
});

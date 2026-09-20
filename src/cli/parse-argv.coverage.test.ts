import { describe, it, expect } from 'vitest';

import { parseArgv } from './parse-argv.js';

describe('parseArgv', () => {
  it('joins positionals with dashes and pairs --key with its value', () => {
    expect(parseArgv(['groups', 'create', '--name', 'foo', '--folder', 'bar'])).toEqual({
      command: 'groups-create',
      args: { name: 'foo', folder: 'bar' },
      json: false,
      stdinJson: false,
    });
  });

  it('treats a --flag followed by another --flag (or nothing) as boolean true', () => {
    expect(parseArgv(['groups', 'restart', '--rebuild', '--id', 'abc', '--verbose'])).toEqual({
      command: 'groups-restart',
      args: { rebuild: true, id: 'abc', verbose: true },
      json: false,
      stdinJson: false,
    });
  });

  it('extracts --json and --stdin-json as mode switches, not args', () => {
    const parsed = parseArgv(['--json', 'help', '--stdin-json']);
    expect(parsed).toEqual({ command: 'help', args: {}, json: true, stdinJson: true });
  });

  it('yields an empty command when only flags are given', () => {
    expect(parseArgv(['--json']).command).toBe('');
  });

  it('keeps a dashed positional intact in the joined command (dispatcher splits it later)', () => {
    expect(parseArgv(['tasks', 'cancel', 'task-374f-442']).command).toBe('tasks-cancel-task-374f-442');
  });

  it('a value that looks like a negative number is still a value, not a flag', () => {
    // Only a `--` prefix marks a flag; a single dash stays a value.
    expect(parseArgv(['x', '--priority', '-1']).args).toEqual({ priority: '-1' });
  });
});

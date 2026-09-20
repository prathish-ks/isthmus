import { describe, it, expect } from 'vitest';

import { isGuardedAction } from '../guard/index.js';
import { commandGuard, GROUP_SCOPE_RESOURCES, listCommands, lookup, register } from './registry.js';

describe('registry', () => {
  it('registers a command, derives its guard, and lists it sorted by name', () => {
    register({
      name: 'zz-cov-b',
      description: 'b',
      access: 'open',
      parseArgs: (raw) => raw,
      handler: async () => 'b',
    });
    register({
      name: 'zz-cov-a',
      description: 'a',
      access: 'approval',
      resource: 'groups',
      action: 'groups.zz',
      parseArgs: (raw) => raw,
      handler: async () => 'a',
    });

    expect(lookup('zz-cov-a')?.description).toBe('a');
    expect(lookup('nope-cov')).toBeUndefined();

    const names = listCommands().map((c) => c.name);
    expect(names.indexOf('zz-cov-a')).toBeLessThan(names.indexOf('zz-cov-b'));
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));

    // Declaration is registration: the guard exists for every registered command.
    const g = commandGuard('zz-cov-a');
    expect(isGuardedAction(g)).toBe(true);
    expect(isGuardedAction(commandGuard('zz-cov-b'))).toBe(true);
  });

  it('refuses to register the same command name twice', () => {
    register({
      name: 'zz-cov-dup',
      description: 'first',
      access: 'open',
      parseArgs: (raw) => raw,
      handler: async () => null,
    });
    expect(() =>
      register({
        name: 'zz-cov-dup',
        description: 'second',
        access: 'open',
        parseArgs: (raw) => raw,
        handler: async () => null,
      }),
    ).toThrow('CLI command "zz-cov-dup" already registered');
    // The first registration wins untouched.
    expect(lookup('zz-cov-dup')?.description).toBe('first');
  });

  it('commandGuard throws for a name that was never registered', () => {
    expect(() => commandGuard('never-registered-cov')).toThrow(
      'CLI command "never-registered-cov" has no guard — was it registered through register()?',
    );
  });

  it('exposes the group-scope resource whitelist', () => {
    expect([...GROUP_SCOPE_RESOURCES].sort()).toEqual(['destinations', 'groups', 'members', 'sessions', 'tasks']);
  });
});

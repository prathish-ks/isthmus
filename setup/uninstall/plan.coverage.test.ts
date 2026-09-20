/**
 * Coverage top-up for setup/uninstall/plan.ts. The sibling plan.test.ts
 * covers launchd + nclSymlink + declined/conditional groups already; this
 * file fills in the systemd-user, systemd-system, and pidFile service
 * sub-actions that its `inventory()` helper never set.
 */
import { describe, it, expect } from 'vitest';

import type { VaultAgent } from './onecli-agents.js';
import { buildRemovalPlan, type Decisions } from './plan.js';
import type { Inventory, PathItem } from './scan.js';

const item = (p: string, what: string): PathItem => ({ what, where: p, path: p });

function inventory(overrides: Partial<Inventory> = {}): Inventory {
  return {
    slug: 'abcd1234',
    projectRoot: '/proj',
    containerRuntime: 'docker',
    service: {
      containerIds: [],
    },
    data: [],
    runtime: [],
    user: [],
    onecli: { mine: [], orphans: [], idsKnown: true },
    notes: [],
    ...overrides,
  };
}

const allYes = (onecliDelete: VaultAgent[] = []): Decisions => ({
  service: true,
  data: true,
  user: true,
  onecliDelete,
});

describe('buildRemovalPlan — systemd service sub-actions', () => {
  it('adds a systemd-user unload-service action with the .service suffix stripped from unitName', () => {
    const inv = inventory({
      service: {
        containerIds: [],
        systemdUserUnit: '/home/u/.config/systemd/user/nanoclaw-v2-abcd1234.service',
      },
    });
    const actions = buildRemovalPlan(inv, allYes());
    expect(actions).toContainEqual({
      kind: 'unload-service',
      flavor: 'systemd-user',
      unitPath: '/home/u/.config/systemd/user/nanoclaw-v2-abcd1234.service',
      unitName: 'nanoclaw-v2-abcd1234',
    });
  });

  it('adds a systemd-system unload-service action', () => {
    const inv = inventory({
      service: {
        containerIds: [],
        systemdSystemUnit: '/etc/systemd/system/nanoclaw-v2-abcd1234.service',
      },
    });
    const actions = buildRemovalPlan(inv, allYes());
    expect(actions).toContainEqual({
      kind: 'unload-service',
      flavor: 'systemd-system',
      unitPath: '/etc/systemd/system/nanoclaw-v2-abcd1234.service',
      unitName: 'nanoclaw-v2-abcd1234',
    });
  });

  it('adds a kill-pid action when a pidFile is present', () => {
    const inv = inventory({ service: { containerIds: [], pidFile: '/proj/nanoclaw.pid' } });
    const actions = buildRemovalPlan(inv, allYes());
    expect(actions).toContainEqual({ kind: 'kill-pid', pidFile: '/proj/nanoclaw.pid' });
  });

  it('adds all three unload-service flavors together plus kill-pid when every service artifact is present', () => {
    const inv = inventory({
      service: {
        containerIds: [],
        launchdPlist: '/home/u/Library/LaunchAgents/com.nanoclaw-v2-abcd1234.plist',
        systemdUserUnit: '/home/u/.config/systemd/user/nanoclaw-v2-abcd1234.service',
        systemdSystemUnit: '/etc/systemd/system/nanoclaw-v2-abcd1234.service',
        pidFile: '/proj/nanoclaw.pid',
      },
    });
    const actions = buildRemovalPlan(inv, allYes());
    const flavors = actions
      .filter((a) => a.kind === 'unload-service')
      .map((a) => (a.kind === 'unload-service' ? a.flavor : ''));
    expect(flavors).toEqual(['launchd', 'systemd-user', 'systemd-system']);
    expect(actions.some((a) => a.kind === 'kill-pid')).toBe(true);
  });

  it('adds no service actions at all when nothing in the service group is present', () => {
    const actions = buildRemovalPlan(inventory(), allYes());
    expect(actions.some((a) => a.kind === 'unload-service')).toBe(false);
    expect(actions.some((a) => a.kind === 'kill-pid')).toBe(false);
    // pkill-host and rm-containers still run unconditionally under d.service.
    expect(actions.some((a) => a.kind === 'pkill-host')).toBe(true);
    expect(actions.some((a) => a.kind === 'rm-containers')).toBe(true);
  });
});

describe('buildRemovalPlan — empty groups produce no items', () => {
  it('produces an empty plan for a completely empty inventory with all groups declined', () => {
    const actions = buildRemovalPlan(inventory(), { service: false, data: false, user: false, onecliDelete: [] });
    expect(actions).toEqual([]);
  });
});

// Standalone fixture-capture harness for validateSpec / mountAllowed.
//
// types.ts (copied verbatim from the pinned go-host-experiment checkout,
// src/drivers/types.ts, v2.3.0 / 54d9d9a5) has ZERO external imports — it is
// pure, self-contained TypeScript. That means these are the REAL functions
// from the real pinned baseline, executed for real, not reimplemented or
// guessed: the verdicts captured here are exactly what the TS host would
// produce, with no dependency on this project's own DB/Docker/mailbox stack.
import {
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type MountPolicy,
  type MountSpec,
  type SessionSpec,
  GROUP_FOLDER_LABEL,
} from './types.ts';

const policy: MountPolicy = {
  groupsRoot: '/data/groups',
  dataRoot: '/data',
  surfaceRoots: ['/app/container/agent-runner/src', '/app/container/skills', '/app/container/CLAUDE.md'],
  materialsRoot: '/data/session-materials',
};

const capabilities: DriverCapabilities = {
  isolationTiers: ['container'],
  admissionEnforced: false,
  networkPolicy: 'topology',
  encryptedVolumes: false,
  unrealized: [],
  sharedNetworkNamespace: true,
  auxiliaryContainers: false,
  imageBuild: true,
};

function baseSpec(mounts: MountSpec[], overrides: Partial<ContainerSpec> = {}): SessionSpec {
  return {
    key: { installSlug: 'test', agentGroupId: 'ag-1', sessionId: 'sess-1' },
    labels: { [GROUP_FOLDER_LABEL]: 'test-agent' },
    containers: [
      {
        role: 'agent',
        image: 'nanoclaw/agent-runner:latest',
        env: {},
        mounts,
        ...overrides,
      },
    ],
    network: 'shared-private',
    hardening: 'standard',
    resources: {},
    runtimeTier: 'container',
    stopGraceSeconds: 10,
  };
}

function mount(partial: Partial<MountSpec> & Pick<MountSpec, 'class' | 'hostPath' | 'containerPath'>): MountSpec {
  return { mode: 'rw', groupScope: 'ag-1', ...partial };
}

type Case = { name: string; spec: SessionSpec; expect: 'allow' | 'deny' };

const cases: Case[] = [
  // --- Baseline: a normal, legitimate mount set must still pass ---
  {
    name: 'normal-group-state-mount-allowed',
    spec: baseSpec([
      mount({
        class: 'group-state',
        hostPath: '/data/v2-sessions/ag-1/sess-1',
        containerPath: '/workspace',
        mode: 'rw',
      }),
    ]),
    expect: 'allow',
  },
  {
    name: 'normal-install-surface-readonly-allowed',
    spec: baseSpec([
      mount({
        class: 'install-surface',
        hostPath: '/app/container/agent-runner/src',
        containerPath: '/app/src',
        mode: 'ro',
      }),
    ]),
    expect: 'allow',
  },

  // --- Path traversal / non-canonical paths ---
  {
    name: 'path-traversal-dotdot-rejected',
    spec: baseSpec([
      mount({
        class: 'group-state',
        hostPath: '/data/v2-sessions/ag-1/sess-1/../../../etc',
        containerPath: '/workspace',
      }),
    ]),
    expect: 'deny',
  },
  {
    name: 'path-relative-rejected',
    spec: baseSpec([
      mount({ class: 'group-state', hostPath: 'data/v2-sessions/ag-1/sess-1', containerPath: '/workspace' }),
    ]),
    expect: 'deny',
  },
  {
    name: 'path-double-slash-rejected',
    spec: baseSpec([
      mount({ class: 'group-state', hostPath: '/data//v2-sessions/ag-1/sess-1', containerPath: '/workspace' }),
    ]),
    expect: 'deny',
  },
  {
    name: 'path-trailing-slash-rejected',
    spec: baseSpec([
      mount({ class: 'group-state', hostPath: '/data/v2-sessions/ag-1/sess-1/', containerPath: '/workspace' }),
    ]),
    expect: 'deny',
  },

  // --- Docker socket / forbidden host paths, via the allowlisted-extra class ---
  // NOTE: this is the exact PR #3680 gap on the pinned v2.3.0 baseline —
  // mountAllowed()'s 'allowlisted-extra' case returns true unconditionally,
  // with NO independent path re-check. This fixture's result is expected to
  // be 'allow' on today's pinned code, which is precisely the finding: it
  // demonstrates the gap exists, it does not mean the gap is acceptable.
  {
    name: 'docker-socket-via-allowlisted-extra-class-label',
    spec: baseSpec([
      mount({
        class: 'allowlisted-extra',
        hostPath: '/var/run/docker.sock',
        containerPath: '/var/run/docker.sock',
        mode: 'rw',
      }),
    ]),
    expect: 'deny', // what we WANT; the captured actual result below shows what validateSpec really does today
  },
  {
    name: 'ssh-dir-via-allowlisted-extra-class-label',
    spec: baseSpec([
      mount({ class: 'allowlisted-extra', hostPath: '/root/.ssh', containerPath: '/root/.ssh', mode: 'ro' }),
    ]),
    expect: 'deny', // same gap as above, different path
  },

  // --- Class-mislabeling: claiming a protected root under a permissive class ---
  {
    name: 'identity-material-relabeled-as-allowlisted-extra-into-agent',
    spec: baseSpec([
      mount({
        class: 'allowlisted-extra', // should be forced to 'identity-material' by classRequiredByPath
        hostPath: '/data/session-materials/ag-1/client.key',
        containerPath: '/run/session/client.key',
        mode: 'rw',
      }),
    ]),
    expect: 'deny',
  },
  {
    name: 'install-surface-relabeled-as-group-state-writable',
    spec: baseSpec([
      mount({
        class: 'group-state', // should be forced to 'install-surface' by classRequiredByPath
        hostPath: '/app/container/agent-runner/src',
        containerPath: '/app/src',
        mode: 'rw',
      }),
    ]),
    expect: 'deny',
  },

  // --- identity-material invariant: ro-only, never into the agent role ---
  {
    name: 'identity-material-into-agent-role-rejected',
    spec: baseSpec([
      mount({
        class: 'identity-material',
        hostPath: '/data/session-materials/ag-1/client.key',
        containerPath: '/run/session/client.key',
        mode: 'ro',
      }),
    ]),
    expect: 'deny', // container.role === 'agent' — identity-material may never enter it, regardless of mode
  },
  {
    name: 'identity-material-writable-rejected-even-on-non-agent-role',
    spec: baseSpec(
      [
        mount({
          class: 'identity-material',
          hostPath: '/data/session-materials/ag-1/client.key',
          containerPath: '/run/session/client.key',
          mode: 'rw',
        }),
      ],
      { role: 'proxy' },
    ),
    expect: 'deny',
  },

  // --- Cross-group access via group-state ---
  {
    name: 'cross-group-groupscope-mismatch-rejected',
    spec: baseSpec([
      mount({
        class: 'group-state',
        hostPath: '/data/v2-sessions/ag-2/sess-2', // a DIFFERENT group's session dir
        containerPath: '/workspace',
        groupScope: 'ag-2', // spec.key.agentGroupId is 'ag-1' — mismatch
      }),
    ]),
    expect: 'deny',
  },
  {
    name: 'cross-group-groupsroot-without-folder-label-rejected',
    spec: (() => {
      const s = baseSpec([
        mount({
          class: 'group-state',
          hostPath: '/data/groups/other-agent/plugins',
          containerPath: '/plugins',
          groupScope: 'ag-1',
        }),
      ]);
      s.labels = {}; // no GROUP_FOLDER_LABEL at all
      return s;
    })(),
    expect: 'deny',
  },
  {
    name: 'cross-group-groupsroot-wrong-folder-label-rejected',
    spec: baseSpec([
      mount({
        class: 'group-state',
        hostPath: '/data/groups/other-agent', // this session's own folder label is 'test-agent'
        containerPath: '/plugins',
        groupScope: 'ag-1',
      }),
    ]),
    expect: 'deny',
  },

  // --- Duplicate container paths ---
  {
    name: 'duplicate-containerpath-rejected',
    spec: baseSpec([
      mount({ class: 'group-state', hostPath: '/data/v2-sessions/ag-1/sess-1', containerPath: '/workspace' }),
      mount({ class: 'group-state', hostPath: '/data/v2-sessions/ag-1/sess-1b', containerPath: '/workspace' }),
    ]),
    expect: 'deny',
  },

  // --- Secret-shaped env values ---
  {
    name: 'secret-shaped-key-in-plain-env-rejected',
    spec: baseSpec([], { env: { ANTHROPIC_API_KEY: 'sk-abcdefghijklmnopqrstuvwx' } }),
    expect: 'deny',
  },
  {
    name: 'credential-shaped-value-under-innocuous-key-rejected',
    spec: baseSpec([], { env: { GW_CRED: 'sk-abcdefghijklmnopqrstuvwx' } }),
    expect: 'deny',
  },
  {
    name: 'credential-value-in-contributedEnv-rejected-even-though-key-name-exempt',
    spec: baseSpec([], { env: {}, contributedEnv: { ANTHROPIC_AUTH_TOKEN: 'sk-abcdefghijklmnopqrstuvwx' } }),
    expect: 'deny',
  },
  {
    name: 'path-value-in-contributedEnv-allowed-even-with-credential-shaped-key',
    spec: baseSpec([], { env: {}, contributedEnv: { PROXY_CLIENT_KEY: '/run/session/session-key.pem' } }),
    expect: 'allow',
  },
  {
    name: 'jwt-shaped-value-rejected',
    spec: baseSpec([], {
      env: { SOME_VAR: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
    }),
    expect: 'deny',
  },

  // --- Wrong isolation tier ---
  {
    name: 'runtime-tier-not-in-driver-isolation-tiers-rejected',
    spec: (() => {
      const s = baseSpec([]);
      s.runtimeTier = 'vm';
      return s;
    })(),
    expect: 'deny',
  },

  // --- Zero or multiple agent-role containers ---
  {
    name: 'zero-agent-containers-rejected',
    spec: (() => {
      const s = baseSpec([]);
      s.containers = [];
      return s;
    })(),
    expect: 'deny',
  },
  {
    name: 'two-agent-role-containers-rejected',
    spec: (() => {
      const s = baseSpec([]);
      s.containers = [
        { role: 'agent', image: 'a', env: {}, mounts: [] },
        { role: 'agent', image: 'b', env: {}, mounts: [] },
      ];
      return s;
    })(),
    expect: 'deny',
  },
];

let anyMismatch = false;
const results: Array<{ name: string; expect: string; actual: string; detail?: string }> = [];

for (const c of cases) {
  let actual: 'allow' | 'deny' = 'allow';
  let detail: string | undefined;
  try {
    validateSpec(c.spec, policy, capabilities);
  } catch (err) {
    actual = 'deny';
    detail = err instanceof Error ? err.message : String(err);
  }
  const flag = actual === c.expect ? 'OK  ' : 'DIFF';
  if (actual !== c.expect) anyMismatch = true;
  results.push({ name: c.name, expect: c.expect, actual, detail });
  console.log(`${flag} ${c.name}: expect=${c.expect} actual=${actual}${detail ? ` (${detail})` : ''}`);
}

console.log('\n--- summary ---');
console.log(`${results.length} cases run, ${results.filter((r) => r.expect !== r.actual).length} diverge from the 'expect' (desired-hardened) column.`);
console.log(anyMismatch ? 'Some cases diverge from the desired-hardened expectation — see docs/threat-model-addendum-p5.md for which are known, accepted gaps on the pinned baseline vs which are real bugs.' : 'All cases match.');

import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({ ONECLI_URL: 'http://localhost:1', ONECLI_API_KEY: 'unused' }));

import { contributionFromArgs } from './onecli.js';

// The exact host paths @onecli-sh/sdk's lib/index.js writes to (verified
// directly against the compiled SDK source, not assumed) — fixtures use
// these rather than made-up paths so this suite exercises the real
// host-path allowlist `isKnownOneCliHostPath` enforces, not just the argv
// shape grammar.
const CA_PATH = path.join(os.tmpdir(), 'onecli-proxy-ca.pem');
const COMBINED_CA_PATH = path.join(os.tmpdir(), 'onecli-combined-ca.pem');
const STUB_PATH = path.join(os.tmpdir(), 'onecli-stubs', 'onecli-stub-creds.json');

describe('contributionFromArgs', () => {
  it('types the closed grammar the SDK emits: -e pairs and ro mounts', () => {
    const contribution = contributionFromArgs(
      [
        '-e',
        'HTTPS_PROXY=http://host.docker.internal:15001',
        '-e',
        `SSL_CERT_FILE=${COMBINED_CA_PATH}`,
        '-v',
        `${CA_PATH}:/usr/local/share/ca.pem:ro`,
        '-v',
        `${STUB_PATH}:/workspace/.config/creds.json:ro`,
      ],
      'g1',
    );

    expect(contribution.env).toEqual({
      HTTPS_PROXY: 'http://host.docker.internal:15001',
      SSL_CERT_FILE: COMBINED_CA_PATH,
    });
    expect(contribution.mounts).toEqual([
      {
        class: 'allowlisted-extra',
        hostPath: CA_PATH,
        containerPath: '/usr/local/share/ca.pem',
        mode: 'ro',
        groupScope: 'g1',
        origin: 'provider',
      },
      {
        class: 'allowlisted-extra',
        hostPath: STUB_PATH,
        containerPath: '/workspace/.config/creds.json',
        mode: 'ro',
        groupScope: 'g1',
        origin: 'provider',
      },
    ]);
    // OneCLI runs on the install's own host, never in a driver-managed
    // container — a no-op for the kernel's network executor, but still a
    // required, correctly-shaped field on the contribution.
    expect(contribution.networkAccess).toEqual({ endpoint: 'http://localhost:1', target: { kind: 'host' } });
  });

  it('refuses argv outside the grammar — nothing rides raw around the spec again', () => {
    // Grammar drift in the SDK must break the spawn loudly, not smuggle flags.
    expect(() => contributionFromArgs(['--network', 'something'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', '/odd'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', 'h:c:rw:extra'], 'g1')).toThrow(/cannot type/);
  });

  // Regression coverage for a real gap found during the v2.4.0 promotion's
  // Workstream C6 security review: 'allowlisted-extra' mounts are admitted
  // with no host-path check at all, so argv-shape validation alone let a
  // compromised SDK/service name an arbitrary host path (e.g. an SSH key
  // directory) and have it mounted read-write into the agent container.
  describe('host-path allowlist', () => {
    it("refuses a grammatically valid -v mount whose host path is not one of the SDK's known outputs", () => {
      expect(() => contributionFromArgs(['-v', '/Users/operator/.ssh:/workspace/.ssh:ro'], 'g1')).toThrow(
        /not one of this SDK's known outputs/,
      );
    });

    it('refuses a path that only looks close to a known one (sibling file, wrong prefix, traversal)', () => {
      const siblingFile = path.join(os.tmpdir(), 'onecli-proxy-ca.pem.evil');
      const wrongStubName = path.join(os.tmpdir(), 'onecli-stubs', 'not-a-stub.json');
      const traversal = path.join(os.tmpdir(), 'onecli-stubs', '..', 'escaped');
      for (const hostPath of [siblingFile, wrongStubName, traversal]) {
        expect(() => contributionFromArgs(['-v', `${hostPath}:/x:ro`], 'g1')).toThrow(
          /not one of this SDK's known outputs/,
        );
      }
    });

    it('accepts the combined CA bundle path', () => {
      const contribution = contributionFromArgs(['-v', `${COMBINED_CA_PATH}:/tmp/onecli-combined-ca.pem:ro`], 'g1');
      expect(contribution.mounts?.[0]?.hostPath).toBe(COMBINED_CA_PATH);
    });

    it('accepts any correctly-prefixed stub filename, not just one fixed name', () => {
      const otherStub = path.join(os.tmpdir(), 'onecli-stubs', 'onecli-stub-other-cred.json');
      const contribution = contributionFromArgs(['-v', `${otherStub}:/x:ro`], 'g1');
      expect(contribution.mounts?.[0]?.hostPath).toBe(otherStub);
    });
  });
});

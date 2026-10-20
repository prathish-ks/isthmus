/**
 * TC-18 — credential isolation: no credential VALUE rides in a container's
 * environment, and identity material never enters the agent.
 *
 * This is the invariant CLAUDE.md states as a product promise ("Secrets are
 * injected into per-agent containers at request time — none are passed in env
 * vars or through chat context"), and drivers/types.ts implements it as an
 * admission rule. Until now `isSecretShaped` and `looksLikeCredential` — the
 * two functions the whole rule rests on — had no direct test at all;
 * types.coverage.test.ts covers only mount classing. A silent narrowing of
 * either predicate would have gone unnoticed, which is precisely the failure
 * mode worth a regression test: the rule fails OPEN, admitting the credential
 * rather than denying the session.
 *
 * Scope: this covers the HOST-side admission rule — what a container is
 * allowed to be launched with. It does not, and cannot here, prove what a
 * running agent can read from inside its own filesystem; that is the mount
 * classes (exercised by the conformance and docker-driver suites) plus
 * Docker's own enforcement.
 */
import { describe, expect, it } from 'vitest';

import { fixtureSpec, fixtureSpecWithAux, FIXTURE_POLICY } from './spec-fixture.js';
import { isSecretShaped, looksLikeCredential, validateSpec } from './types.js';

/**
 * Issuer-assigned shapes the predicate claims to recognise.
 *
 * Every value here is a non-functional example — the published documentation
 * sample for its issuer (AWS's own `AKIAIOSFODNN7EXAMPLE`, jwt.io's HS256
 * sample) or an obvious `ABCDEF…` placeholder. None authenticates anywhere,
 * and none ever did. They have to be literally secret-shaped: a test for a
 * secret-shape predicate that held no secret-shaped strings would prove
 * nothing. The two `nosemgrep` lines below are the unavoidable consequence —
 * the scanner matches on shape, which is exactly the property under test.
 */
const REAL_CREDENTIALS: Array<[string, string]> = [
  ['Anthropic/OpenAI sk-', 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub PAT (classic)', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub OAuth', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub fine-grained', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['Slack bot token', 'xoxb-1234567890-ABCDEFGHIJ'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  // nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'],
  ['inline PEM private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'],
];

/**
 * Values that must NOT trip the predicate. A false positive here does not
 * warn — it denies every session, fail-closed — which is why the predicate is
 * prefix-matching rather than entropy-scoring (see its own comment).
 */
const ORDINARY_CONFIG: Array<[string, string]> = [
  ['an image digest', 'sha256:9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'],
  ['a UUID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
  ['an IANA timezone', 'Europe/London'],
  ['a base64-ish fingerprint', 'MEUCIQDf8kR2bQ=='],
  ['a short sk- lookalike', 'sk-tooshort'],
  ['a plain version', 'claude-opus-5'],
  ['an empty value', ''],
];

describe('looksLikeCredential — issuer-assigned shapes', () => {
  it.each(REAL_CREDENTIALS)('recognises %s', (_label, value) => {
    expect(looksLikeCredential(value)).toBe(true);
  });

  it.each(ORDINARY_CONFIG)('leaves %s alone', (_label, value) => {
    expect(looksLikeCredential(value)).toBe(false);
  });
});

describe('isSecretShaped — the admission rule measures BOTH key and value', () => {
  it('catches a credential-named key carrying anything', () => {
    // The name half: whatever the value is, these names have no business in a
    // container environment.
    expect(isSecretShaped('ANTHROPIC_API_KEY', 'whatever')).toBe(true);
    expect(isSecretShaped('GITHUB_TOKEN', 'whatever')).toBe(true);
    expect(isSecretShaped('SOME_SECRET', 'whatever')).toBe(true);
    expect(isSecretShaped('DB_PASSWORD', 'whatever')).toBe(true);
    expect(isSecretShaped('db_password', 'whatever')).toBe(true); // case-insensitive
  });

  it('catches a credential VALUE however innocuously the key is named', () => {
    // The value half, and the reason the name check alone is not enough —
    // the name is chosen by whoever is leaking. These three are the exact
    // examples isSecretShaped's own doc comment calls out.
    for (const key of ['ANTHROPIC_AUTH', 'GW_CRED', 'SESSION_BEARER', 'HARMLESS_LOOKING']) {
      expect(isSecretShaped(key, 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe(true);
    }
  });

  it('admits ordinary configuration under an ordinary key', () => {
    expect(isSecretShaped('TZ', 'Europe/London')).toBe(false);
    expect(isSecretShaped('NANOCLAW_SESSION_ID', '3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(false);
  });

  it('admits a path into a DECLARED mount — material travels by reference', () => {
    // The documented pattern: mount the file read-only, put its path in the
    // env var. A key-name check alone would deny every session whose
    // auxiliary containers need their own client key.
    const targets = ['/run/session', '/run/session/tls'];
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/run/session/session-key.pem', targets)).toBe(false);
    expect(isSecretShaped('TLS_SECRET', '/run/session/tls/cert.pem', targets)).toBe(false);
  });

  it('grants no exemption when the caller supplies no mount context', () => {
    // Fail-closed by default: a caller holding only an env snapshot cannot
    // verify any mount, so it gets the strict rule.
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/run/session/session-key.pem')).toBe(true);
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/run/session/session-key.pem', [])).toBe(true);
  });
});

describe('validateSpec — the rule is enforced at admission, not merely available', () => {
  it('denies an agent container carrying a credential-named env var', () => {
    const spec = fixtureSpec();
    spec.containers[0].env.ANTHROPIC_API_KEY = 'anything-at-all';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/secret-shaped env 'ANTHROPIC_API_KEY'/);
  });

  it('denies a credential VALUE hidden under an innocuous env name', () => {
    const spec = fixtureSpec();
    // Placeholder, not a token — see REAL_CREDENTIALS' note above.
    // nosemgrep: generic.secrets.security.detected-github-token.detected-github-token
    spec.containers[0].env.HARMLESS = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/secret-shaped env 'HARMLESS'/);
  });

  it('allows a path-valued credential-named env var on the container that mounts it', () => {
    // The auxiliary fixture: containers[1] is the egress-proxy, which the
    // fixture gives /run/session/session-key.pem as a mount target. Passing
    // material by reference, as documented.
    const spec = fixtureSpecWithAux();
    const proxy = spec.containers[1];
    expect(proxy.mounts.map((m) => m.containerPath)).toContain('/run/session/session-key.pem');
    proxy.env.PROXY_CLIENT_KEY = '/run/session/session-key.pem';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
  });

  it('refuses a malformed mount destination outright', () => {
    // The admission half of the degenerate-target case. Rejecting the spec is
    // better than merely ignoring the target, because a destination of '' or
    // '/' is malformed on its own terms — the duplicate-target check above it
    // is meaningless on such a value too, and the kernel should not be
    // relying on a runtime to refuse what it could refuse itself.
    for (const junk of ['', '/', '/workspace/', '/work/../space']) {
      const spec = fixtureSpec();
      spec.containers[0].mounts[0].containerPath = junk;
      expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(
        /mount destination .* must be a canonical absolute path/,
      );
    }
  });

  it('a malformed destination cannot buy an exemption for a secret in the same container', () => {
    // The two halves together, as the end-to-end claim: this is the exact
    // spec shape that reached admission unrejected before, with the secret
    // riding along beside the malformed mount.
    const spec = fixtureSpec();
    spec.containers[0].mounts[0].containerPath = '';
    spec.containers[0].env.DB_PASSWORD = '/wEAAAABx/AQIDBAUGBwgJCgsMDQ4PEBESExQ';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow();
  });

  it('denies the same path on a container that does not mount it', () => {
    // The sharp edge the exemption's old shape test could not see. This value
    // is a legitimate mount reference ON THE PROXY, and byte-for-byte the
    // same string here — but the agent has no such mount, so for the agent it
    // is just an opaque string under a credential-named key. Admitting it
    // would restate the identity-material leak the mount rules already deny:
    // the agent naming the proxy's client key.
    const spec = fixtureSpec();
    const agent = spec.containers[0];
    expect(agent.mounts.map((m) => m.containerPath)).not.toContain('/run/session/session-key.pem');
    agent.env.PROXY_CLIENT_KEY = '/run/session/session-key.pem';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/secret-shaped env 'PROXY_CLIENT_KEY'/);
  });

  it('the contributed lane permits credential NAMES — that is its purpose', () => {
    // A provider registering ANTHROPIC_AUTH_TOKEN=placeholder for the proxy to
    // overwrite is the pattern working as intended; the name check alone would
    // deny every such install.
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { ANTHROPIC_AUTH_TOKEN: 'placeholder' };
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
  });

  it('the contributed lane still refuses credential VALUES, from anyone', () => {
    const spec = fixtureSpec();
    spec.containers[0].contributedEnv = { ANTHROPIC_AUTH_TOKEN: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123' };
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/credential value in contributed env/);
  });

  it('never mounts identity material into the agent, even read-only', () => {
    // The no-credentials invariant as a mount rule: identity materials are
    // ro-only and belong to auxiliary roles, never the agent.
    const spec = fixtureSpec();
    const agent = spec.containers.find((c) => c.role === 'agent');
    expect(agent).toBeDefined();
    agent!.mounts.push({
      class: 'identity-material',
      hostPath: `${FIXTURE_POLICY.materialsRoot}/session-key.pem`,
      containerPath: '/run/session/session-key.pem',
      mode: 'ro',
      groupScope: 'g1',
    });
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/identity-material mount .* invalid on role agent/);
  });
});

describe('the path exemption cannot be bought with any choice of bytes', () => {
  // Regression, and a record of two wrong answers. The exemption is tested
  // FIRST and short-circuits both checks, so anything it admits is admitted
  // unconditionally. It was twice written as a test on the value's SHAPE:
  //
  //   ^\/[^\s]*$                 admitted any opaque token starting with '/',
  //                              and base64 may legitimately start with '/'.
  //   ^\/(?:[^\s/]+\/)+[^\s/]+$  required a segment PAIR — but base64's
  //                              alphabet CONTAINS '/', so a secret can carry
  //                              interior separators just as easily.
  //
  // The second fix was mine, and the comment shipped with it asserted that a
  // segment pair "keeps every real mount path working while a single opaque
  // token no longer buys exemption" — true of the examples I checked, false
  // of base64 in general. The rule is now membership in a declared mount
  // target, which is not a property of the bytes at all.
  const DECLARED = ['/run/session', '/workspace', '/install/data/gateway-trust', '/home/node/.claude'];

  it('denies an opaque single-segment token under a credential-named key', () => {
    expect(isSecretShaped('DB_PASSWORD', '/wEAAAABxyzQWERTYUIOP0123456789', DECLARED)).toBe(true);
  });

  it('denies base64 carrying interior separators, however many', () => {
    for (const v of [
      '/wEAAAABx/AQIDBAUGBwgJCgsMDQ4PEBESExQ',
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA', // a JPEG's base64 head
      '/a/b/c/d/e/f/g/h',
    ]) {
      expect(isSecretShaped('DB_PASSWORD', v, DECLARED)).toBe(true);
    }
  });

  it('denies it identically with or without the leading slash', () => {
    const bytes = 'wEAAAABxyzQWERTYUIOP0123456789';
    expect(isSecretShaped('DB_PASSWORD', `/${bytes}`, DECLARED)).toBe(isSecretShaped('DB_PASSWORD', bytes, DECLARED));
  });

  it('still admits every real mount path, and the target itself', () => {
    for (const p of [
      '/run/session/session-key.pem',
      '/workspace/agent/memory',
      '/install/data/gateway-trust/ca.pem',
      '/home/node/.claude/settings.json',
      '/workspace',
    ]) {
      expect(isSecretShaped('PROXY_CLIENT_KEY', p, DECLARED)).toBe(false);
    }
  });

  it('refuses a non-canonical path that would otherwise appear contained', () => {
    // '..' must not walk out of a declared target and still collect the
    // exemption the containment test would hand it.
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/workspace/../etc/shadow', DECLARED)).toBe(true);
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/workspace//agent', DECLARED)).toBe(true);
  });

  it('ignores a degenerate target that would otherwise contain everything', () => {
    // '' and '/' both leave an empty prefix, and an empty prefix contains
    // every absolute path — so a single malformed mount destination would
    // exempt every value in the container's environment, which is the whole
    // rule inverted by one bad string. The predicate must discard such a
    // target rather than honour it.
    for (const junk of ['', '/', '/workspace/', '/work/../space', '//workspace']) {
      expect(isSecretShaped('DB_PASSWORD', '/wEAAAABx/AQIDBAUGBwgJCgsMDQ4PEBESExQ', [junk])).toBe(true);
    }
  });

  it('still honours the valid targets alongside a degenerate one', () => {
    // Discarding the junk target must not discard the real one next to it.
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/workspace/agent/memory', ['', '/workspace'])).toBe(false);
  });

  it('is not fooled by a target name that is only a string prefix', () => {
    // '/workspace-evil' starts with '/workspace' as text but is a different
    // directory, so the containment test must compare path segments.
    expect(isSecretShaped('DB_PASSWORD', '/workspace-evil/leak', DECLARED)).toBe(true);
  });
});

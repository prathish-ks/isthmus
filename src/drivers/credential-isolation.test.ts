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

import { fixtureSpec, FIXTURE_POLICY } from './spec-fixture.js';
import { isSecretShaped, looksLikeCredential, validateSpec } from './types.js';

/** Issuer-assigned shapes the predicate claims to recognise. */
const REAL_CREDENTIALS: Array<[string, string]> = [
  ['Anthropic/OpenAI sk-', 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub PAT (classic)', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub OAuth', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['GitHub fine-grained', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
  ['Slack bot token', 'xoxb-1234567890-ABCDEFGHIJ'],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
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

  it('admits a PATH under a credential-named key — material travels by reference', () => {
    // The documented pattern: mount the file read-only, put its path in the
    // env var. A key-name check alone would deny every session whose
    // auxiliary containers need their own client key.
    expect(isSecretShaped('PROXY_CLIENT_KEY', '/run/session/session-key.pem')).toBe(false);
    expect(isSecretShaped('TLS_SECRET', '/run/session/tls/cert.pem')).toBe(false);
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
    spec.containers[0].env.HARMLESS = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).toThrow(/secret-shaped env 'HARMLESS'/);
  });

  it('allows a path-valued credential-named env var through', () => {
    const spec = fixtureSpec();
    spec.containers[0].env.PROXY_CLIENT_KEY = '/run/session/session-key.pem';
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
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

describe('the path exemption cannot be bought with a leading slash', () => {
  // Regression: the exemption was `^\/[^\s]*$` and is tested FIRST, so it
  // short-circuits both checks below — and base64 may legitimately begin with
  // '/'. `DB_PASSWORD=/wEAAAABxyz…` was therefore admitted while the identical
  // bytes without the slash were denied: the one exemption documented as
  // unable to admit a credential's bytes, doing exactly that. Now requires a
  // '/'-separated segment pair.
  it('denies an opaque single-segment token under a credential-named key', () => {
    expect(isSecretShaped('DB_PASSWORD', '/wEAAAABxyzQWERTYUIOP0123456789')).toBe(true);
  });

  it('denies it identically with or without the leading slash', () => {
    const bytes = 'wEAAAABxyzQWERTYUIOP0123456789';
    expect(isSecretShaped('DB_PASSWORD', `/${bytes}`)).toBe(isSecretShaped('DB_PASSWORD', bytes));
  });

  it('still admits every real mount-path shape', () => {
    // Each is rooted under a mount directory, so each has a segment pair.
    for (const p of [
      '/run/session/session-key.pem',
      '/workspace/agent/memory',
      '/install/data/gateway-trust/ca.pem',
      '/home/node/.claude/settings.json',
    ]) {
      expect(isSecretShaped('PROXY_CLIENT_KEY', p)).toBe(false);
    }
  });
});

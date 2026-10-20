package mount

import "testing"

// TC-18 credential isolation — the env admission rule's one exemption, kept in
// lockstep with types.ts's isSecretShaped.
//
// History, because it is the argument for the current shape. The exemption is
// tested FIRST and short-circuits both the key-name and the value check, so
// anything it admits is admitted unconditionally. It was twice written as a
// test on the value's SHAPE, and each shape admitted credential bytes:
//
//	^/[^\s]*$                 any opaque token beginning with '/'. Base64 may
//	                          legitimately begin with '/', so
//	                          DB_PASSWORD=/wEAAAABxyz… was exempt.
//	^/(?:[^\s/]+/)+[^\s/]+$   required a '/'-separated segment pair. But
//	                          base64's alphabet CONTAINS '/', so a secret can
//	                          carry interior separators too:
//	                          DB_PASSWORD=/wEAAAABx/AQIDB… was exempt, while
//	                          the comment claimed the exemption could not
//	                          admit a credential's bytes.
//
// The fix is a different kind of test, not a stricter one of the same kind: a
// value is exempt only if it points into a mount THIS CONTAINER DECLARES.
// A declared mount target cannot be guessed from the value, so no choice of
// bytes buys exemption.
//
// This matters more on the Go side than the TypeScript one: the kernel is the
// enforcement point, so a divergence between the two predicates would mean the
// host admits what the kernel denies, or worse the reverse. The TypeScript twin
// is src/drivers/credential-isolation.test.ts.

// The container that legitimately passes material by reference.
var proxyTargets = []string{"/run/session/session-key.pem", "/run/session/upstream-ca.pem"}

func TestIsSecretShaped_SingleSegmentTokenIsNotAPath(t *testing.T) {
	if !IsSecretShaped("DB_PASSWORD", "/wEAAAABxyzQWERTYUIOP0123456789", proxyTargets) {
		t.Fatal("an opaque single-segment token must not buy exemption by starting with '/'")
	}
}

// The regression the second shape test missed: base64 with interior '/'.
func TestIsSecretShaped_MultiSegmentTokenIsNotAPath(t *testing.T) {
	for _, v := range []string{
		"/wEAAAABx/AQIDBAUGBwgJCgsMDQ4PEBESExQ",
		"/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA", // a JPEG's base64 head
		"/a/b/c/d/e/f/g/h",                   // many segments buy nothing either
	} {
		if !IsSecretShaped("DB_PASSWORD", v, proxyTargets) {
			t.Fatalf("a token shaped like a path, under a credential-named key, must be denied: %s", v)
		}
	}
}

func TestIsSecretShaped_LeadingSlashChangesNothing(t *testing.T) {
	const bytes = "wEAAAABxyzQWERTYUIOP0123456789"
	if IsSecretShaped("DB_PASSWORD", "/"+bytes, proxyTargets) != IsSecretShaped("DB_PASSWORD", bytes, proxyTargets) {
		t.Fatal("the same bytes must classify identically with and without a leading slash")
	}
}

// The pattern the exemption exists for: the path names a mount this container
// declares, so it is a pointer into class-governed storage.
func TestIsSecretShaped_DeclaredMountPathsAreExempt(t *testing.T) {
	targets := []string{"/run/session", "/workspace", "/install/data/gateway-trust", "/home/node/.claude"}
	for _, p := range []string{
		"/run/session/session-key.pem",
		"/workspace/agent/memory",
		"/install/data/gateway-trust/ca.pem",
		"/home/node/.claude/settings.json",
		"/run/session", // the target itself, not only a file under it
	} {
		if IsSecretShaped("PROXY_CLIENT_KEY", p, targets) {
			t.Fatalf("a path into a declared mount must stay exempt: %s", p)
		}
	}
}

// The same path, on a container that does not mount it, is not a pointer.
func TestIsSecretShaped_UndeclaredPathEarnsNoExemption(t *testing.T) {
	agentTargets := []string{"/workspace", "/app/src"}
	if !IsSecretShaped("PROXY_CLIENT_KEY", "/run/session/session-key.pem", agentTargets) {
		t.Fatal("a path the container does not mount must not be exempt")
	}
}

// No mount context at all means no exemption — fail-closed, the default
// securitycheck.checkCredentialExposure relies on.
func TestIsSecretShaped_NoTargetsMeansNoExemption(t *testing.T) {
	for _, targets := range [][]string{nil, {}} {
		if !IsSecretShaped("PROXY_CLIENT_KEY", "/run/session/session-key.pem", targets) {
			t.Fatal("with no declared targets, nothing earns the exemption")
		}
	}
}

// '..' must not let an undeclared path pose as a declared one.
func TestIsSecretShaped_DotDotCannotForgeContainment(t *testing.T) {
	targets := []string{"/run/session"}
	if !IsSecretShaped("PROXY_CLIENT_KEY", "/run/session/../../etc/shadow", targets) {
		t.Fatal("a non-canonical path must not reach the containment test")
	}
}

// The value half must keep working regardless of how the key is named — the
// name is chosen by whoever is leaking.
func TestIsSecretShaped_CredentialValueUnderInnocuousKey(t *testing.T) {
	for _, key := range []string{"ANTHROPIC_AUTH", "GW_CRED", "SESSION_BEARER", "HARMLESS_LOOKING"} {
		if !IsSecretShaped(key, "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", proxyTargets) {
			t.Fatalf("credential value must be caught under key %s", key)
		}
	}
}

package mount

import "testing"

// TC-18 credential isolation — the path-exemption tightening, kept in lockstep
// with types.ts's isSecretShaped.
//
// The exemption was `^/[^\s]*$` and is tested FIRST, short-circuiting both the
// key-name and the value check. Base64 may legitimately begin with '/', so a
// secret of that shape under a credential-named key was admitted — the one
// exemption whose comment promised it could not admit a credential's bytes
// doing exactly that. Both sides now require a '/'-separated segment pair.
//
// This matters more on the Go side than the TypeScript one: the kernel is the
// enforcement point, so a divergence between the two predicates would mean the
// host admits what the kernel denies, or worse the reverse. The TypeScript twin
// is src/drivers/credential-isolation.test.ts.

func TestIsSecretShaped_SingleSegmentTokenIsNotAPath(t *testing.T) {
	if !IsSecretShaped("DB_PASSWORD", "/wEAAAABxyzQWERTYUIOP0123456789") {
		t.Fatal("an opaque single-segment token must not buy exemption by starting with '/'")
	}
}

func TestIsSecretShaped_LeadingSlashChangesNothing(t *testing.T) {
	const bytes = "wEAAAABxyzQWERTYUIOP0123456789"
	if IsSecretShaped("DB_PASSWORD", "/"+bytes) != IsSecretShaped("DB_PASSWORD", bytes) {
		t.Fatal("the same bytes must classify identically with and without a leading slash")
	}
}

func TestIsSecretShaped_RealMountPathsStillExempt(t *testing.T) {
	for _, p := range []string{
		"/run/session/session-key.pem",
		"/workspace/agent/memory",
		"/install/data/gateway-trust/ca.pem",
		"/home/node/.claude/settings.json",
	} {
		if IsSecretShaped("PROXY_CLIENT_KEY", p) {
			t.Fatalf("real mount path must stay exempt: %s", p)
		}
	}
}

// The value half must keep working regardless of how the key is named — the
// name is chosen by whoever is leaking.
func TestIsSecretShaped_CredentialValueUnderInnocuousKey(t *testing.T) {
	for _, key := range []string{"ANTHROPIC_AUTH", "GW_CRED", "SESSION_BEARER", "HARMLESS_LOOKING"} {
		if !IsSecretShaped(key, "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
			t.Fatalf("credential value must be caught under key %s", key)
		}
	}
}

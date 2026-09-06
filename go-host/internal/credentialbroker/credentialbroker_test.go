package credentialbroker

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

func fakeClock(start time.Time) (*time.Time, func() time.Time) {
	t := start
	return &t, func() time.Time { return t }
}

// TestToken_HasNoSecretField pins a structural (not just behavioral)
// property: Token cannot hold a secret because it has no field shaped to.
// A future edit that added e.g. a "Value" or "Secret" field would need to
// change this test's expected field list, making the change visible in
// review rather than silently widening what Token can carry.
func TestToken_HasNoSecretField(t *testing.T) {
	typ := reflect.TypeOf(Token{})
	want := []string{"ID", "SessionID", "Scope", "IssuedAt", "ExpiresAt"}
	if typ.NumField() != len(want) {
		t.Fatalf("Token has %d fields, want exactly %d (%v)", typ.NumField(), len(want), want)
	}
	for i, name := range want {
		if typ.Field(i).Name != name {
			t.Fatalf("Token field %d = %q, want %q", i, typ.Field(i).Name, name)
		}
	}
}

func TestIssue_RejectsForgedSessionID(t *testing.T) {
	b := NewBroker()
	_, err := b.Issue("../../etc/passwd", "chat", "sk-real-secret-value", time.Minute)
	if err == nil {
		t.Fatal("expected an error issuing to a path-shaped session id")
	}
}

func TestIssue_ReturnedTokenNeverContainsTheSecretValue(t *testing.T) {
	b := NewBroker()
	secret := "sk-super-secret-do-not-leak-1234567890"
	tok, err := b.Issue("sess-1", "chat", secret, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if tok.ID == secret || tok.SessionID == secret || tok.Scope == secret {
		t.Fatal("the secret value must never appear in any Token field")
	}
}

func TestBuildAgentEnv_NeverContainsTheSecretValue(t *testing.T) {
	b := NewBroker()
	secret := "sk-super-secret-do-not-leak-1234567890"
	tok, err := b.Issue("sess-1", "chat", secret, time.Hour)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	env := BuildAgentEnv("ONECLI_CRED_TOKEN", tok)
	for k, v := range env {
		if v == secret {
			t.Fatalf("env var %q leaked the raw secret value", k)
		}
	}
	if env["ONECLI_CRED_TOKEN"] != tok.ID {
		t.Fatalf("expected env to carry the token's opaque ID, got %q", env["ONECLI_CRED_TOKEN"])
	}
	// The env value should not even look credential-shaped, on top of not
	// being the real secret — an opaque short id, not a key-like string.
	if mount.LooksLikeCredential(env["ONECLI_CRED_TOKEN"]) {
		t.Fatal("the opaque token id should not itself look credential-shaped")
	}
}

// TestResolve_WorksDuringWindowThenFailsAfterExpiry is this package's own
// before/after expiry proof, the same shape internal/capability's P8-02
// test uses: the SAME token, checked twice, only the clock advanced.
func TestResolve_WorksDuringWindowThenFailsAfterExpiry(t *testing.T) {
	start := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	clockVal, clock := fakeClock(start)
	b := NewBrokerWithClock(clock)

	secret := "sk-live-secret"
	tok, err := b.Issue("sess-1", "chat", secret, 5*time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	got, err := b.Resolve(tok.ID)
	if err != nil {
		t.Fatalf("Resolve during window: %v", err)
	}
	if got != secret {
		t.Fatalf("Resolve returned %q, want the original secret", got)
	}

	*clockVal = tok.ExpiresAt.Add(time.Second)

	_, err = b.Resolve(tok.ID)
	if !errors.Is(err, ErrExpiredToken) {
		t.Fatalf("Resolve after expiry: got err=%v, want ErrExpiredToken", err)
	}
}

func TestResolve_UnknownTokenFails(t *testing.T) {
	b := NewBroker()
	_, err := b.Resolve("no-such-token")
	if !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("got err=%v, want ErrUnknownToken", err)
	}
}

func TestValidate_WrongSessionDenied(t *testing.T) {
	b := NewBroker()
	tok, _ := b.Issue("sess-1", "chat", "secret", time.Hour)
	ok, _ := b.Validate("sess-2", tok.ID, "chat")
	if ok {
		t.Fatal("a token issued to sess-1 must not validate for sess-2")
	}
}

func TestValidate_WrongScopeDenied(t *testing.T) {
	b := NewBroker()
	tok, _ := b.Issue("sess-1", "chat", "secret", time.Hour)
	ok, _ := b.Validate("sess-1", tok.ID, "admin")
	if ok {
		t.Fatal("a token scoped to chat must not validate for a different scope")
	}
}

// TestValidate_ExpiredTokenDenied is P9-04's "stale state" case for this
// package: TestResolve_WorksDuringWindowThenFailsAfterExpiry already pins
// Resolve's own expiry check, but Validate has its own separate
// `b.now().After(tok.ExpiresAt)` branch (a token can be Validated by a
// component that never calls Resolve at all) — this test exists so that
// branch has direct coverage of its own, rather than relying on Resolve's
// test to stand in for it.
func TestValidate_ExpiredTokenDenied(t *testing.T) {
	start := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	clockVal, clock := fakeClock(start)
	b := NewBrokerWithClock(clock)

	tok, err := b.Issue("sess-1", "chat", "secret", 5*time.Minute)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}

	if ok, reason := b.Validate("sess-1", tok.ID, "chat"); !ok {
		t.Fatalf("expected validation to pass during the live window, got denial: %s", reason)
	}

	*clockVal = tok.ExpiresAt.Add(time.Second)

	ok, reason := b.Validate("sess-1", tok.ID, "chat")
	if ok {
		t.Fatal("Validate must deny a token past its ExpiresAt, even though it was never revoked")
	}
	if reason == "" {
		t.Fatal("expected a non-empty denial reason for an expired token")
	}
}

func TestValidate_CorrectSessionAndScopeAllowed(t *testing.T) {
	b := NewBroker()
	tok, _ := b.Issue("sess-1", "chat", "secret", time.Hour)
	ok, reason := b.Validate("sess-1", tok.ID, "chat")
	if !ok {
		t.Fatalf("expected validation to pass, got denial: %s", reason)
	}
}

func TestRevoke_InvalidatesResolveAndValidateBeforeNaturalExpiry(t *testing.T) {
	b := NewBroker()
	tok, _ := b.Issue("sess-1", "chat", "secret", time.Hour)
	b.Revoke(tok.ID)

	if _, err := b.Resolve(tok.ID); !errors.Is(err, ErrUnknownToken) {
		t.Fatalf("Resolve after revoke: got err=%v, want ErrUnknownToken", err)
	}
	if ok, _ := b.Validate("sess-1", tok.ID, "chat"); ok {
		t.Fatal("Validate after revoke should deny")
	}
}

func TestRevoke_UnknownTokenIsANoOp(t *testing.T) {
	b := NewBroker()
	b.Revoke("no-such-token") // must not panic
}

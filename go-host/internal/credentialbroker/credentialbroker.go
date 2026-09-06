// Package credentialbroker implements P8-04 (Phase 8 — Capability
// Security): a prototype scoped, expiring credential-token flow, proving
// the task's own done-when — "the agent can perform an authorized action
// without exposing a long-lived credential in its environment."
//
// This is a different mechanism from internal/credential (P5-05's OneCLI
// trace), not a replacement for it. internal/credential already proves the
// REAL, shipped credential flow never puts a value in env
// (security.TestInvariant_RealCredentialFlowNeverPutsAValueInEnv) — that
// flow rides by reference (a mounted stub file), and this package doesn't
// change or duplicate it. What this package prototypes instead: a
// short-lived, scoped TOKEN a session can be handed and later present,
// where the token itself is an opaque reference — never the underlying
// secret. The real secret value lives only inside the Broker; Resolve
// (which a trusted gateway/proxy would call, never the agent container
// itself) is the only path from a token back to a secret, and it enforces
// the token's expiry as a real check, not a documented expectation.
package credentialbroker

import (
	"errors"
	"sync"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/ownership"
)

// Token is what crosses to the agent side (e.g. as one env var value). It
// deliberately has no field capable of holding a secret — see
// TestToken_HasNoSecretField, which pins this as a structural property, the
// same "no such field exists" discipline internal/kernel's
// CapabilityRequestPayload already uses for its build-context directory.
type Token struct {
	ID        string
	SessionID string
	Scope     string
	IssuedAt  time.Time
	ExpiresAt time.Time
}

var (
	// ErrUnknownToken is returned by Resolve/Validate/Revoke for a token ID
	// that was never issued, or was already revoked.
	ErrUnknownToken = errors.New("credentialbroker: unknown or revoked token")
	// ErrExpiredToken is returned by Resolve/Validate for a token whose
	// ExpiresAt has passed — a known, live token that is simply no longer
	// usable, distinct from ErrUnknownToken.
	ErrExpiredToken = errors.New("credentialbroker: token expired")
)

// Broker issues scoped, expiring Tokens and resolves a still-valid one back
// to its underlying secret value — a step only a trusted caller (the
// gateway/proxy, never the agent container) should ever take. In-memory
// only, matching this task's own "prototype" scope.
type Broker struct {
	mu      sync.Mutex
	tokens  map[string]Token
	secrets map[string]string // tokenID -> secret value; never exposed via Token itself
	now     func() time.Time
	next    int
}

// NewBroker returns a Broker using the real wall clock.
func NewBroker() *Broker { return newBroker(time.Now) }

// NewBrokerWithClock returns a Broker whose notion of "now" is now —
// exported so tests can advance time deterministically instead of sleeping.
func NewBrokerWithClock(now func() time.Time) *Broker { return newBroker(now) }

func newBroker(now func() time.Time) *Broker {
	return &Broker{tokens: make(map[string]Token), secrets: make(map[string]string), now: now}
}

// Issue mints a Token scoped to sessionID and scope, valid for ttl, that
// resolves (via Resolve) to secretValue while it's live. secretValue never
// appears anywhere in the returned Token — it is stored broker-side only,
// keyed by the token's own ID.
func (b *Broker) Issue(sessionID, scope, secretValue string, ttl time.Duration) (Token, error) {
	if err := ownership.ValidateID(sessionID, "sessionId"); err != nil {
		return Token{}, err
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	now := b.now()
	b.next++
	tok := Token{
		ID:        "cred-" + itoa(b.next),
		SessionID: sessionID,
		Scope:     scope,
		IssuedAt:  now,
		ExpiresAt: now.Add(ttl),
	}
	b.tokens[tok.ID] = tok
	b.secrets[tok.ID] = secretValue
	return tok, nil
}

// Resolve exchanges a still-valid token for its underlying secret. This is
// the ONE path from token to secret in this package, and it is the actual
// enforcement point: an expired or unknown token returns an error, not the
// secret — the same "denial, not advisory" shape internal/kernel's
// capability.request already applies to Docker-facing capabilities.
// Callers representing the agent side of this flow should never call
// Resolve themselves; only a trusted gateway/proxy component would.
func (b *Broker) Resolve(tokenID string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	tok, ok := b.tokens[tokenID]
	if !ok {
		return "", ErrUnknownToken
	}
	if b.now().After(tok.ExpiresAt) {
		return "", ErrExpiredToken
	}
	return b.secrets[tokenID], nil
}

// Validate reports whether tokenID is live (unexpired, unrevoked) and
// scoped to expectedScope for sessionID — the check an agent-facing
// component would run before trusting a token presented back to it,
// without ever needing the secret itself.
func (b *Broker) Validate(sessionID, tokenID, expectedScope string) (bool, string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	tok, ok := b.tokens[tokenID]
	if !ok {
		return false, "unknown or revoked token"
	}
	if tok.SessionID != sessionID {
		return false, "token was not issued to this session"
	}
	if tok.Scope != expectedScope {
		return false, "token scope does not match"
	}
	if b.now().After(tok.ExpiresAt) {
		return false, "token expired at " + tok.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return true, ""
}

// Revoke immediately invalidates tokenID, before its natural expiry.
// Idempotent: revoking an unknown or already-revoked token is a no-op.
func (b *Broker) Revoke(tokenID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.tokens, tokenID)
	delete(b.secrets, tokenID)
}

// BuildAgentEnv demonstrates the actual claim this package prototypes:
// constructing the env map a container launch would set, using only tok's
// opaque ID — never a secret value. envKey is caller-chosen (e.g.
// "ONECLI_CRED_TOKEN") so this stays a generic demonstration rather than
// hard-coding one real provider's variable name.
func BuildAgentEnv(envKey string, tok Token) map[string]string {
	return map[string]string{envKey: tok.ID}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

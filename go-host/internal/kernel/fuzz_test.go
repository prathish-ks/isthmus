package kernel

// P9-02 (Phase 9/10 hardening): fuzz target #5 of 5 — NDJSON wire envelope
// decoding, the one boundary every external byte this process ever acts on
// crosses (doc.go: "Dispatch ... is the single function every transport ...
// goes through — there is no second path into any handler"). This fuzzer
// feeds Dispatch a completely arbitrary Op string and arbitrary raw JSON
// payload bytes — exactly what a malformed, truncated, or adversarial NDJSON
// line on the Unix socket looks like once serveConn has framed it — and
// asserts the two things that matter for a security boundary: Dispatch must
// never panic (a panic here would take the whole long-lived `nanogo serve`
// process down, which is itself the enforcement mechanism EC-02/EC-03 put in
// the request path), and the ResponseEnvelope it returns must always be
// well-formed (OK and Error are never both true-and-nil / false-and-nil).
//
// Reuses kernel_test.go's own fakeExecutor/testPolicy/withExecutor test
// helpers (same package) rather than redefining them, so this fuzz target
// exercises exactly the same fake-executor wiring the table-driven tests do
// — no exec ever actually reaches Docker, matching this package's own
// "prove exec was never reached for a denied request" discipline.
//
// NOTE ON LOCAL VERIFICATION: internal/kernel transitively imports
// internal/session, which imports modernc.org/sqlite (a vendored,
// pure-Go-but-cgo-shaped dependency). This fuzz test was authored and
// reviewed against the real protocol.go/server.go source but could not be
// run in the network-restricted authoring sandbox (no vendor/ staged, no
// module-proxy egress) — it needs `go test -fuzz=FuzzDispatch ./internal/kernel/`
// on a real checkout with vendor/ present, same as every other kernel-package
// test in this repo.
import (
	"context"
	"encoding/json"
	"testing"
)

func FuzzDispatch(f *testing.F) {
	seeds := []struct {
		op      string
		payload string
	}{
		{string(OpCapabilityRequest), `{"capability":"container.wake"}`},
		{string(OpCapabilityRequest), `not json at all`},
		{string(OpCapabilityRequest), `{"capability":"container.wake","session":{`}, // truncated
		{string(OpRouteRequest), `{}`},
		{string(OpSessionLookup), `null`},
		{string(OpDeliveryRequest), `[]`},
		{string(OpStatusTrace), `{"sessionId": 12345}`}, // wrong JSON type for a string field
		{"unknown.op.entirely", `{}`},
		{"", ""},
		{string(OpCapabilityRequest), `{"capability":"` + string(make([]byte, 5000)) + `"}`},
	}
	for _, s := range seeds {
		f.Add(s.op, s.payload)
	}

	policy := testPolicy()

	f.Fuzz(func(t *testing.T, opRaw, payloadRaw string) {
		k := New(policy, withExecutor(&fakeExecutor{}))

		env := Envelope{
			Version:   ProtocolVersion,
			Op:        Op(opRaw),
			RequestID: "fuzz-request",
			Payload:   json.RawMessage(payloadRaw),
		}

		// The property under test: Dispatch must never panic, on any Op
		// string or any payload bytes — this is the process's single
		// external-input entry point, and a panic here is a denial-of-
		// service against the security boundary itself.
		resp := k.Dispatch(context.Background(), env)

		// A well-formed ResponseEnvelope always has exactly one of
		// (OK && Error==nil) or (!OK && Error!=nil) — never both, never
		// neither.
		if resp.OK && resp.Error != nil {
			t.Fatalf("Dispatch returned OK=true but also a non-nil Error for op=%q payload=%q: %+v", opRaw, payloadRaw, resp.Error)
		}
		if !resp.OK && resp.Error == nil {
			t.Fatalf("Dispatch returned OK=false with a nil Error for op=%q payload=%q", opRaw, payloadRaw)
		}
		if !resp.OK {
			switch resp.Error.Code {
			case ErrUnsupportedVersion, ErrUnknownOp, ErrMalformedPayload, ErrSpecInvalid, ErrDenied, ErrUnknownSession, ErrUnknownCapability, ErrExecFailed:
				// a recognized, stable error code
			default:
				t.Fatalf("Dispatch returned an unrecognized error code %q for op=%q payload=%q", resp.Error.Code, opRaw, payloadRaw)
			}
		}
		// The response must always echo the version and request id back
		// verbatim, regardless of how malformed the input was.
		if resp.Version != ProtocolVersion {
			t.Fatalf("Dispatch response carries version %q, want %q", resp.Version, ProtocolVersion)
		}
		if resp.RequestID != env.RequestID {
			t.Fatalf("Dispatch response carries requestId %q, want %q", resp.RequestID, env.RequestID)
		}
	})
}

package kernel

import "encoding/json"

// ProtocolVersion is the literal version stamped on every envelope. See the
// package doc comment's "Versioning" section for what requires a bump.
const ProtocolVersion = "v1"

// Op names one of the five primitives. There are no other operations —
// dispatch (server.go) rejects anything else by construction, not by
// convention.
type Op string

const (
	// OpRouteRequest is the route.request op — the five primitives named in
	// the Op doc comment above.
	OpRouteRequest Op = "route.request"
	// OpSessionLookup is the session.lookup op.
	OpSessionLookup Op = "session.lookup"
	// OpCapabilityRequest is the capability.request op.
	OpCapabilityRequest Op = "capability.request"
	// OpDeliveryRequest is the delivery.request op.
	OpDeliveryRequest Op = "delivery.request"
	// OpStatusTrace is the status.trace op.
	OpStatusTrace Op = "status.trace"
)

// Envelope is what a caller sends. Payload is deliberately raw JSON —
// dispatch decodes it into the op-specific request type only after checking
// Version and Op, so a malformed payload for one op can never be
// misinterpreted as a well-formed payload for another.
type Envelope struct {
	Version   string          `json:"version"`
	Op        Op              `json:"op"`
	RequestID string          `json:"requestId"`
	Payload   json.RawMessage `json:"payload"`
}

// ResponseEnvelope is what the kernel sends back. Exactly one of Payload or
// Error is set.
type ResponseEnvelope struct {
	Version   string          `json:"version"`
	RequestID string          `json:"requestId"`
	OK        bool            `json:"ok"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Error     *ErrorInfo      `json:"error,omitempty"`
}

// ErrorInfo carries a stable machine-checkable Code plus a human Detail —
// per the Phase 5 readiness review's point (finding 6, mount-validator
// bullet) that a bare bool/error string violates LAW-04's low-friction-UX
// requirement by making a false positive unexplainable. Code values are
// part of the v1 contract; Detail is free text for logs/UIs, not for
// programmatic branching.
type ErrorInfo struct {
	Code   string `json:"code"`
	Detail string `json:"detail"`
}

// Error codes. "denied" means the request was well-formed and understood
// but a Phase 5 validator (or a kernel-owned constraint) refused it —
// callers should surface Detail to the user, not retry. "spec-invalid" and
// "unknown-*" mean the request itself was malformed — a caller bug, not a
// security decision.
const (
	ErrUnsupportedVersion = "unsupported-version"
	ErrUnknownOp          = "unknown-op"
	ErrMalformedPayload   = "malformed-payload"
	ErrSpecInvalid        = "spec-invalid"
	ErrDenied             = "denied"
	ErrUnknownSession     = "unknown-session"
	ErrUnknownCapability  = "unknown-capability"
	ErrExecFailed         = "exec-failed"
)

func errorResponse(requestID, code, detail string) ResponseEnvelope {
	return ResponseEnvelope{
		Version:   ProtocolVersion,
		RequestID: requestID,
		OK:        false,
		Error:     &ErrorInfo{Code: code, Detail: detail},
	}
}

func okResponse(requestID string, payload any) (ResponseEnvelope, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return ResponseEnvelope{}, err
	}
	return ResponseEnvelope{Version: ProtocolVersion, RequestID: requestID, OK: true, Payload: raw}, nil
}

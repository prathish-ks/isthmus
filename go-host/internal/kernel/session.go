package kernel

import (
	"fmt"

	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// SessionLookupPayload wraps internal/session's existing SQLite-backed
// reads (already Go-owned since P4-01) behind the socket boundary. Mode
// picks which underlying function runs; "resolve" is the one
// find-or-create path (ResolveSession) — included here rather than under
// CapabilityRequest because ordinary session bookkeeping is mechanism, not
// a privileged/Docker-facing action (design-laws.md LAW-07 scopes
// enforcement to the three container-runner.ts functions specifically, not
// to every Go-owned write).
type SessionLookupPayload struct {
	Mode             string  `json:"mode"` // "get" | "find" | "findForAgent" | "findByAgentGroup" | "resolve"
	ID               string  `json:"id,omitempty"`
	AgentGroupID     string  `json:"agentGroupId,omitempty"`
	MessagingGroupID string  `json:"messagingGroupId,omitempty"`
	ThreadID         *string `json:"threadId,omitempty"`
	ConfiguredMode   string  `json:"configuredMode,omitempty"` // resolve only
}

// SessionLookupResponsePayload is handleSessionLookup's result: whether a
// session was Found (and, for "resolve", Created), plus the Session itself
// when one exists.
type SessionLookupResponsePayload struct {
	Found   bool             `json:"found"`
	Created bool             `json:"created,omitempty"` // resolve only
	Session *session.Session `json:"session,omitempty"`
}

func (k *Kernel) handleSessionLookup(req SessionLookupPayload) (SessionLookupResponsePayload, *ErrorInfo) {
	if k.db == nil {
		return SessionLookupResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: "kernel has no session database configured"}
	}
	switch req.Mode {
	case "get":
		s, err := session.Get(k.db, req.ID)
		return fromLookup(s, err)
	case "find":
		s, err := session.Find(k.db, req.MessagingGroupID, req.ThreadID)
		return fromLookup(s, err)
	case "findForAgent":
		s, err := session.FindForAgent(k.db, req.AgentGroupID, req.MessagingGroupID, req.ThreadID)
		return fromLookup(s, err)
	case "findByAgentGroup":
		s, err := session.FindByAgentGroup(k.db, req.AgentGroupID)
		return fromLookup(s, err)
	case "resolve":
		var mg *string
		if req.MessagingGroupID != "" {
			mg = &req.MessagingGroupID
		}
		s, created, err := session.ResolveSession(k.db, req.AgentGroupID, mg, req.ThreadID, session.Mode(req.ConfiguredMode))
		if err != nil {
			return SessionLookupResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
		}
		return SessionLookupResponsePayload{Found: true, Created: created, Session: &s}, nil
	default:
		return SessionLookupResponsePayload{}, &ErrorInfo{Code: ErrSpecInvalid, Detail: fmt.Sprintf("unknown session.lookup mode %q", req.Mode)}
	}
}

func fromLookup(s *session.Session, err error) (SessionLookupResponsePayload, *ErrorInfo) {
	if err != nil {
		return SessionLookupResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}
	if s == nil {
		return SessionLookupResponsePayload{Found: false}, nil
	}
	return SessionLookupResponsePayload{Found: true, Session: s}, nil
}

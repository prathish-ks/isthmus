package kernel

import (
	"fmt"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/hostinfo"
	msgtrace "github.com/prathish-ks/isthmus/go-host/internal/trace"
)

// auditCapacity bounds the in-memory decision log — StatusTrace is a
// debugging/observability aid, not a durable audit store (that would be a
// new component needing its own LAW-05 justification). A fixed ring buffer
// costs nothing to hold and cannot grow unbounded under a hostile or buggy
// caller.
const auditCapacity = 200

type auditEntry struct {
	at         time.Time
	capability Capability
	sessionID  string
	allowed    bool
	reason     string
}

func (k *Kernel) audit(e auditEntry) {
	e.at = time.Now()
	k.auditMu.Lock()
	defer k.auditMu.Unlock()
	k.auditLog = append(k.auditLog, e)
	if len(k.auditLog) > auditCapacity {
		k.auditLog = k.auditLog[len(k.auditLog)-auditCapacity:]
	}
}

// StatusTraceResponsePayload is StatusTrace's (no-input) response: which
// sessions this kernel currently believes are live, plus its recent
// capability-decision log. Read-only — there is no corresponding request
// payload because nothing about it is caller-tunable.
type StatusTraceResponsePayload struct {
	Host            string        `json:"host"`
	RunningSessions []string      `json:"runningSessions"`
	RecentDecisions []AuditRecord `json:"recentDecisions"`
}

// AuditRecord is one entry of the audit log, JSON-shaped for the wire.
type AuditRecord struct {
	At         string `json:"at"`
	Capability string `json:"capability"`
	SessionID  string `json:"sessionId"`
	Allowed    bool   `json:"allowed"`
	Reason     string `json:"reason,omitempty"`
}

func (k *Kernel) handleStatusTrace() StatusTraceResponsePayload {
	k.auditMu.Lock()
	records := make([]AuditRecord, len(k.auditLog))
	for i, e := range k.auditLog {
		records[i] = AuditRecord{
			At:         e.at.UTC().Format(time.RFC3339),
			Capability: string(e.capability),
			SessionID:  e.sessionID,
			Allowed:    e.allowed,
			Reason:     e.reason,
		}
	}
	k.auditMu.Unlock()

	return StatusTraceResponsePayload{
		Host:            hostinfo.Describe(),
		RunningSessions: k.registry.RunningSessionIDs(),
		RecentDecisions: records,
	}
}

// recordTrace is P7-03's hook into Dispatch: a best-effort message trace,
// entirely separate from StatusTrace's per-capability audit log above (that
// one is keyed by session id and scoped to capability.request; this one is
// keyed by whatever id each op naturally carries, and spans every op).
// No-ops when no tracer is attached (the common case for any Kernel built
// before P7-03, and for tests that don't care about trace history) or when
// key is empty — nothing useful to key an event by.
func (k *Kernel) recordTrace(key string, stage msgtrace.Stage, summary string) {
	if k.tracer == nil || key == "" {
		return
	}
	k.tracer.Record(msgtrace.Event{Key: key, Stage: stage, Summary: summary})
}

// routeTraceSummary never includes req.Text (message content) — only the
// verdict, which is exactly the kind of structural fact Redact's own doc
// comment says doesn't need redaction.
func routeTraceSummary(resp RouteResponsePayload, errInfo *ErrorInfo) string {
	if errInfo != nil {
		return fmt.Sprintf("denied: %s", errInfo.Detail)
	}
	if resp.Action != "" {
		return fmt.Sprintf("unwired action=%s", resp.Action)
	}
	return fmt.Sprintf("engage=%t deliver=%t wake=%t", resp.Engage, resp.Deliver, resp.Wake)
}

// sessionTraceKey prefers the request's own id (mode "get") and falls back
// to whatever session id the lookup actually resolved to (find/resolve
// modes, where the caller doesn't know the id up front) — so a trace is
// still keyable even when the id wasn't known before this call returned.
func sessionTraceKey(req SessionLookupPayload, resp SessionLookupResponsePayload) string {
	if req.ID != "" {
		return req.ID
	}
	if resp.Session != nil {
		return resp.Session.ID
	}
	return ""
}

func sessionTraceSummary(resp SessionLookupResponsePayload, errInfo *ErrorInfo) string {
	if errInfo != nil {
		return fmt.Sprintf("denied: %s", errInfo.Detail)
	}
	return fmt.Sprintf("found=%t created=%t", resp.Found, resp.Created)
}

// capabilityTraceKey keys a wake by the session it wakes, a kill by the
// session it targets, and a build by the agent group it builds for — the
// same identity fields handleWake/handleKill/handleBuildImage already
// validate via internal/ownership, never a raw caller-chosen string.
func capabilityTraceKey(req CapabilityRequestPayload) string {
	switch req.Capability {
	case CapabilityContainerWake:
		if req.Session != nil {
			return req.Session.Key.SessionID
		}
		return ""
	case CapabilityContainerKill:
		return req.SessionID
	case CapabilityContainerBuildImage:
		return req.AgentGroupID
	default:
		return ""
	}
}

func capabilityTraceStage(cap Capability) msgtrace.Stage {
	switch cap {
	case CapabilityContainerWake:
		return msgtrace.StageContainerWake
	case CapabilityContainerKill:
		return msgtrace.StageContainerKill
	case CapabilityContainerBuildImage:
		return msgtrace.StageContainerBuild
	default:
		return msgtrace.StageContainerWake
	}
}

func capabilityTraceSummary(resp CapabilityResponsePayload, errInfo *ErrorInfo) string {
	if errInfo != nil {
		return fmt.Sprintf("denied (%s): %s", errInfo.Code, errInfo.Detail)
	}
	return fmt.Sprintf("allowed=%t", resp.Allowed)
}

// deliveryTraceSummary never includes message content — delivery.request
// carries none, only routing/attempt-counting facts, but this stays
// explicit rather than assumed for the next field anyone adds to
// DeliveryResponsePayload.
func deliveryTraceSummary(resp DeliveryResponsePayload) string {
	if !resp.Allowed {
		return fmt.Sprintf("denied: %s", resp.Reason)
	}
	return fmt.Sprintf("allowed attempts=%d giveUp=%t", resp.Attempts, resp.GiveUp)
}

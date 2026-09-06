package kernel

import (
	"github.com/prathish-ks/isthmus/go-host/internal/routing"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// RouteRequestPayload bundles router.ts's two real call shapes — one
// wired-agent evaluation, and one zero-wirings channel decision — into a
// single op, discriminated by Kind. Composing internal/routing's seven
// already-ported pure functions into one socket round trip (rather than one
// call per function) is the coarsening P6-02's own instructions call for:
// these were designed as an in-process library in P4-02, before there was a
// process boundary to cross.
type RouteRequestPayload struct {
	Kind string `json:"kind"` // "wiring" | "unwired"

	// kind == "wiring"
	EngageMode            string  `json:"engageMode,omitempty"`
	Pattern               *string `json:"pattern,omitempty"`
	Text                  string  `json:"text,omitempty"`
	IsMention             bool    `json:"isMention,omitempty"`
	IsGroup               bool    `json:"isGroup,omitempty"`
	StickyExisting        bool    `json:"stickyExisting,omitempty"`
	AccessAllowed         bool    `json:"accessAllowed,omitempty"`
	ScopeAllowed          bool    `json:"scopeAllowed,omitempty"`
	IgnoredPolicy         string  `json:"ignoredPolicy,omitempty"`
	ConfiguredMode        string  `json:"configuredMode,omitempty"`
	ThreadsEnabled        bool    `json:"threadsEnabled,omitempty"`
	MessageID             string  `json:"messageId,omitempty"`
	AgentGroupID          string  `json:"agentGroupId,omitempty"`
	WiringThreads         *int    `json:"wiringThreads,omitempty"`
	DeclaredThreadDefault bool    `json:"declaredThreadDefault,omitempty"`
	SupportsThreads       bool    `json:"supportsThreads,omitempty"`

	// kind == "unwired"
	Denied bool `json:"denied,omitempty"`
}

// RouteResponsePayload is the corresponding verdict. Only the fields for
// the request's Kind are populated.
type RouteResponsePayload struct {
	// kind == "wiring"
	Engage              bool   `json:"engage,omitempty"`
	EngageUnknown       bool   `json:"engageUnknown,omitempty"`
	Deliver             bool   `json:"deliver,omitempty"`
	Wake                bool   `json:"wake,omitempty"`
	EffectiveMode       string `json:"effectiveMode,omitempty"`
	ThreadsResolved     bool   `json:"threadsResolved,omitempty"`
	NamespacedMessageID string `json:"namespacedMessageId,omitempty"`

	// kind == "unwired"
	Action string `json:"action,omitempty"` // "ignore" | "silent" | "record"
}

func (k *Kernel) handleRouteRequest(req RouteRequestPayload) (RouteResponsePayload, *ErrorInfo) {
	switch req.Kind {
	case "wiring":
		return k.handleWiringRoute(req), nil
	case "unwired":
		return k.handleUnwiredRoute(req), nil
	default:
		return RouteResponsePayload{}, &ErrorInfo{Code: ErrSpecInvalid, Detail: "route.request kind must be \"wiring\" or \"unwired\""}
	}
}

func (k *Kernel) handleWiringRoute(req RouteRequestPayload) RouteResponsePayload {
	engaged := routing.EvaluateEngage(req.EngageMode, req.Pattern, req.Text, req.IsMention, req.IsGroup, req.StickyExisting)

	policy := routing.IgnoredMessagePolicyDrop
	if req.IgnoredPolicy == string(routing.IgnoredMessagePolicyAccumulate) {
		policy = routing.IgnoredMessagePolicyAccumulate
	}
	outcome := routing.DecideWiringOutcome(engaged.Engage, req.AccessAllowed, req.ScopeAllowed, policy)

	resp := RouteResponsePayload{
		Engage:        engaged.Engage,
		EngageUnknown: engaged.Unknown,
		Deliver:       outcome.Deliver,
		Wake:          outcome.Wake,
	}
	if outcome.Deliver {
		effective := routing.EffectiveSessionMode(session.Mode(req.ConfiguredMode), req.ThreadsEnabled, req.IsGroup)
		resp.EffectiveMode = string(effective)
		resp.ThreadsResolved = routing.ResolveThreadPolicy(req.WiringThreads, req.DeclaredThreadDefault, req.SupportsThreads)
		resp.NamespacedMessageID = routing.MessageIDForAgent(req.MessageID, req.AgentGroupID)
	}
	return resp
}

func (k *Kernel) handleUnwiredRoute(req RouteRequestPayload) RouteResponsePayload {
	switch routing.DecideUnwiredChannel(req.IsMention, req.Denied) {
	case routing.UnwiredIgnore:
		return RouteResponsePayload{Action: "ignore"}
	case routing.UnwiredSilent:
		return RouteResponsePayload{Action: "silent"}
	default:
		return RouteResponsePayload{Action: "record"}
	}
}

package kernel

import (
	"github.com/prathish-ks/isthmus/go-host/internal/delivery"
)

// DeliveryRequestPayload wraps internal/delivery's decision functions.
// TypeScript still performs the actual send through the channel-adapter
// registry — that registry (registerDeliveryAction et al.) is exactly the
// LAW-01/LAW-02 extension point host-decomposition.md (#5) keeps in
// TypeScript. Only the destination-authorization decision (structurally a
// guard, per that same document) and the plain attempt-counting arithmetic
// move behind this boundary.
type DeliveryRequestPayload struct {
	ChannelType             string                            `json:"channelType"`
	PlatformID              string                            `json:"platformId"`
	SessionMessagingGroupID *string                           `json:"sessionMessagingGroupId,omitempty"`
	Origin                  *delivery.MessagingGroupCandidate `json:"origin,omitempty"`
	OwnDestination          *delivery.MessagingGroupCandidate `json:"ownDestination,omitempty"`
	ByPlatform              *delivery.MessagingGroupCandidate `json:"byPlatform,omitempty"`
	AgentDestinationsExist  bool                              `json:"agentDestinationsExist,omitempty"`
	HasDestinationRow       bool                              `json:"hasDestinationRow,omitempty"`

	// Optional: when PreviousAttempts >= 0 is set, the response also
	// includes the next-attempt/give-up decision for this delivery.
	PreviousAttempts *int `json:"previousAttempts,omitempty"`
}

// DeliveryResponsePayload is handleDeliveryRequest's result: the
// authorization decision (Allowed/Reason/Target) and, when the caller asked
// for it via PreviousAttempts, the next-attempt/give-up decision.
type DeliveryResponsePayload struct {
	Allowed  bool                     `json:"allowed"`
	Reason   string                   `json:"reason,omitempty"`
	Target   *delivery.DeliveryTarget `json:"target,omitempty"`
	Attempts int                      `json:"attempts,omitempty"`
	GiveUp   bool                     `json:"giveUp,omitempty"`
}

func (k *Kernel) handleDeliveryRequest(req DeliveryRequestPayload) DeliveryResponsePayload {
	target, err := delivery.ResolveDeliveryTarget(
		req.ChannelType, req.PlatformID, req.SessionMessagingGroupID,
		req.Origin, req.OwnDestination, req.ByPlatform,
		req.AgentDestinationsExist, req.HasDestinationRow,
	)
	resp := DeliveryResponsePayload{}
	if err != nil {
		resp.Allowed = false
		resp.Reason = err.Error()
	} else {
		resp.Allowed = true
		resp.Target = target
	}
	if req.PreviousAttempts != nil {
		attempts, giveUp := delivery.NextAttempt(*req.PreviousAttempts)
		resp.Attempts = attempts
		resp.GiveUp = giveUp
	}
	return resp
}

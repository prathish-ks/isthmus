// Package delivery ports the mechanism half of src/delivery.ts's outbound
// drain loop — the part that decides WHAT to do with a due outbound row —
// behind the smallest possible adapter boundary, per P4-04's own scope
// ("Implement delivery core behind the smallest adapter interface/protocol.
// Use a fake adapter in tests; do not rewrite Telegram/Slack.").
//
// What moved here, and why each piece is policy-free mechanism rather than a
// LAW-01/LAW-02 customization surface:
//
//   - ClassifyOutboundMessage: deliverMessage's own dispatch order
//     (delivery.ts:303-330 for system/task_log/agent, :442-445 for the
//     missing-routing-fields check) — system / task_log / agent-route /
//     missing-routing-fields / channel. This is a closed, five-way switch
//     on two plain fields (kind, channelType) plus one session fact
//     (whether this is a task session) — nothing here is adapter- or
//     skill-extensible.
//   - ResolveDeliveryTarget: the origin-chat-first / own-destination /
//     by-platform messaging-group fallback chain and the
//     agent_destinations authorization check (delivery.ts:363-410),
//     ported as a pure decision over caller-supplied lookup results —
//     same pattern P4-01/P4-02/P4-03 already established for DB-backed
//     logic (the Go side decides, the caller still owns the query).
//   - NextAttempt: the in-memory attempt-counter give-up rule
//     (MAX_DELIVERY_ATTEMPTS = 3 in delivery.ts) — a three-line pure
//     function with no hook seam at all in the original.
//   - InflightGuard: the inflightDeliveries re-entry guard
//     (delivery.ts:36-52) that keeps the 1s active poll and the 60s sweep
//     poll from double-delivering the same session's queue.
//   - Adapter / FakeAdapter: the minimal boundary itself, mirroring
//     ChannelDeliveryAdapter's single deliver() method
//     (delivery.ts:54-74) — the interface a real TypeScript channel
//     adapter (Telegram, Slack, Discord, ...) would eventually be asked
//     to satisfy over some RPC, and the fake this milestone's own tests
//     exercise it against per the task's explicit instruction.
//
// What deliberately stays out of this package, because it is exactly the
// kind of customization/extension surface LAW-01/LAW-02 keep in TypeScript:
//   - the system-action delivery registry (registerDeliveryAction /
//     getDeliveryAction / handleSystemAction) — self-mod's guarded
//     install/add-mcp-server actions, the cli_request bridge, and any
//     future module's own registered action all live there;
//   - task-run-log persistence (appendRunLog) — a scheduling-module
//     concern, not delivery mechanism;
//   - agent-to-agent routing (routeAgentMessage) — its own module, with
//     its own guard/permission model (see docs/compatibility-contract.md
//     Part B, shape 3);
//   - ask_question / pending_questions tracking — the interactive
//     module's own bookkeeping, orthogonal to delivery classification;
//   - post-delivery hooks, batch-preview hooks, and cross-session-context
//     fan-out (fanOutboundMessage) — all registered extension seams;
//   - typing (setTyping) — decoration, and already flagged elsewhere in
//     this project as never worth blocking delivery on;
//   - file attachments (OutboundFile / readOutboxFiles) — session-manager
//     owns that filesystem I/O; this boundary carries only the string
//     content field, matching the Adapter interface's own scope.
//
// One captured-not-endorsed TypeScript quirk, deliberately NOT reproduced
// here: delivery.ts's deliverMessage silently drops (returns undefined,
// which the caller then marks delivered) when the *global* delivery
// adapter was never configured at all (`if (!deliveryAdapter)`). That is a
// host-boot invariant — in practice the bridge is always installed before
// the poll loops start — not a per-message runtime path, so this package's
// Adapter parameter is non-optional and that boot-time case is left
// unmodeled. The genuinely reachable "no adapter for this channel/instance"
// case (channel-registry.ts's MissingChannelAdapterError, thrown by the
// bridge's own deliver() when the specific channelType/instance has no live
// adapter) IS modeled here — via NoChannelAdapterError, which an Adapter
// implementation (real or fake) returns and which this boundary propagates
// as an ordinary error, exactly matching the TS throw's effect (message
// enters the retry path, see NextAttempt).
package delivery

import (
	"context"
	"fmt"
	"sync"

	"github.com/prathish-ks/isthmus/go-host/internal/session"
)

// MaxDeliveryAttempts mirrors delivery.ts's MAX_DELIVERY_ATTEMPTS.
const MaxDeliveryAttempts = 3

// Classification is the outcome of ClassifyOutboundMessage — which of
// deliverMessage's five dispatch branches an outbound row falls into.
type Classification int

const (
	// ClassChannel is a row that should be delivered through a channel
	// Adapter (deliverMessage's final branch, once channelType and
	// platformID are both present).
	ClassChannel Classification = iota
	// ClassSystemAction is a row with kind == "system" — handled by the
	// (out-of-scope, TypeScript-owned) delivery-action registry.
	ClassSystemAction
	// ClassTaskLog is a row with kind == "task_log" written by a genuine
	// task session (session.MessagingGroupID == nil and the thread is a
	// task thread) — appended to the run log, never delivered.
	ClassTaskLog
	// ClassTaskLogIgnored is a task_log row OUTSIDE a task session —
	// deliverMessage logs a warning and drops it without appending
	// anywhere.
	ClassTaskLogIgnored
	// ClassAgentRoute is a row with channelType == "agent" — routed to
	// another session via the (out-of-scope) agent-to-agent module.
	ClassAgentRoute
	// ClassMissingRoutingFields is a row that is none of the above but
	// lacks channelType or platformID — deliverMessage warns and drops it
	// (still marked delivered by the caller, matching TS).
	ClassMissingRoutingFields
)

// ClassifyOutboundMessage reproduces deliverMessage's dispatch order
// (delivery.ts:303-330 for system/task_log/agent, :442-445 for the
// missing-routing-fields check) as a single closed decision. sessionThreadID
// and sessionMessagingGroupID describe the SESSION the message is being
// drained from, not the message's own destination fields.
func ClassifyOutboundMessage(kind string, channelType, platformID, sessionMessagingGroupID, sessionThreadID *string) Classification {
	if kind == "system" {
		return ClassSystemAction
	}
	if kind == "task_log" {
		if sessionMessagingGroupID == nil && sessionThreadID != nil && *sessionThreadID != "" && session.IsTaskThread(sessionThreadID) {
			return ClassTaskLog
		}
		return ClassTaskLogIgnored
	}
	if channelType != nil && *channelType == "agent" {
		return ClassAgentRoute
	}
	if channelType == nil || platformID == nil {
		return ClassMissingRoutingFields
	}
	return ClassChannel
}

// MessagingGroupCandidate is the caller-supplied result of one messaging-group
// lookup (getMessagingGroup / getMessagingGroupForOwnDestination /
// getMessagingGroupByPlatform) — this package never queries the DB itself,
// mirroring P4-01/P4-02's pattern of taking lookups as plain values.
type MessagingGroupCandidate struct {
	ID          string
	ChannelType string
	PlatformID  string
	// Instance is the adapter-instance key to deliver through — "" means
	// the default instance (equal to ChannelType), matching TS's
	// `instance?: string`.
	Instance string
	// DetachedAt is non-nil when the bot has been removed from this
	// conversation (mg.detached_at IS NOT NULL).
	DetachedAt *string
}

// DeliveryTarget is what ResolveDeliveryTarget hands the caller once a
// destination is authorized: the resolved messaging group id (for logging /
// bookkeeping — delivery.ts doesn't actually need it downstream, but
// preserving it costs nothing and mirrors what the real code has in scope
// at the call site) and the instance to deliver through.
//
// Renaming to Target would touch this type's exported name plus every call
// site across internal/delivery/delivery_test.go, internal/parity's doc
// comment and parity_test.go, internal/kernel/doc.go's doc comment, and
// internal/kernel/delivery.go's field type and import-qualified usage — a
// coordinated, six-file public-API rename with no behavior change.
// Deliberately deferred rather than rushed alongside this lint-cleanup pass;
// tracked as a follow-up, not silently dropped.
//
//nolint:revive // "stutters" against package delivery (delivery.DeliveryTarget).
type DeliveryTarget struct {
	MessagingGroupID string
	Instance         string
}

// UnknownMessagingGroupError mirrors delivery.ts's
// `unknown messaging group for ${channelType}/${platformId}` throw.
type UnknownMessagingGroupError struct {
	ChannelType string
	PlatformID  string
}

func (e *UnknownMessagingGroupError) Error() string {
	return fmt.Sprintf("unknown messaging group for %s/%s", e.ChannelType, e.PlatformID)
}

// DetachedMessagingGroupError mirrors delivery.ts's
// `messaging group ${id} is detached (bot removed from ...)` throw.
type DetachedMessagingGroupError struct {
	MessagingGroupID string
	ChannelType      string
	PlatformID       string
	DetachedAt       string
}

func (e *DetachedMessagingGroupError) Error() string {
	return fmt.Sprintf("messaging group %s is detached (bot removed from %s/%s at %s)",
		e.MessagingGroupID, e.ChannelType, e.PlatformID, e.DetachedAt)
}

// UnauthorizedDestinationError mirrors delivery.ts's
// `unauthorized channel destination: ${agentGroupId} cannot send to ...` throw.
type UnauthorizedDestinationError struct {
	MessagingGroupID string
	ChannelType      string
	PlatformID       string
}

func (e *UnauthorizedDestinationError) Error() string {
	return fmt.Sprintf("unauthorized channel destination: cannot send to %s/%s (messaging group %s)",
		e.ChannelType, e.PlatformID, e.MessagingGroupID)
}

// ResolveDeliveryTarget ports delivery.ts's messaging-group resolution and
// authorization block (lines 363-410) verbatim, taking each DB lookup's
// result as a caller-supplied optional rather than performing the queries
// itself:
//
//   - origin: getMessagingGroup(session.messaging_group_id)'s result, or nil
//     if the session has no origin messaging group (sessionMessagingGroupID
//     == nil) — the caller only needs to fetch it when that ID is set.
//   - ownDestination: getMessagingGroupForOwnDestination(...)'s result.
//   - byPlatform: getMessagingGroupByPlatform(...)'s result — only consulted
//     when ownDestination is nil, matching the TS `??` fallback.
//   - agentDestinationsTableExists: hasTable(db, 'agent_destinations').
//   - hasDestinationRow: the caller's own row lookup against
//     agent_destinations for (session.agent_group_id, 'channel', mg.id) —
//     only meaningful (and only consulted) when the resolved mg is not the
//     session's own origin chat AND the table exists, exactly matching TS's
//     short-circuit (`!isOriginChat && (await hasTable(...))`).
func ResolveDeliveryTarget(
	channelType, platformID string,
	sessionMessagingGroupID *string,
	origin, ownDestination, byPlatform *MessagingGroupCandidate,
	agentDestinationsTableExists bool,
	hasDestinationRow bool,
) (*DeliveryTarget, error) {
	var mg *MessagingGroupCandidate
	switch {
	case origin != nil && origin.ChannelType == channelType && origin.PlatformID == platformID:
		mg = origin
	case ownDestination != nil:
		mg = ownDestination
	default:
		mg = byPlatform
	}
	if mg == nil {
		return nil, &UnknownMessagingGroupError{ChannelType: channelType, PlatformID: platformID}
	}
	if mg.DetachedAt != nil {
		return nil, &DetachedMessagingGroupError{
			MessagingGroupID: mg.ID,
			ChannelType:      mg.ChannelType,
			PlatformID:       mg.PlatformID,
			DetachedAt:       *mg.DetachedAt,
		}
	}
	isOriginChat := sessionMessagingGroupID != nil && *sessionMessagingGroupID == mg.ID
	if !isOriginChat && agentDestinationsTableExists && !hasDestinationRow {
		return nil, &UnauthorizedDestinationError{
			MessagingGroupID: mg.ID,
			ChannelType:      mg.ChannelType,
			PlatformID:       mg.PlatformID,
		}
	}
	return &DeliveryTarget{MessagingGroupID: mg.ID, Instance: mg.Instance}, nil
}

// NextAttempt mirrors delivery.ts's in-memory attempt-counter give-up rule:
// on a delivery failure, deliveryAttempts.get(id)+1 is compared against
// MAX_DELIVERY_ATTEMPTS. previous is the attempt count BEFORE this failure
// (0 on the first failure); attempts is the count AFTER, and giveUp mirrors
// `attempts >= MAX_DELIVERY_ATTEMPTS` (permanent failure — markDeliveryFailed
// — instead of another retry).
func NextAttempt(previous int) (attempts int, giveUp bool) {
	attempts = previous + 1
	giveUp = attempts >= MaxDeliveryAttempts
	return attempts, giveUp
}

// InflightGuard mirrors delivery.ts's inflightDeliveries Set (lines 36-52):
// the active poll (1s) and the sweep poll (60s) both call
// deliverSessionMessages for a running session, and without this guard the
// two timer chains can race on the same outbound row. Skipping (returning
// false from TryEnter) rather than queueing is correct — see the TS
// comment: a skipped session's remaining messages are picked up on the next
// poll tick.
type InflightGuard struct {
	mu       sync.Mutex
	inflight map[string]struct{}
}

// NewInflightGuard returns a ready-to-use guard with no sessions inflight.
func NewInflightGuard() *InflightGuard {
	return &InflightGuard{inflight: make(map[string]struct{})}
}

// TryEnter reports whether sessionID was not already inflight and marks it
// so. The caller MUST call Leave exactly once for every TryEnter that
// returned true (typically via defer), mirroring the TS try/finally around
// drainSession.
func (g *InflightGuard) TryEnter(sessionID string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, ok := g.inflight[sessionID]; ok {
		return false
	}
	g.inflight[sessionID] = struct{}{}
	return true
}

// Leave clears sessionID's inflight marker.
func (g *InflightGuard) Leave(sessionID string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.inflight, sessionID)
}

// Adapter is the minimal boundary a TypeScript channel adapter would
// eventually be asked to satisfy — mirroring ChannelDeliveryAdapter's single
// deliver() method (delivery.ts:54-74) with setTyping deliberately omitted
// (decoration, out of this task's scope). content is the raw JSON string
// exactly as stored in messages_out.content — this boundary does not parse
// it, matching deliverMessage's own adapter call (msg.content, not
// JSON.parse(msg.content)).
type Adapter interface {
	Deliver(ctx context.Context, channelType, platformID string, threadID *string, kind, content, instance string) (platformMessageID string, err error)
}

// NoChannelAdapterError mirrors channel-registry.ts's
// MissingChannelAdapterError — thrown by the real bridge's deliver() when
// the specific channelType/instance has no live adapter registered. An
// Adapter implementation (real or fake) returns this to signal exactly that
// condition; Deliver propagates it unchanged, so the message enters the
// same retry path a TS throw would.
type NoChannelAdapterError struct {
	ChannelType string
	Instance    string
}

func (e *NoChannelAdapterError) Error() string {
	key := e.Instance
	if key == "" {
		key = e.ChannelType
	}
	return fmt.Sprintf("no adapter registered for '%s' — message enters the delivery retry path", key)
}

// Outcome is what Deliver reports for one outbound event. PlatformMessageID
// is only populated when Classification == ClassChannel and delivery
// succeeded; every other classification reports an empty PlatformMessageID
// because the corresponding TS branch (system action, task-log append,
// agent routing, or dropped-for-missing-fields) does not go through the
// channel Adapter at all.
type Outcome struct {
	Classification    Classification
	PlatformMessageID string
}

// OutboundEvent is the plain-value shape Deliver needs from one due
// messages_out row — the subset of internal/mailbox's Delivery result that
// this boundary actually classifies and (for ClassChannel) delivers.
type OutboundEvent struct {
	ID          string
	Kind        string
	ChannelType *string
	PlatformID  *string
	ThreadID    *string
	Content     string
}

// TargetLookups bundles the caller-supplied DB-lookup results
// ResolveDeliveryTarget needs — see that function's own doc for what each
// field means and when the caller needs to have actually queried it.
type TargetLookups struct {
	Origin                       *MessagingGroupCandidate
	OwnDestination               *MessagingGroupCandidate
	ByPlatform                   *MessagingGroupCandidate
	AgentDestinationsTableExists bool
	HasDestinationRow            bool
}

// Deliver is the composed boundary: classify the event, and for ClassChannel
// resolve its target and call through to the Adapter. Every other
// classification returns immediately with no Adapter call at all — the
// caller is expected to route those classifications to the appropriate
// TypeScript-owned handling (system-action dispatch, task-log append,
// agent-to-agent routing) itself; that handling is out of this package's
// scope by design (see the package doc).
func Deliver(
	ctx context.Context,
	ev OutboundEvent,
	sessionMessagingGroupID, sessionThreadID *string,
	lookups TargetLookups,
	adapter Adapter,
) (Outcome, error) {
	class := ClassifyOutboundMessage(ev.Kind, ev.ChannelType, ev.PlatformID, sessionMessagingGroupID, sessionThreadID)
	if class != ClassChannel {
		return Outcome{Classification: class}, nil
	}

	target, err := ResolveDeliveryTarget(
		*ev.ChannelType, *ev.PlatformID,
		sessionMessagingGroupID,
		lookups.Origin, lookups.OwnDestination, lookups.ByPlatform,
		lookups.AgentDestinationsTableExists, lookups.HasDestinationRow,
	)
	if err != nil {
		return Outcome{Classification: class}, err
	}

	platformMessageID, err := adapter.Deliver(ctx, *ev.ChannelType, *ev.PlatformID, ev.ThreadID, ev.Kind, ev.Content, target.Instance)
	if err != nil {
		return Outcome{Classification: class}, err
	}
	return Outcome{Classification: class, PlatformMessageID: platformMessageID}, nil
}

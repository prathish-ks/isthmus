package delivery

import (
	"context"
	"errors"
	"testing"
)

func strp(s string) *string { return &s }

// --- ClassifyOutboundMessage ---

func TestClassifyOutboundMessage_System(t *testing.T) {
	got := ClassifyOutboundMessage("system", strp("telegram"), strp("123"), nil, nil)
	if got != ClassSystemAction {
		t.Fatalf("expected ClassSystemAction, got %v", got)
	}
}

func TestClassifyOutboundMessage_TaskLogProper(t *testing.T) {
	// session.messaging_group_id == nil, thread is the tasks-system thread namespace.
	got := ClassifyOutboundMessage("task_log", nil, nil, nil, strp("system:tasks:series-1"))
	if got != ClassTaskLog {
		t.Fatalf("expected ClassTaskLog, got %v", got)
	}
}

func TestClassifyOutboundMessage_TaskLogIgnoredWhenMessagingGroupSet(t *testing.T) {
	got := ClassifyOutboundMessage("task_log", nil, nil, strp("mg-1"), strp("system:tasks:series-1"))
	if got != ClassTaskLogIgnored {
		t.Fatalf("expected ClassTaskLogIgnored, got %v", got)
	}
}

func TestClassifyOutboundMessage_TaskLogIgnoredWhenNotTaskThread(t *testing.T) {
	got := ClassifyOutboundMessage("task_log", nil, nil, nil, strp("telegram:12345"))
	if got != ClassTaskLogIgnored {
		t.Fatalf("expected ClassTaskLogIgnored, got %v", got)
	}
}

func TestClassifyOutboundMessage_TaskLogIgnoredWhenThreadIDNil(t *testing.T) {
	got := ClassifyOutboundMessage("task_log", nil, nil, nil, nil)
	if got != ClassTaskLogIgnored {
		t.Fatalf("expected ClassTaskLogIgnored, got %v", got)
	}
}

func TestClassifyOutboundMessage_AgentRoute(t *testing.T) {
	got := ClassifyOutboundMessage("chat", strp("agent"), strp("target-1"), nil, nil)
	if got != ClassAgentRoute {
		t.Fatalf("expected ClassAgentRoute, got %v", got)
	}
}

func TestClassifyOutboundMessage_MissingRoutingFields(t *testing.T) {
	if got := ClassifyOutboundMessage("chat", nil, strp("123"), nil, nil); got != ClassMissingRoutingFields {
		t.Fatalf("expected ClassMissingRoutingFields (nil channelType), got %v", got)
	}
	if got := ClassifyOutboundMessage("chat", strp("telegram"), nil, nil, nil); got != ClassMissingRoutingFields {
		t.Fatalf("expected ClassMissingRoutingFields (nil platformID), got %v", got)
	}
}

func TestClassifyOutboundMessage_Channel(t *testing.T) {
	got := ClassifyOutboundMessage("chat", strp("telegram"), strp("123"), nil, nil)
	if got != ClassChannel {
		t.Fatalf("expected ClassChannel, got %v", got)
	}
}

// --- ResolveDeliveryTarget ---

func TestResolveDeliveryTarget_OriginChatWins(t *testing.T) {
	origin := &MessagingGroupCandidate{ID: "mg-origin", ChannelType: "telegram", PlatformID: "123", Instance: "telegram"}
	ownDestination := &MessagingGroupCandidate{ID: "mg-other", ChannelType: "telegram", PlatformID: "123", Instance: "telegram-2"}
	target, err := ResolveDeliveryTarget("telegram", "123", strp("mg-origin"), origin, ownDestination, nil, true, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.MessagingGroupID != "mg-origin" || target.Instance != "telegram" {
		t.Fatalf("expected origin mg to win, got %+v", target)
	}
}

func TestResolveDeliveryTarget_OriginMismatchFallsBackToOwnDestination(t *testing.T) {
	// origin exists but targets a different channel/platform than this message.
	origin := &MessagingGroupCandidate{ID: "mg-origin", ChannelType: "telegram", PlatformID: "999"}
	ownDestination := &MessagingGroupCandidate{ID: "mg-dest", ChannelType: "telegram", PlatformID: "123", Instance: "telegram"}
	target, err := ResolveDeliveryTarget("telegram", "123", strp("mg-origin"), origin, ownDestination, nil, true, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.MessagingGroupID != "mg-dest" {
		t.Fatalf("expected fallback to own-destination mg, got %+v", target)
	}
}

func TestResolveDeliveryTarget_FallsBackToByPlatform(t *testing.T) {
	byPlatform := &MessagingGroupCandidate{ID: "mg-platform", ChannelType: "telegram", PlatformID: "123"}
	target, err := ResolveDeliveryTarget("telegram", "123", nil, nil, nil, byPlatform, false, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.MessagingGroupID != "mg-platform" {
		t.Fatalf("expected by-platform mg, got %+v", target)
	}
}

func TestResolveDeliveryTarget_UnknownMessagingGroup(t *testing.T) {
	_, err := ResolveDeliveryTarget("telegram", "123", nil, nil, nil, nil, false, false)
	var unknown *UnknownMessagingGroupError
	if !errors.As(err, &unknown) {
		t.Fatalf("expected UnknownMessagingGroupError, got %v", err)
	}
}

func TestResolveDeliveryTarget_DetachedMessagingGroup(t *testing.T) {
	byPlatform := &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123", DetachedAt: strp("2026-08-01T00:00:00.000Z")}
	_, err := ResolveDeliveryTarget("telegram", "123", nil, nil, nil, byPlatform, false, false)
	var detached *DetachedMessagingGroupError
	if !errors.As(err, &detached) {
		t.Fatalf("expected DetachedMessagingGroupError, got %v", err)
	}
}

func TestResolveDeliveryTarget_UnauthorizedNonOriginWithoutDestinationRow(t *testing.T) {
	byPlatform := &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123"}
	// sessionMessagingGroupID is a different mg (or nil) -> not origin chat.
	_, err := ResolveDeliveryTarget("telegram", "123", strp("mg-different"), nil, nil, byPlatform, true, false)
	var unauthorized *UnauthorizedDestinationError
	if !errors.As(err, &unauthorized) {
		t.Fatalf("expected UnauthorizedDestinationError, got %v", err)
	}
}

func TestResolveDeliveryTarget_NonOriginAllowedWithDestinationRow(t *testing.T) {
	byPlatform := &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123", Instance: "telegram"}
	target, err := ResolveDeliveryTarget("telegram", "123", strp("mg-different"), nil, nil, byPlatform, true, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.MessagingGroupID != "mg-1" {
		t.Fatalf("expected allowed delivery, got %+v", target)
	}
}

func TestResolveDeliveryTarget_NonOriginAllowedWhenAgentDestinationsTableMissing(t *testing.T) {
	// Module not installed: agent_destinations doesn't exist, so any
	// non-origin channel send is permitted regardless of hasDestinationRow.
	byPlatform := &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123"}
	target, err := ResolveDeliveryTarget("telegram", "123", strp("mg-different"), nil, nil, byPlatform, false, false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.MessagingGroupID != "mg-1" {
		t.Fatalf("expected allowed delivery, got %+v", target)
	}
}

func TestResolveDeliveryTarget_OriginChatAlwaysAllowedRegardlessOfTable(t *testing.T) {
	origin := &MessagingGroupCandidate{ID: "mg-origin", ChannelType: "telegram", PlatformID: "123", Instance: "telegram"}
	target, err := ResolveDeliveryTarget("telegram", "123", strp("mg-origin"), origin, nil, nil, true, false)
	if err != nil {
		t.Fatalf("unexpected error for origin chat: %v", err)
	}
	if target.MessagingGroupID != "mg-origin" {
		t.Fatalf("expected origin chat to be allowed, got %+v", target)
	}
}

// --- NextAttempt ---

func TestNextAttempt_RetriesBelowMax(t *testing.T) {
	for previous := 0; previous < MaxDeliveryAttempts-1; previous++ {
		attempts, giveUp := NextAttempt(previous)
		if attempts != previous+1 {
			t.Fatalf("expected attempts=%d, got %d", previous+1, attempts)
		}
		if giveUp {
			t.Fatalf("expected no give-up at previous=%d (attempts=%d)", previous, attempts)
		}
	}
}

func TestNextAttempt_GivesUpAtMax(t *testing.T) {
	attempts, giveUp := NextAttempt(MaxDeliveryAttempts - 1)
	if attempts != MaxDeliveryAttempts {
		t.Fatalf("expected attempts=%d, got %d", MaxDeliveryAttempts, attempts)
	}
	if !giveUp {
		t.Fatalf("expected give-up once attempts reaches MaxDeliveryAttempts")
	}
}

// --- InflightGuard ---

func TestInflightGuard_PreventsReentry(t *testing.T) {
	g := NewInflightGuard()
	if !g.TryEnter("session-1") {
		t.Fatalf("expected first TryEnter to succeed")
	}
	if g.TryEnter("session-1") {
		t.Fatalf("expected second concurrent TryEnter on the same session to fail")
	}
	if !g.TryEnter("session-2") {
		t.Fatalf("expected TryEnter for a different session to succeed independently")
	}
}

func TestInflightGuard_AllowsAfterLeave(t *testing.T) {
	g := NewInflightGuard()
	if !g.TryEnter("session-1") {
		t.Fatalf("expected first TryEnter to succeed")
	}
	g.Leave("session-1")
	if !g.TryEnter("session-1") {
		t.Fatalf("expected TryEnter to succeed again after Leave")
	}
}

// --- Deliver (composed boundary, exercised against FakeAdapter) ---

func TestDeliver_ChannelHappyPath(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: strp("telegram"), PlatformID: strp("123"), Content: `{"text":"hi"}`}
	lookups := TargetLookups{
		Origin: &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123", Instance: "telegram"},
	}
	outcome, err := Deliver(context.Background(), ev, strp("mg-1"), nil, lookups, adapter)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Classification != ClassChannel {
		t.Fatalf("expected ClassChannel, got %v", outcome.Classification)
	}
	if outcome.PlatformMessageID == "" {
		t.Fatalf("expected a platform message id")
	}
	if adapter.CallCount() != 1 {
		t.Fatalf("expected exactly one adapter call, got %d", adapter.CallCount())
	}
	call := adapter.Calls[0]
	if call.ChannelType != "telegram" || call.PlatformID != "123" || call.Content != `{"text":"hi"}` || call.Instance != "telegram" {
		t.Fatalf("unexpected call recorded: %+v", call)
	}
}

func TestDeliver_ChannelUnknownMessagingGroupPropagatesError(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: strp("telegram"), PlatformID: strp("123")}
	_, err := Deliver(context.Background(), ev, nil, nil, TargetLookups{}, adapter)
	var unknown *UnknownMessagingGroupError
	if !errors.As(err, &unknown) {
		t.Fatalf("expected UnknownMessagingGroupError, got %v", err)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call when target resolution fails, got %d", adapter.CallCount())
	}
}

func TestDeliver_ChannelDetachedPropagatesError(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: strp("telegram"), PlatformID: strp("123")}
	lookups := TargetLookups{
		ByPlatform: &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123", DetachedAt: strp("2026-08-01T00:00:00.000Z")},
	}
	_, err := Deliver(context.Background(), ev, nil, nil, lookups, adapter)
	var detached *DetachedMessagingGroupError
	if !errors.As(err, &detached) {
		t.Fatalf("expected DetachedMessagingGroupError, got %v", err)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call for a detached messaging group, got %d", adapter.CallCount())
	}
}

func TestDeliver_ChannelUnauthorizedPropagatesError(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: strp("telegram"), PlatformID: strp("123")}
	lookups := TargetLookups{
		ByPlatform:                   &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123"},
		AgentDestinationsTableExists: true,
		HasDestinationRow:            false,
	}
	_, err := Deliver(context.Background(), ev, strp("mg-different"), nil, lookups, adapter)
	var unauthorized *UnauthorizedDestinationError
	if !errors.As(err, &unauthorized) {
		t.Fatalf("expected UnauthorizedDestinationError, got %v", err)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call when unauthorized, got %d", adapter.CallCount())
	}
}

func TestDeliver_ChannelMissingAdapterPropagatesError(t *testing.T) {
	adapter := NewFakeAdapter()
	adapter.Result = func(call FakeDeliverCall, callIndex int) (string, error) {
		return "", &NoChannelAdapterError{ChannelType: call.ChannelType, Instance: call.Instance}
	}
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: strp("telegram"), PlatformID: strp("123")}
	lookups := TargetLookups{
		ByPlatform: &MessagingGroupCandidate{ID: "mg-1", ChannelType: "telegram", PlatformID: "123", Instance: "telegram-2"},
	}
	_, err := Deliver(context.Background(), ev, nil, nil, lookups, adapter)
	var noAdapter *NoChannelAdapterError
	if !errors.As(err, &noAdapter) {
		t.Fatalf("expected NoChannelAdapterError, got %v", err)
	}
	if noAdapter.Instance != "telegram-2" {
		t.Fatalf("expected the resolved instance to reach the adapter call, got %+v", noAdapter)
	}
}

func TestDeliver_SystemClassificationSkipsAdapter(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "system", ChannelType: strp("telegram"), PlatformID: strp("123")}
	outcome, err := Deliver(context.Background(), ev, nil, nil, TargetLookups{}, adapter)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Classification != ClassSystemAction {
		t.Fatalf("expected ClassSystemAction, got %v", outcome.Classification)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call for a system action, got %d", adapter.CallCount())
	}
}

func TestDeliver_TaskLogClassificationSkipsAdapter(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "task_log"}
	outcome, err := Deliver(context.Background(), ev, nil, strp("system:tasks:series-1"), TargetLookups{}, adapter)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Classification != ClassTaskLog {
		t.Fatalf("expected ClassTaskLog, got %v", outcome.Classification)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call for a task_log row, got %d", adapter.CallCount())
	}
}

func TestDeliver_TaskLogIgnoredClassificationSkipsAdapter(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "task_log"}
	outcome, err := Deliver(context.Background(), ev, nil, strp("telegram:12345"), TargetLookups{}, adapter)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Classification != ClassTaskLogIgnored {
		t.Fatalf("expected ClassTaskLogIgnored, got %v", outcome.Classification)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call for an ignored task_log row, got %d", adapter.CallCount())
	}
}

func TestDeliver_AgentRouteClassificationSkipsAdapter(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: strp("agent"), PlatformID: strp("target-agent-group")}
	outcome, err := Deliver(context.Background(), ev, nil, nil, TargetLookups{}, adapter)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Classification != ClassAgentRoute {
		t.Fatalf("expected ClassAgentRoute, got %v", outcome.Classification)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call for agent routing, got %d", adapter.CallCount())
	}
}

func TestDeliver_MissingRoutingFieldsSkipsAdapter(t *testing.T) {
	adapter := NewFakeAdapter()
	ev := OutboundEvent{ID: "msg-1", Kind: "chat", ChannelType: nil, PlatformID: nil}
	outcome, err := Deliver(context.Background(), ev, nil, nil, TargetLookups{}, adapter)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Classification != ClassMissingRoutingFields {
		t.Fatalf("expected ClassMissingRoutingFields, got %v", outcome.Classification)
	}
	if adapter.CallCount() != 0 {
		t.Fatalf("expected no adapter call when routing fields are missing, got %d", adapter.CallCount())
	}
}

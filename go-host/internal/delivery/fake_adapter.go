package delivery

import (
	"context"
	"fmt"
	"sync"
)

// FakeDeliverCall records one call made through FakeAdapter.Deliver, for
// tests to assert against.
type FakeDeliverCall struct {
	ChannelType string
	PlatformID  string
	ThreadID    *string
	Kind        string
	Content     string
	Instance    string
}

// FakeAdapter is the "fake adapter" this milestone's own task instructions
// call for ("Use a fake adapter in tests; do not rewrite Telegram/Slack").
// It stands in for a real TypeScript channel adapter reached over whatever
// boundary protocol eventually implements Adapter for production — this
// package only needs to prove the boundary shape works, not build that
// transport.
//
// By default Deliver returns a synthetic, deterministic platform message id
// derived from the call count, so tests that don't care about the exact id
// can still assert delivery succeeded. Set Result to control the return
// value or force an error (including NoChannelAdapterError, to exercise the
// missing-live-adapter path Deliver is required to propagate).
type FakeAdapter struct {
	mu     sync.Mutex
	Calls  []FakeDeliverCall
	Result func(call FakeDeliverCall, callIndex int) (platformMessageID string, err error)
}

// NewFakeAdapter returns a FakeAdapter with the default deterministic
// success behavior.
func NewFakeAdapter() *FakeAdapter {
	return &FakeAdapter{}
}

// Deliver implements Adapter.
func (f *FakeAdapter) Deliver(_ context.Context, channelType, platformID string, threadID *string, kind, content, instance string) (string, error) {
	f.mu.Lock()
	call := FakeDeliverCall{
		ChannelType: channelType,
		PlatformID:  platformID,
		ThreadID:    threadID,
		Kind:        kind,
		Content:     content,
		Instance:    instance,
	}
	f.Calls = append(f.Calls, call)
	callIndex := len(f.Calls) - 1
	result := f.Result
	f.mu.Unlock()

	if result != nil {
		return result(call, callIndex)
	}
	return fmt.Sprintf("fake-platform-msg-%d", callIndex+1), nil
}

// CallCount returns how many times Deliver has been called, safe to read
// concurrently with in-flight Deliver calls.
func (f *FakeAdapter) CallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.Calls)
}

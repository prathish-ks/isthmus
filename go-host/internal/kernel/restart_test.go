package kernel

import (
	"context"
	"encoding/json"
	"testing"
)

// This file is P9-03's crash/restart/duplicate-semantics suite (master
// plan: "Kill host/container at controlled message lifecycle points and
// test restart, duplicate/loss semantics... Done when: Recovery
// expectations pass repeatedly and are documented").
//
// The crux, confirmed by reading internal/lifecycle.Registry's source: it
// is purely in-memory (no database/sql, no sqlite) — every field is a plain
// Go map guarded by a mutex. New() constructs a fresh, empty Registry every
// time (server.go: `registry: lifecycle.NewRegistry()`), and there is no
// exported way to hand New an existing Registry. A process restart of
// `nanogo serve` — the only thing that can construct a Kernel in
// production, per cmd/nanogo — therefore always starts from zero
// session-to-container tracking, no matter how many sessions were running
// a moment before the restart. These tests pin the resulting behavior,
// document it as EXPECTED (not a bug to fix here — see each test's own
// comment for why), and would catch a regression in either direction: a
// registry that started silently persisting across restarts (which would
// change LAW-05's "no durable component without justification" posture),
// or one that stopped failing closed on a genuinely unknown session.

// TestKill_AfterKernelRestart_ReturnsUnknownSession pins the direct
// consequence of Registry's in-memory-only nature: a session this exact
// Kernel instance woke is completely unknown to a newly constructed Kernel,
// even though nothing about the underlying container changed. This is
// exactly the gap EC-02's own TS-side fallback (KernelError{code:
// "unknown-session"} triggering a local `docker stop`) exists to paper
// over — this test is what proves that fallback path is reachable, not
// theoretical.
func TestKill_AfterKernelRestart_ReturnsUnknownSession(t *testing.T) {
	preRestartExec := &fakeExecutor{}
	preRestart := New(testPolicy(), withExecutor(preRestartExec))
	spec := validSession()
	if resp := dispatch(t, preRestart, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	}); !resp.OK {
		t.Fatalf("setup wake failed: %+v", resp.Error)
	}
	if !preRestart.registry.IsRunning("sess-1") {
		t.Fatal("setup: session should be tracked as running before the simulated restart")
	}

	// Simulate a `nanogo serve` restart: a brand-new Kernel, brand-new
	// Executor, brand-new (empty) Registry — exactly what cmd/nanogo's
	// buildServeKernel produces on every invocation, with no step that
	// could re-populate it from the still-running container.
	postRestartExec := &fakeExecutor{}
	postRestart := New(testPolicy(), withExecutor(postRestartExec))

	resp := dispatch(t, postRestart, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
		Reason:     "post-restart cleanup attempt",
	})
	if resp.OK || resp.Error == nil || resp.Error.Code != ErrUnknownSession {
		t.Fatalf("expected unknown-session denial from the post-restart kernel, got %+v", resp)
	}
	if postRestartExec.killCalls != 0 {
		t.Fatalf("SECURITY: post-restart kernel executed a kill despite having no registry record for the session (calls=%d)", postRestartExec.killCalls)
	}
	// The pre-restart container is now orphaned from every kernel's
	// tracking — real cleanup can only happen through the TS-side
	// unknown-session fallback (docker stop by predicted container name),
	// not through this kernel's own Kill path. Documenting, not fixing,
	// that gap here.
}

// TestWake_DuplicateSessionID_OverwritesRegistryEntry pins handleWake's
// documented lack of an idempotency guard (see internal/kernel/capability.go:
// handleWake calls k.registry.Register unconditionally — there is no
// pre-check against an existing entry for the same session id, unlike
// lifecycle.Registry.Wake's own dedup, which handleWake does not use). A
// second wake for a session id already registered silently replaces the
// first Runtime object rather than being rejected or joined: the first
// container becomes untracked (Get can never return it again, so Kill can
// never resolve its name), while the executor is asked to spawn a second,
// independent container under the same session id. TS-side pre-wake
// container-name prediction is what is understood to prevent this from
// being reached in the normal request path (see this file's package
// comment) — this test exists so that protection is never silently relied
// upon without a test pinning what happens if it's ever bypassed or wrong.
func TestWake_DuplicateSessionID_OverwritesRegistryEntry(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()

	if resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	}); !resp.OK {
		t.Fatalf("first wake failed: %+v", resp.Error)
	}
	firstRuntime, ok := k.registry.Get("sess-1")
	if !ok {
		t.Fatal("setup: expected a registry entry after the first wake")
	}

	if resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	}); !resp.OK {
		t.Fatalf("second wake failed: %+v", resp.Error)
	}

	if exec.wakeCalls != 2 {
		t.Fatalf("expected the executor to be asked to spawn twice (no dedup), got %d calls", exec.wakeCalls)
	}
	secondRuntime, ok := k.registry.Get("sess-1")
	if !ok {
		t.Fatal("expected a registry entry to still exist after the second wake")
	}
	if secondRuntime == firstRuntime {
		t.Fatal("expected the second wake to replace the registry entry with a new Runtime object, not reuse the first")
	}
	// The orphaning consequence, made concrete: nothing in this kernel can
	// ever again resolve the FIRST container's name — Kill only ever reads
	// whatever is currently registered.
	if resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
	}); !resp.OK {
		t.Fatalf("expected kill to succeed against the second (currently registered) runtime, got %+v", resp.Error)
	}
	if exec.killCalls != 1 || exec.killedName != secondRuntime.ContainerName {
		t.Fatalf("expected exactly one kill, of the SECOND runtime's container (%q); got calls=%d name=%q",
			secondRuntime.ContainerName, exec.killCalls, exec.killedName)
	}
	// The first container was never killed through this kernel and never
	// can be — it has no registry entry left to resolve its name from.
}

// TestKill_ThenKillAgain_SecondCallReturnsUnknownSession pins the
// intentional, safe half of duplicate-request semantics: unlike a
// duplicate Wake, a duplicate Kill for the same session id is NOT a
// silent double-exec risk. handleKill's Runtime.MarkFinished() single-shot
// guard (mirrored from container-runner.ts's finishAndResolve) ensures
// Unregister only ever runs once per Runtime; the second Kill then finds
// nothing in the registry and fails closed with ErrUnknownSession, rather
// than re-invoking the executor's Kill against an already-stopped
// container.
func TestKill_ThenKillAgain_SecondCallReturnsUnknownSession(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	if resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	}); !resp.OK {
		t.Fatalf("setup wake failed: %+v", resp.Error)
	}

	first := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
		Reason:     "first kill",
	})
	if !first.OK {
		t.Fatalf("expected first kill to succeed, got %+v", first.Error)
	}
	if exec.killCalls != 1 {
		t.Fatalf("expected exactly 1 kill call after the first Kill, got %d", exec.killCalls)
	}

	second := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
		Reason:     "duplicate kill",
	})
	if second.OK || second.Error == nil || second.Error.Code != ErrUnknownSession {
		t.Fatalf("expected the second kill to fail closed with unknown-session, got %+v", second)
	}
	if exec.killCalls != 1 {
		t.Fatalf("SECURITY: duplicate kill re-invoked the executor against an already-stopped container (calls=%d)", exec.killCalls)
	}
}

// TestServe_RestartOverSameSocketPath_LosesRegistryButStaysUpForNewWork is
// the real end-to-end version of TestKill_AfterKernelRestart_ReturnsUnknownSession:
// a genuine process restart, over a real Unix socket, at the exact address
// the TS host's kernel client would reconnect to. It proves the in-memory
// loss isn't an artifact of calling Dispatch directly in-process — a fresh
// Kernel serving on the very same socket path exhibits the identical
// fail-closed behavior for a session it never itself woke, and remains
// otherwise fully functional for new work afterward.
func TestServe_RestartOverSameSocketPath_LosesRegistryButStaysUpForNewWork(t *testing.T) {
	sockPath := shortSocketPath(t)

	// --- "before restart": one kernel instance wakes a session ---
	preExec := &fakeExecutor{}
	pre := New(testPolicy(), withExecutor(preExec))
	preCtx, preCancel := context.WithCancel(context.Background())
	preServeErr := make(chan error, 1)
	go func() { preServeErr <- pre.Serve(preCtx, sockPath) }()

	conn := dialWithRetry(t, sockPath)
	spec := validSession()
	wakeResp := sendEnvelope(t, conn, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
	})
	if !wakeResp.OK {
		t.Fatalf("setup wake over socket failed: %+v", wakeResp.Error)
	}
	_ = conn.Close()

	// --- crash/restart: stop serving, close the listener, start a brand
	// new Kernel + Executor on the exact same path (Serve's own os.Remove
	// makes this safe even though the old socket file is still present) ---
	preCancel()
	if err := <-preServeErr; err != nil {
		t.Fatalf("pre-restart Serve returned an unexpected error on shutdown: %v", err)
	}

	postExec := &fakeExecutor{}
	post := New(testPolicy(), withExecutor(postExec))
	postCtx, postCancel := context.WithCancel(context.Background())
	defer postCancel()
	postServeErr := make(chan error, 1)
	go func() { postServeErr <- post.Serve(postCtx, sockPath) }()

	conn2 := dialWithRetry(t, sockPath)
	defer func() { _ = conn2.Close() }()

	// A naive TS client that hasn't yet learned about the restart tries to
	// clean up the session it thinks is still running.
	killResp := sendEnvelope(t, conn2, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
	})
	if killResp.OK || killResp.Error == nil || killResp.Error.Code != ErrUnknownSession {
		t.Fatalf("expected the post-restart kernel to deny the stale kill with unknown-session, got %+v", killResp)
	}
	if postExec.killCalls != 0 {
		t.Fatalf("SECURITY: post-restart kernel executed a kill for a session it never woke (calls=%d)", postExec.killCalls)
	}

	// The restarted kernel is otherwise perfectly healthy: new work
	// succeeds normally.
	freshSpec := validSession()
	freshSpec.Key.SessionID = "sess-2"
	freshResp := sendEnvelope(t, conn2, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &freshSpec,
	})
	if !freshResp.OK {
		t.Fatalf("expected the post-restart kernel to accept new work normally, got %+v", freshResp.Error)
	}
	if postExec.wakeCalls != 1 {
		t.Fatalf("expected exactly 1 wake call on the post-restart kernel, got %d", postExec.wakeCalls)
	}
}

// sendEnvelope marshals payload into an Envelope for op, writes it
// newline-delimited to conn, and decodes the single-line ResponseEnvelope
// reply — the same wire shape TestServe_RoundTripOverUnixSocket exercises,
// factored out here so this file's restart tests can send more than one
// request per connection lifetime without repeating the boilerplate.
func sendEnvelope(t *testing.T, conn interface {
	Write([]byte) (int, error)
	Read([]byte) (int, error)
}, op Op, payload any) ResponseEnvelope {
	t.Helper()
	rawPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	env := Envelope{Version: ProtocolVersion, Op: op, RequestID: "r1", Payload: rawPayload}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if _, err := conn.Write(append(raw, '\n')); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var resp ResponseEnvelope
	if err := json.Unmarshal(buf[:n], &resp); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	return resp
}

package kernel

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/delivery"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
	"github.com/prathish-ks/isthmus/go-host/internal/session"
	msgtrace "github.com/prathish-ks/isthmus/go-host/internal/trace"
)

// fakeExecutor records every call it receives, so tests can assert not just
// "the response was a denial" but "exec was never reached" — the actual
// claim doc.go's enforcement design makes.
type fakeExecutor struct {
	wakeCalls    int
	buildCalls   int
	killCalls    int
	killedName   string
	killedGrace  int
	dockerfileIn string
}

func (f *fakeExecutor) Wake(ctx context.Context, spec mount.Session, runAs containerdefaults.RunAs, resources containerdefaults.Resources) (string, string, error) {
	f.wakeCalls++
	name := "container-" + spec.Key.SessionID
	return name, name, nil
}

func (f *fakeExecutor) BuildImage(ctx context.Context, contextDir, imageTag, dockerfile string) (string, error) {
	f.buildCalls++
	f.dockerfileIn = dockerfile
	return imageTag, nil
}

func (f *fakeExecutor) Kill(ctx context.Context, containerName string, graceSeconds int) error {
	f.killCalls++
	f.killedName = containerName
	f.killedGrace = graceSeconds
	return nil
}

func testPolicy() mount.Policy {
	return mount.Policy{
		GroupsRoot:    "/data/groups",
		DataRoot:      "/data",
		SurfaceRoots:  []string{"/app/container/agent-runner/src"},
		MaterialsRoot: "/data/session-materials",
	}
}

func validSession() mount.Session {
	return mount.Session{
		Key:    mount.SessionKey{InstallSlug: "test", AgentGroupID: "ag-1", SessionID: "sess-1"},
		Labels: map[string]string{mount.GroupFolderLabel: "ag-1-folder"},
		Containers: []mount.Container{
			{Role: "agent", Env: map[string]string{}},
		},
		RuntimeTier: "container",
	}
}

func dispatch(t *testing.T, k *Kernel, op Op, payload any) ResponseEnvelope {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return k.Dispatch(context.Background(), Envelope{
		Version:   ProtocolVersion,
		Op:        op,
		RequestID: "req-1",
		Payload:   raw,
	})
}

// --- protocol-level ---

func TestDispatch_RejectsUnsupportedVersion(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := k.Dispatch(context.Background(), Envelope{Version: "v2", Op: OpStatusTrace, RequestID: "r"})
	if resp.OK || resp.Error == nil || resp.Error.Code != ErrUnsupportedVersion {
		t.Fatalf("expected unsupported-version denial, got %+v", resp)
	}
}

func TestDispatch_RejectsUnknownOp(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := k.Dispatch(context.Background(), Envelope{Version: ProtocolVersion, Op: "container.exec_raw", RequestID: "r"})
	if resp.OK || resp.Error == nil || resp.Error.Code != ErrUnknownOp {
		t.Fatalf("expected unknown-op denial (there is no raw-exec op to find), got %+v", resp)
	}
}

func TestDispatch_RejectsMalformedPayload(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := k.Dispatch(context.Background(), Envelope{Version: ProtocolVersion, Op: OpRouteRequest, RequestID: "r", Payload: json.RawMessage(`{not json`)})
	if resp.OK || resp.Error == nil || resp.Error.Code != ErrMalformedPayload {
		t.Fatalf("expected malformed-payload, got %+v", resp)
	}
}

// --- CapabilityRequest: the enforcement seam itself ---

func TestCapabilityRequest_Wake_ValidSpec_ExecutesExactlyOnce(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptr(validSession()),
	})
	if !resp.OK {
		t.Fatalf("expected allow, got error %+v", resp.Error)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected exactly 1 Wake call, got %d", exec.wakeCalls)
	}
	var payload CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &payload); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !payload.Allowed || payload.ContainerID == "" {
		t.Fatalf("expected allowed with a container id, got %+v", payload)
	}
}

// This is the test that proves exclusivity, not just correctness: a spec
// mount.ValidateSpec denies must produce ZERO calls to the executor. If
// this ever failed, it would mean a caller could get docker to run despite
// a failed validation — exactly the bypass P6-02 exists to close.
func TestCapabilityRequest_Wake_InvalidSpec_NeverReachesExecutor(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	bad := validSession()
	// A mount claiming group-state but pointing outside any group root —
	// exactly the class of denial mount.ValidateSpec exists to catch.
	bad.Containers[0].Mounts = []mount.Spec{{
		Class:         mount.ClassGroupState,
		HostPath:      "/etc/passwd",
		ContainerPath: "/workspace/x",
		Mode:          mount.ModeRW,
		GroupScope:    "ag-1",
	}}
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &bad,
	})
	if resp.OK {
		t.Fatalf("expected denial for out-of-root group-state mount, got success")
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was called %d times despite a denied spec", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_UnsafeRunAs_NeverReachesExecutor(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    &spec,
		RunAs:      &containerdefaults.RunAs{UID: 0, GID: 0, Set: true},
	})
	if resp.OK {
		t.Fatalf("expected denial for root RunAs, got success")
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("SECURITY: executor was called despite an unsafe RunAs")
	}
}

func TestCapabilityRequest_Kill_UnknownSession_NeverReachesExecutor(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-does-not-exist",
	})
	if resp.OK || resp.Error.Code != ErrUnknownSession {
		t.Fatalf("expected unknown-session denial, got %+v", resp)
	}
	if exec.killCalls != 0 {
		t.Fatalf("SECURITY: kill executed for a session this kernel never spawned")
	}
}

// The non-capability this proves: there is no field a caller can set to
// name an arbitrary container. Kill only ever resolves the name THIS
// kernel recorded at wake time.
func TestCapabilityRequest_Kill_ResolvesNameFromOwnRegistry_NotFromCaller(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	if resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{Capability: CapabilityContainerWake, Session: &spec}); !resp.OK {
		t.Fatalf("setup wake failed: %+v", resp.Error)
	}
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
		Reason:     "test teardown",
	})
	if !resp.OK {
		t.Fatalf("expected kill to succeed, got %+v", resp.Error)
	}
	if exec.killCalls != 1 || exec.killedName != "container-sess-1" {
		t.Fatalf("expected kill of the registry-recorded name, got calls=%d name=%q", exec.killCalls, exec.killedName)
	}
}

func TestCapabilityRequest_BuildImage_RejectsIllegalTag_NeverReachesExecutor(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "'; rm -rf /; echo '",
		Dockerfile:   "FROM scratch\n",
	})
	if resp.OK {
		t.Fatalf("expected denial for an illegal image tag, got success")
	}
	if exec.buildCalls != 0 {
		t.Fatalf("SECURITY: build executed with an illegal tag")
	}
}

func TestCapabilityRequest_BuildImage_HasNoCallerSuppliedContextDirField(t *testing.T) {
	// Compile-time proof, not a runtime assertion: CapabilityRequestPayload
	// has no BuildContextDir field at all, so this test's own construction
	// (setting only AgentGroupID/GroupFolder/ImageTag/Dockerfile) is the only
	// way to reach build_image — there is no alternate field to inspect.
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent-ag-1",
		Dockerfile:   "FROM scratch\n",
	})
	if !resp.OK {
		t.Fatalf("expected a legal build request to succeed, got %+v", resp.Error)
	}
	if exec.buildCalls != 1 {
		t.Fatalf("expected exactly one BuildImage call, got %d", exec.buildCalls)
	}
}

func TestCapabilityRequest_UnknownCapability_Rejected(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{Capability: "container.exec"})
	if resp.OK || resp.Error.Code != ErrUnknownCapability {
		t.Fatalf("expected unknown-capability for a made-up capability name, got %+v", resp)
	}
}

func ptr[T any](v T) *T { return &v }

// --- RouteRequest ---

func TestRouteRequest_WiringEngageAndDeliver(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := dispatch(t, k, OpRouteRequest, RouteRequestPayload{
		Kind: "wiring", EngageMode: "mention", IsMention: true,
		AccessAllowed: true, ScopeAllowed: true,
		ConfiguredMode: "shared", MessageID: "m1", AgentGroupID: "ag-1",
	})
	var payload RouteResponsePayload
	mustUnmarshal(t, resp, &payload)
	if !payload.Engage || !payload.Deliver || !payload.Wake {
		t.Fatalf("expected engage+deliver+wake, got %+v", payload)
	}
	if payload.NamespacedMessageID != "m1:ag-1" {
		t.Fatalf("expected namespaced message id, got %q", payload.NamespacedMessageID)
	}
}

func TestRouteRequest_WiringGateDenied_NeverAccumulates(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := dispatch(t, k, OpRouteRequest, RouteRequestPayload{
		Kind: "wiring", EngageMode: "mention", IsMention: true,
		AccessAllowed: false, ScopeAllowed: true,
		IgnoredPolicy: "accumulate",
	})
	var payload RouteResponsePayload
	mustUnmarshal(t, resp, &payload)
	if payload.Deliver {
		t.Fatalf("SECURITY: a gate-refused engagement must never be delivered, even under an accumulate policy; got %+v", payload)
	}
}

func TestRouteRequest_UnwiredChannel(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := dispatch(t, k, OpRouteRequest, RouteRequestPayload{Kind: "unwired", IsMention: true, Denied: false})
	var payload RouteResponsePayload
	mustUnmarshal(t, resp, &payload)
	if payload.Action != "record" {
		t.Fatalf("expected action=record, got %+v", payload)
	}
}

func TestRouteRequest_RejectsUnknownKind(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := dispatch(t, k, OpRouteRequest, RouteRequestPayload{Kind: "something-else"})
	if resp.OK || resp.Error.Code != ErrSpecInvalid {
		t.Fatalf("expected spec-invalid for an unknown kind, got %+v", resp)
	}
}

// --- SessionLookup ---

func testDB(t *testing.T) *sql.DB {
	t.Helper()
	dir := t.TempDir()
	db, err := session.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestSessionLookup_NoDB_Denied(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	resp := dispatch(t, k, OpSessionLookup, SessionLookupPayload{Mode: "get", ID: "s1"})
	if resp.OK {
		t.Fatalf("expected denial when no session DB is configured")
	}
}

func TestSessionLookup_ResolveThenGet(t *testing.T) {
	db := testDB(t)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithSessionDB(db))

	resolveResp := dispatch(t, k, OpSessionLookup, SessionLookupPayload{
		Mode: "resolve", AgentGroupID: "ag-1", MessagingGroupID: "mg-1", ConfiguredMode: "shared",
	})
	var resolved SessionLookupResponsePayload
	mustUnmarshal(t, resolveResp, &resolved)
	if !resolved.Found || !resolved.Created || resolved.Session == nil {
		t.Fatalf("expected a newly created session, got %+v", resolved)
	}

	getResp := dispatch(t, k, OpSessionLookup, SessionLookupPayload{Mode: "get", ID: resolved.Session.ID})
	var got SessionLookupResponsePayload
	mustUnmarshal(t, getResp, &got)
	if !got.Found || got.Session.ID != resolved.Session.ID {
		t.Fatalf("expected to find the just-created session, got %+v", got)
	}
}

func TestSessionLookup_GetMissing_FoundFalse_NotAnError(t *testing.T) {
	db := testDB(t)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithSessionDB(db))
	resp := dispatch(t, k, OpSessionLookup, SessionLookupPayload{Mode: "get", ID: "does-not-exist"})
	if !resp.OK {
		t.Fatalf("a missing session is Found:false, not a protocol error; got %+v", resp.Error)
	}
	var payload SessionLookupResponsePayload
	mustUnmarshal(t, resp, &payload)
	if payload.Found {
		t.Fatalf("expected Found=false")
	}
}

// --- DeliveryRequest ---

func TestDeliveryRequest_OriginChat_Allowed(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	mgID := "mg-1"
	origin := deliveryCandidate("mg-1", "whatsapp", "+1555")
	resp := dispatch(t, k, OpDeliveryRequest, DeliveryRequestPayload{
		ChannelType:             "whatsapp",
		PlatformID:              "+1555",
		SessionMessagingGroupID: &mgID,
		Origin:                  &origin,
		PreviousAttempts:        ptr(0),
	})
	var payload DeliveryResponsePayload
	mustUnmarshal(t, resp, &payload)
	if !payload.Allowed || payload.Target == nil {
		t.Fatalf("expected allowed delivery to the origin chat, got %+v", payload)
	}
	if payload.Attempts != 1 || payload.GiveUp {
		t.Fatalf("expected attempts=1, giveUp=false, got %+v", payload)
	}
}

func TestDeliveryRequest_UnauthorizedDestination_Denied(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	ownDest := deliveryCandidate("mg-2", "whatsapp", "+1999")
	resp := dispatch(t, k, OpDeliveryRequest, DeliveryRequestPayload{
		ChannelType:            "whatsapp",
		PlatformID:             "+1999",
		OwnDestination:         &ownDest,
		AgentDestinationsExist: true,
		HasDestinationRow:      false,
	})
	var payload DeliveryResponsePayload
	mustUnmarshal(t, resp, &payload)
	if payload.Allowed {
		t.Fatalf("expected denial for an unauthorized cross-channel destination, got %+v", payload)
	}
}

// --- StatusTrace ---

func TestStatusTrace_ReflectsWakeAndAuditLog(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{Capability: CapabilityContainerWake, Session: &spec})

	resp := dispatch(t, k, OpStatusTrace, struct{}{})
	var payload StatusTraceResponsePayload
	mustUnmarshal(t, resp, &payload)
	if len(payload.RunningSessions) != 1 || payload.RunningSessions[0] != "sess-1" {
		t.Fatalf("expected sess-1 running, got %+v", payload.RunningSessions)
	}
	if len(payload.RecentDecisions) != 1 || !payload.RecentDecisions[0].Allowed {
		t.Fatalf("expected one allowed decision in the audit log, got %+v", payload.RecentDecisions)
	}
	if payload.Host == "" {
		t.Fatalf("expected a non-empty host descriptor")
	}
}

// --- Serve: the actual socket transport, end to end ---

// shortSocketPath returns a socket path guaranteed to fit every target
// platform's sockaddr_un limit. Deliberately NOT t.TempDir(): macOS nests it
// under /var/folders/<x>/<x>/T/<TestName+random>/NNN/, which alone already
// approaches the 104-byte ceiling before the filename is even appended — the
// exact path that failed connect() with "invalid argument" on the user's
// real Mac while passing in the Linux sandbox (see maxSocketPathLen's own
// comment in server.go). /tmp is short on every POSIX platform this project
// targets, including macOS (where it is itself a symlink to /private/tmp,
// which is irrelevant here — sockaddr_un's length limit is on the literal
// string passed to connect(), not the resolved canonical path).
func shortSocketPath(t *testing.T) string {
	t.Helper()
	p := filepath.Join("/tmp", fmt.Sprintf("nck-%d-%d.sock", os.Getpid(), time.Now().UnixNano()))
	t.Cleanup(func() { _ = os.Remove(p) })
	return p
}

func TestServe_RejectsSocketPathOverPlatformLimit(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	tooLong := "/tmp/" + string(make([]byte, maxSocketPathLen)) + ".sock"
	err := k.Serve(context.Background(), tooLong)
	if err == nil {
		t.Fatal("expected Serve to reject an over-limit socket path with a clear error instead of letting the OS fail obscurely later")
	}
}

func TestServe_RoundTripOverUnixSocket(t *testing.T) {
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	sockPath := shortSocketPath(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serveErr := make(chan error, 1)
	go func() { serveErr <- k.Serve(ctx, sockPath) }()

	conn := dialWithRetry(t, sockPath)
	defer func() { _ = conn.Close() }()

	env := Envelope{Version: ProtocolVersion, Op: OpStatusTrace, RequestID: "r1", Payload: json.RawMessage(`{}`)}
	raw, _ := json.Marshal(env)
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
	if !resp.OK || resp.RequestID != "r1" {
		t.Fatalf("expected ok response echoing requestId, got %+v", resp)
	}

	info, err := os.Stat(sockPath)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("expected socket file mode 0600, got %v", info.Mode().Perm())
	}
}

func deliveryCandidate(id, channelType, platformID string) delivery.MessagingGroupCandidate {
	return delivery.MessagingGroupCandidate{ID: id, ChannelType: channelType, PlatformID: platformID}
}

func dialWithRetry(t *testing.T, sockPath string) net.Conn {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, err := net.Dial("unix", sockPath)
		if err == nil {
			return conn
		}
		lastErr = err
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("dial %s: %v", sockPath, lastErr)
	return nil
}

func mustUnmarshal(t *testing.T, resp ResponseEnvelope, v any) {
	t.Helper()
	if !resp.OK {
		t.Fatalf("expected ok response, got error %+v", resp.Error)
	}
	if err := json.Unmarshal(resp.Payload, v); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
}

// --- P7-03 message trace wiring ---

func TestTrace_NilTracerIsANoOp(t *testing.T) {
	// No WithTracer option supplied — every kernel built before P7-03 (and
	// every test above this section) relies on this staying silent.
	k := New(testPolicy(), withExecutor(&fakeExecutor{}))
	dispatch(t, k, OpRouteRequest, RouteRequestPayload{
		Kind: "wiring", EngageMode: "mention", IsMention: true,
		AccessAllowed: true, ScopeAllowed: true, ConfiguredMode: "shared", MessageID: "m1", AgentGroupID: "ag-1",
	})
	if k.tracer != nil {
		t.Fatal("tracer should be nil when WithTracer was never supplied")
	}
}

func TestTrace_RouteRequestRecordedByMessageID(t *testing.T) {
	store := msgtrace.NewStore(0)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithTracer(store))
	dispatch(t, k, OpRouteRequest, RouteRequestPayload{
		Kind: "wiring", EngageMode: "mention", IsMention: true,
		AccessAllowed: true, ScopeAllowed: true, ConfiguredMode: "shared", MessageID: "m1", AgentGroupID: "ag-1",
	})
	events := store.Trace("m1")
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].Stage != msgtrace.StageRoute {
		t.Fatalf("Stage = %q, want %q", events[0].Stage, msgtrace.StageRoute)
	}
}

func TestTrace_RouteRequestWithoutMessageIDRecordsNothing(t *testing.T) {
	store := msgtrace.NewStore(0)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithTracer(store))
	dispatch(t, k, OpRouteRequest, RouteRequestPayload{Kind: "unwired", Denied: true})
	if len(store.Trace("")) != 0 {
		t.Fatal("an event should never be recorded under an empty key")
	}
}

func TestTrace_CapabilityWakeRecordedBySessionID(t *testing.T) {
	store := msgtrace.NewStore(0)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithTracer(store))
	sess := validSession()
	dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake, Session: &sess,
	})
	events := store.Trace("sess-1")
	if len(events) != 1 || events[0].Stage != msgtrace.StageContainerWake {
		t.Fatalf("expected exactly one container_wake event for sess-1, got %+v", events)
	}
	if events[0].Summary == "" {
		t.Fatal("Summary should be non-empty (allowed=true/false)")
	}
}

func TestTrace_CapabilityWakeDenialStillRecorded(t *testing.T) {
	store := msgtrace.NewStore(0)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithTracer(store))
	bad := validSession()
	// Same denial shape as TestCapabilityRequest_Wake_InvalidSpec_NeverReachesExecutor:
	// a group-state mount pointing outside any group root.
	bad.Containers[0].Mounts = []mount.Spec{{
		Class:         mount.ClassGroupState,
		HostPath:      "/etc/passwd",
		ContainerPath: "/workspace/x",
		Mode:          mount.ModeRW,
		GroupScope:    "ag-1",
	}}
	dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake, Session: &bad,
	})
	events := store.Trace("sess-1")
	if len(events) != 1 {
		t.Fatalf("a denied wake should still be traced, got %d events", len(events))
	}
}

func TestTrace_SessionLookupRecordedByLookedUpID(t *testing.T) {
	store := msgtrace.NewStore(0)
	db := testDB(t)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithSessionDB(db), WithTracer(store))
	dispatch(t, k, OpSessionLookup, SessionLookupPayload{Mode: "get", ID: "s1"})
	events := store.Trace("s1")
	if len(events) != 1 || events[0].Stage != msgtrace.StageSession {
		t.Fatalf("expected exactly one session event for s1, got %+v", events)
	}
}

func TestTrace_DeliveryRequestRecordedByPlatformID(t *testing.T) {
	store := msgtrace.NewStore(0)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithTracer(store))
	dispatch(t, k, OpDeliveryRequest, DeliveryRequestPayload{
		ChannelType: "chat", PlatformID: "platform-1",
		Origin: &delivery.MessagingGroupCandidate{ID: "mg-1", ChannelType: "chat", PlatformID: "platform-1"},
	})
	events := store.Trace("platform-1")
	if len(events) != 1 || events[0].Stage != msgtrace.StageDelivery {
		t.Fatalf("expected exactly one delivery event for platform-1, got %+v", events)
	}
}

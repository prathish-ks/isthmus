package kernel

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"

	"github.com/prathish-ks/isthmus/go-host/internal/lifecycle"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
	msgtrace "github.com/prathish-ks/isthmus/go-host/internal/trace"
)

// Kernel holds everything one boundary instance needs: the mount policy
// Phase 5's validators run against, the live-session registry
// container.kill resolves names through, an optional session DB for
// SessionLookup, the Executor that performs the one physical exec path, and
// a bounded audit log. Construct with New; there is no exported zero value
// use — a Kernel with a nil executor would make CapabilityRequest panic
// rather than silently no-op, which is deliberate (see exec.go).
type Kernel struct {
	mountPolicy mount.Policy
	registry    *lifecycle.Registry
	db          *sql.DB
	executor    Executor
	tracer      *msgtrace.Store // P7-03; nil is a valid, common state — see recordTrace

	auditMu  sync.Mutex
	auditLog []auditEntry
}

// Option configures a Kernel at construction. Kept small and closed —
// there is deliberately no WithExecutor exported for production use beyond
// tests, since the real dockerExecutor is what New wires by default; see
// doc.go's non-capabilities section.
type Option func(*Kernel)

// WithSessionDB attaches a session database for SessionLookup. Omitting it
// leaves SessionLookup permanently denied (see session.go) rather than
// panicking — a kernel instance used only for CapabilityRequest/RouteRequest
// in a test or a narrower deployment doesn't need one.
func WithSessionDB(db *sql.DB) Option {
	return func(k *Kernel) { k.db = db }
}

// WithTracer attaches a P7-03 message-trace store: Dispatch records a
// best-effort event into it after route.request (keyed by MessageID, when
// the caller supplied one), session.lookup (keyed by the looked-up or
// resolved session id), container.wake/build_image/kill capability
// requests (keyed by session/agent-group id), and delivery.request (keyed
// by PlatformID). Omitting this option (the zero value, nil) leaves tracing
// off entirely — recordTrace no-ops on a nil tracer — since not every
// caller (in particular, every existing kernel_test.go case written before
// P7-03) needs or expects trace history to accumulate.
func WithTracer(store *msgtrace.Store) Option {
	return func(k *Kernel) { k.tracer = store }
}

// withExecutor is unexported: only this package's own tests construct a
// Kernel with a fake Executor. Production callers (cmd/nanogo) always get
// the real dockerExecutor from New.
func withExecutor(e Executor) Option {
	return func(k *Kernel) { k.executor = e }
}

// WithDockerNetwork sets the fixed, install-level Docker network every
// container.wake attaches to (EC-02, Phase 9) — mirroring
// drivers/index.ts's dockerNetworkArgs, injected once at driver
// construction, never per-request (see ADR-016). A no-op against a Kernel
// built with a non-default Executor (withExecutor, test-only), since only
// the real dockerExecutor reads this.
func WithDockerNetwork(name string) Option {
	return func(k *Kernel) {
		if de, ok := k.executor.(*dockerExecutor); ok {
			de.networkName = name
		}
	}
}

// New constructs a Kernel bound to policy, ready to serve all five
// primitives except SessionLookup (until WithSessionDB is supplied).
func New(policy mount.Policy, opts ...Option) *Kernel {
	k := &Kernel{
		mountPolicy: policy,
		registry:    lifecycle.NewRegistry(),
		executor:    newDockerExecutor(""),
	}
	for _, opt := range opts {
		opt(k)
	}
	return k
}

// Dispatch decodes payload against op's expected shape and runs it. This is
// the single function every transport (the Unix-socket Serve loop below, or
// a test calling Dispatch directly) goes through — there is no second path
// into any handler.
func (k *Kernel) Dispatch(ctx context.Context, env Envelope) ResponseEnvelope {
	if env.Version != ProtocolVersion {
		return errorResponse(env.RequestID, ErrUnsupportedVersion, fmt.Sprintf("kernel speaks %s, got %s", ProtocolVersion, env.Version))
	}

	switch env.Op {
	case OpRouteRequest:
		var req RouteRequestPayload
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return errorResponse(env.RequestID, ErrMalformedPayload, err.Error())
		}
		resp, errInfo := k.handleRouteRequest(req)
		k.recordTrace(req.MessageID, msgtrace.StageRoute, routeTraceSummary(resp, errInfo))
		return respond(env.RequestID, resp, errInfo)

	case OpSessionLookup:
		var req SessionLookupPayload
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return errorResponse(env.RequestID, ErrMalformedPayload, err.Error())
		}
		resp, errInfo := k.handleSessionLookup(req)
		k.recordTrace(sessionTraceKey(req, resp), msgtrace.StageSession, sessionTraceSummary(resp, errInfo))
		return respond(env.RequestID, resp, errInfo)

	case OpCapabilityRequest:
		var req CapabilityRequestPayload
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return errorResponse(env.RequestID, ErrMalformedPayload, err.Error())
		}
		resp, errInfo := k.handleCapabilityRequest(ctx, req)
		k.recordTrace(capabilityTraceKey(req), capabilityTraceStage(req.Capability), capabilityTraceSummary(resp, errInfo))
		return respond(env.RequestID, resp, errInfo)

	case OpDeliveryRequest:
		var req DeliveryRequestPayload
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			return errorResponse(env.RequestID, ErrMalformedPayload, err.Error())
		}
		resp := k.handleDeliveryRequest(req)
		k.recordTrace(req.PlatformID, msgtrace.StageDelivery, deliveryTraceSummary(resp))
		out, err := okResponse(env.RequestID, resp)
		if err != nil {
			return errorResponse(env.RequestID, ErrMalformedPayload, err.Error())
		}
		return out

	case OpStatusTrace:
		resp := k.handleStatusTrace()
		out, err := okResponse(env.RequestID, resp)
		if err != nil {
			return errorResponse(env.RequestID, ErrMalformedPayload, err.Error())
		}
		return out

	default:
		return errorResponse(env.RequestID, ErrUnknownOp, fmt.Sprintf("no such op: %q", env.Op))
	}
}

func respond(requestID string, payload any, errInfo *ErrorInfo) ResponseEnvelope {
	if errInfo != nil {
		return errorResponse(requestID, errInfo.Code, errInfo.Detail)
	}
	out, err := okResponse(requestID, payload)
	if err != nil {
		return errorResponse(requestID, ErrMalformedPayload, err.Error())
	}
	return out
}

// maxSocketPathLen is the smaller of the two POSIX sockaddr_un.sun_path
// limits this project's two real target platforms impose: 104 bytes on
// macOS/BSD, 108 on Linux. Found the hard way (P6-05): a test using
// t.TempDir()'s path verified clean in the Linux sandbox at 0.02s, then
// failed on the user's real Mac with connect: invalid argument — the exact
// same "sandbox alone cannot catch platform-dependent filesystem behavior"
// lesson Phase 5's symlink bug already taught, recurring in a new shape.
// Validating here, with a clear error, turns a cryptic OS errno into an
// actionable one — the same LAW-04 discipline mount.ValidationError's
// Kind/Detail split already applies to security denials.
const maxSocketPathLen = 104

// Serve listens on a Unix domain socket at socketPath and dispatches one
// newline-delimited JSON envelope per line, one response per line, until
// ctx is cancelled. socketPath is removed first if it already exists (a
// stale file from a prior crashed run) and created with 0600 permissions —
// see doc.go's non-capabilities section on why this, not TLS/a token, is
// the whole auth story: a single-user personal-agent host has exactly one
// legitimate local peer, and file permissions already exclude everyone else.
func (k *Kernel) Serve(ctx context.Context, socketPath string) error {
	if len(socketPath) > maxSocketPathLen {
		return fmt.Errorf("kernel: socket path %q is %d bytes, over the %d-byte portable limit (macOS sockaddr_un) — use a shorter path, e.g. under /tmp or a dedicated run directory", socketPath, len(socketPath), maxSocketPathLen)
	}
	_ = os.Remove(socketPath)
	ln, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("kernel: listen %s: %w", socketPath, err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = ln.Close()
		return fmt.Errorf("kernel: chmod %s: %w", socketPath, err)
	}
	defer func() { _ = ln.Close() }()

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return fmt.Errorf("kernel: accept: %w", err)
			}
		}
		go k.serveConn(ctx, conn)
	}
}

func (k *Kernel) serveConn(ctx context.Context, conn net.Conn) {
	defer func() { _ = conn.Close() }()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	enc := json.NewEncoder(conn)
	for scanner.Scan() {
		var env Envelope
		if err := json.Unmarshal(scanner.Bytes(), &env); err != nil {
			_ = enc.Encode(errorResponse("", ErrMalformedPayload, err.Error()))
			continue
		}
		resp := k.Dispatch(ctx, env)
		if err := enc.Encode(resp); err != nil {
			return
		}
	}
}

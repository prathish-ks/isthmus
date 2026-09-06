package kernel

import (
	"context"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/prathish-ks/isthmus/go-host/internal/containerdefaults"
	"github.com/prathish-ks/isthmus/go-host/internal/guardpolicy"
	"github.com/prathish-ks/isthmus/go-host/internal/lifecycle"
	"github.com/prathish-ks/isthmus/go-host/internal/mount"
	"github.com/prathish-ks/isthmus/go-host/internal/ownership"
)

// Capability is the closed set of privileged operations this boundary will
// ever execute. There is no fourth value and no way to request an operation
// outside this set — see doc.go's non-capabilities list.
type Capability string

const (
	// CapabilityContainerWake starts or resumes a session's container.
	CapabilityContainerWake Capability = "container.wake"
	// CapabilityContainerBuildImage builds a session's container image.
	CapabilityContainerBuildImage Capability = "container.build_image"
	// CapabilityContainerKill stops a session's container.
	CapabilityContainerKill Capability = "container.kill"
)

// restartCommand is the real `restart` CommandDef (src/cli/resources/groups.ts),
// ported as a constant guardpolicy.CommandSpec — see
// EC-04-guard-scope-design-notes.md's confirmation that this is the only
// CLI command in the guard catalog that reaches a kernel capability, so it
// is the only one this boundary needs a CommandSpec for.
var restartCommand = guardpolicy.CommandSpec{Name: "restart", Access: guardpolicy.AccessApproval, Resource: "groups"}

// CapabilityRequestPayload is CapabilityRequest's typed payload. Which
// fields matter depends on Capability; unused fields for a given capability
// are ignored, never treated as an alternate way to reach the exec (e.g. a
// wake request's Dockerfile field, if somehow set, is never read).
type CapabilityRequestPayload struct {
	Capability Capability `json:"capability"`

	// container.wake: the fully TS-composed spec, validated verbatim by
	// mount.ValidateSpec/containerdefaults — this package never adds,
	// removes, or rewrites a mount or an env entry.
	Session      *mount.Session               `json:"session,omitempty"`
	RunAs        *containerdefaults.RunAs     `json:"runAs,omitempty"`
	Resources    *containerdefaults.Resources `json:"resources,omitempty"`
	Capabilities *mount.Capabilities          `json:"capabilities,omitempty"`

	// container.build_image: only a tag and Dockerfile body — the build
	// context directory is derived by the kernel from GroupDir, never taken
	// from the caller (see resolveBuildContext).
	AgentGroupID string `json:"agentGroupId,omitempty"`
	GroupFolder  string `json:"groupFolder,omitempty"`
	ImageTag     string `json:"imageTag,omitempty"`
	Dockerfile   string `json:"dockerfile,omitempty"`

	// container.kill: identity only. The kernel resolves the actual
	// container name (and, EC-02, the real stop-grace period) from its own
	// registry — see handleKill.
	SessionID string `json:"sessionId,omitempty"`
	Reason    string `json:"reason,omitempty"`

	// Guard (EC-02/EC-04, Phase 9) is populated only by TypeScript's guarded
	// call sites — the CLI `restart` command's dispatch (container.wake,
	// container.kill) and self-mod's install_packages flow
	// (container.build_image). See guard_context.go and ADR-015/ADR-016.
	Guard *GuardContext `json:"guard,omitempty"`
}

// CapabilityResponsePayload is what a successful dispatch returns. Allowed
// is always present; the rest are populated only for the capability that
// produced them.
type CapabilityResponsePayload struct {
	Allowed bool `json:"allowed"`
	// ContainerID and ContainerName are populated on a successful
	// container.wake. ContainerName (EC-02) is the identity the kernel
	// itself derived and created under (see ContainerName in naming.go) —
	// callers use this, never a name they computed themselves, for any
	// subsequent inspection/attach/supervision step.
	ContainerID   string `json:"containerId,omitempty"`
	ContainerName string `json:"containerName,omitempty"`
	ImageID       string `json:"imageId,omitempty"`
}

// legalTagFragment mirrors mount.LabelValueLegal's character class (used
// here for the image tag, a docker-imposed constraint distinct from but as
// strict as the group-folder label rule), extended with one optional
// `:tag` suffix of the same charset.
//
// Found while tracing the real TS caller (container-runner.ts's
// buildAgentGroupImage, self-mod's only route to container.build_image):
// its ImageTag is always a full docker reference, `${CONTAINER_IMAGE_BASE}
// :${agentGroupId}` (e.g. "nanoclaw-agent-v2-ab12cd34:group-xyz") — passed
// verbatim to `docker build -t <imageTag>` by dockerExecutor.BuildImage. A
// bare single-fragment regex (no colon permitted) would reject every real
// call this capability will ever receive, since a bare repo name with no
// tag is not the naming scheme any caller actually uses — this was a wire
// contract gap, not a caller bug, so the validation is widened to match
// what the field doc comment already says the field is: "a tag" in the
// docker-reference sense, not a single fragment. Still exactly as strict
// per side: each half must independently pass the same charset a driver
// realizes labels with, so nothing beyond a legal repo:tag pair is ever
// accepted.
var legalTagFragment = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}(:[a-z0-9][a-z0-9._-]{0,127})?$`)

// handleCapabilityRequest is the enforcement seam itself: validate against
// Phase 5's packages, and only on a pass, call exec. A denial NEVER reaches
// exec — every branch below either returns before constructing a
// DockerExecutor call, or the call itself is unreachable code with no
// caller. This shape (not "call exec and let it also check") is deliberate:
// a caller cannot get a partially-checked path by racing or malforming a
// field, because exec.go's methods take only the narrow, already-validated
// arguments this function passes them — never the raw request.
func (k *Kernel) handleCapabilityRequest(ctx context.Context, req CapabilityRequestPayload) (CapabilityResponsePayload, *ErrorInfo) {
	switch req.Capability {
	case CapabilityContainerWake:
		return k.handleWake(ctx, req)
	case CapabilityContainerBuildImage:
		return k.handleBuildImage(ctx, req)
	case CapabilityContainerKill:
		return k.handleKill(ctx, req)
	default:
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrUnknownCapability, Detail: fmt.Sprintf("no such capability: %q", req.Capability)}
	}
}

// checkCLIRestartGuard evaluates internal/guardpolicy for a
// CLIRestartGuardContext, when present. It returns (true, nil) when the
// request may proceed (no guard context at all, or the guard allows/is
// satisfied by a grant), and (false, *ErrorInfo) when it must be denied —
// including when a guard context was presented but this kernel has no
// session DB wired (WithSessionDB), since cli_scope/approval state cannot
// be independently verified without it and this boundary fails closed
// rather than executing ungated (see ADR-015).
func (k *Kernel) checkCLIRestartGuard(ctx context.Context, guard *GuardContext) (bool, *ErrorInfo) {
	if guard == nil || guard.CLIRestart == nil {
		return true, nil
	}
	if k.db == nil {
		return false, &ErrorInfo{Code: ErrDenied, Detail: "guarded request but no session DB is wired — cli_scope/approval state cannot be verified"}
	}
	g := guard.CLIRestart
	actor := guardpolicy.Actor{Kind: guardpolicy.ActorKind(g.ActorKind), AgentGroupID: g.AgentGroupID}
	var grant *guardpolicy.Grant
	if g.Grant != nil {
		grant = &guardpolicy.Grant{ApprovalID: g.Grant.ApprovalID, Action: g.Grant.Action}
	}
	decision, err := guardpolicy.EvaluateWithGrant(ctx,
		guardpolicy.SQLCLIScopeLookup{DB: k.db},
		guardpolicy.SQLApprovalLookup{DB: k.db},
		restartCommand, actor, g.Args, grant)
	if err != nil {
		return false, &ErrorInfo{Code: ErrDenied, Detail: fmt.Sprintf("guard evaluation failed (failing closed): %v", err)}
	}
	if decision.Effect != "allow" {
		return false, &ErrorInfo{Code: ErrDenied, Detail: decision.Reason}
	}
	return true, nil
}

// dockerRuntimeCapabilities always reports imageBuild: true — the kernel's
// only executor is Docker-backed (dockerExecutor), so from the kernel's own
// perspective this is a known fact, not something to trust a caller's claim
// about (see guardpolicy.RuntimeCapabilities's own doc comment: "never a
// caller-supplied claim about its own capabilities").
type dockerRuntimeCapabilities struct{}

func (dockerRuntimeCapabilities) ImageBuildSupported(context.Context) (bool, error) { return true, nil }

func (k *Kernel) checkSelfModGuard(ctx context.Context, guard *GuardContext) (bool, *ErrorInfo) {
	if guard == nil || guard.SelfMod == nil {
		return true, nil
	}
	if k.db == nil {
		return false, &ErrorInfo{Code: ErrDenied, Detail: "guarded request but no session DB is wired — approval state cannot be verified"}
	}
	g := guard.SelfMod
	actor := guardpolicy.Actor{Kind: guardpolicy.ActorKind(g.ActorKind)}
	action := guardpolicy.SelfModAction(g.Action)
	var grant *guardpolicy.Grant
	if g.Grant != nil {
		grant = &guardpolicy.Grant{ApprovalID: g.Grant.ApprovalID, Action: g.Grant.Action}
	}
	decision, err := guardpolicy.EvaluateSelfModWithGrant(ctx, dockerRuntimeCapabilities{}, guardpolicy.SQLApprovalLookup{DB: k.db}, action, actor, grant)
	if err != nil {
		return false, &ErrorInfo{Code: ErrDenied, Detail: fmt.Sprintf("guard evaluation failed (failing closed): %v", err)}
	}
	if decision.Effect != "allow" {
		return false, &ErrorInfo{Code: ErrDenied, Detail: decision.Reason}
	}
	return true, nil
}

func (k *Kernel) handleWake(ctx context.Context, req CapabilityRequestPayload) (CapabilityResponsePayload, *ErrorInfo) {
	if ok, denial := k.checkCLIRestartGuard(ctx, req.Guard); !ok {
		return CapabilityResponsePayload{}, denial
	}
	if req.Session == nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrSpecInvalid, Detail: "container.wake requires session"}
	}
	if err := mount.ValidateSpec(*req.Session, k.mountPolicy, req.Capabilities); err != nil {
		return CapabilityResponsePayload{}, denialFromMountError(err)
	}
	runAs := containerdefaults.RunAs{}
	if req.RunAs != nil {
		runAs = *req.RunAs
	}
	if err := containerdefaults.ValidateRunAs(runAs); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}
	resources := containerdefaults.Resources{}
	if req.Resources != nil {
		resources = *req.Resources
	}
	if err := containerdefaults.EnforceSafeDefaults(runAs, resources); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}
	if err := ownership.ValidateID(req.Session.Key.AgentGroupID, "agentGroupId"); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}
	if err := ownership.ValidateID(req.Session.Key.SessionID, "sessionId"); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}

	containerID, containerName, err := k.executor.Wake(ctx, *req.Session, runAs, resources)
	if err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrExecFailed, Detail: err.Error()}
	}
	rt := lifecycle.NewRuntime(containerName, time.Now().UnixMilli(), false)
	rt.SetStopGraceSeconds(req.Session.StopGraceSeconds)
	k.registry.Register(req.Session.Key.SessionID, rt)
	k.audit(auditEntry{capability: CapabilityContainerWake, sessionID: req.Session.Key.SessionID, allowed: true})
	return CapabilityResponsePayload{Allowed: true, ContainerID: containerID, ContainerName: containerName}, nil
}

func (k *Kernel) handleBuildImage(ctx context.Context, req CapabilityRequestPayload) (CapabilityResponsePayload, *ErrorInfo) {
	if ok, denial := k.checkSelfModGuard(ctx, req.Guard); !ok {
		return CapabilityResponsePayload{}, denial
	}
	if err := ownership.ValidateID(req.AgentGroupID, "agentGroupId"); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}
	if !mount.LabelValueLegal(req.GroupFolder) {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: fmt.Sprintf("group folder %q is not a legal label value", req.GroupFolder)}
	}
	if !legalTagFragment.MatchString(req.ImageTag) {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: fmt.Sprintf("image tag %q does not match the required pattern", req.ImageTag)}
	}
	if strings.TrimSpace(req.Dockerfile) == "" {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrSpecInvalid, Detail: "dockerfile is empty"}
	}
	// The build context is derived from the group's own directory under this
	// policy's GroupsRoot — never taken from the caller. This is the field
	// doc.go's non-capabilities section refers to: there is no
	// "buildContextDir" input at all.
	contextDir := filepath.Join(k.mountPolicy.GroupsRoot, req.GroupFolder)

	imageID, err := k.executor.BuildImage(ctx, contextDir, req.ImageTag, req.Dockerfile)
	if err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrExecFailed, Detail: err.Error()}
	}
	k.audit(auditEntry{capability: CapabilityContainerBuildImage, sessionID: req.AgentGroupID, allowed: true})
	return CapabilityResponsePayload{Allowed: true, ImageID: imageID}, nil
}

func (k *Kernel) handleKill(ctx context.Context, req CapabilityRequestPayload) (CapabilityResponsePayload, *ErrorInfo) {
	if ok, denial := k.checkCLIRestartGuard(ctx, req.Guard); !ok {
		return CapabilityResponsePayload{}, denial
	}
	if err := ownership.ValidateID(req.SessionID, "sessionId"); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
	}
	rt, ok := k.registry.Get(req.SessionID)
	if !ok {
		// The non-capability this enforces: there is no field a caller can
		// set to name an arbitrary container. Only a session this kernel
		// itself spawned (and still has a live registry entry for) can be
		// killed.
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrUnknownSession, Detail: fmt.Sprintf("no running session %q known to this kernel", req.SessionID)}
	}
	// Grace seconds come from the kernel's own registry — recorded at wake
	// time from the validated spec — never re-asserted by the caller at
	// kill time (EC-02; see lifecycle.Runtime.StopGraceSeconds).
	if err := k.executor.Kill(ctx, rt.ContainerName, rt.StopGraceSeconds()); err != nil {
		return CapabilityResponsePayload{}, &ErrorInfo{Code: ErrExecFailed, Detail: err.Error()}
	}
	rt.SetStopReason(req.Reason)
	if rt.MarkFinished() {
		k.registry.Unregister(req.SessionID, rt)
	}
	k.audit(auditEntry{capability: CapabilityContainerKill, sessionID: req.SessionID, allowed: true})
	return CapabilityResponsePayload{Allowed: true}, nil
}

func denialFromMountError(err error) *ErrorInfo {
	if verr, ok := err.(*mount.ValidationError); ok {
		code := ErrDenied
		if verr.Kind == "spec-invalid" {
			code = ErrSpecInvalid
		}
		return &ErrorInfo{Code: code, Detail: verr.Detail}
	}
	return &ErrorInfo{Code: ErrDenied, Detail: err.Error()}
}

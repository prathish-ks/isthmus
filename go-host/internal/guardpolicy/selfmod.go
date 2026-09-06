package guardpolicy

import (
	"context"
	"fmt"
)

// SelfModAction names which self-mod gate to evaluate — the two catalog
// actions src/modules/self-mod/guard.ts defines.
type SelfModAction string

// The two self-mod catalog actions src/modules/self-mod/guard.ts gates.
const (
	SelfModInstallPackages SelfModAction = "self_mod.install_packages"
	SelfModAddMCPServer    SelfModAction = "self_mod.add_mcp_server"
)

// RuntimeCapabilities independently confirms what the active session
// runtime can do, read from the runtime itself — mirroring
// getSessionDriver().capabilities() in src/modules/self-mod/guard.ts, never
// a caller-supplied claim about its own capabilities.
type RuntimeCapabilities interface {
	// ImageBuildSupported reports whether the active driver declares the
	// imageBuild capability (containerdefaults' Go equivalent of the
	// driver capability flag install_packages gates on).
	ImageBuildSupported(ctx context.Context) (bool, error)
}

// DecideSelfMod is the Go port of src/modules/self-mod/guard.ts's two
// catalog entries. Both deny any non-agent caller outright (self-mod is a
// container-originated action only); install_packages additionally denies
// — before ever considering a hold — when the active runtime does not
// declare imageBuild, "so an admin is never asked to approve something that
// cannot happen" (the source comment this ports verbatim). Neither entry
// ever allows outright: from the container path, self-modification always
// requires admin approval when it is possible at all.
func DecideSelfMod(ctx context.Context, caps RuntimeCapabilities, action SelfModAction, actor Actor) (Decision, error) {
	label := string(action)
	switch action {
	case SelfModInstallPackages:
		label = "install_packages"
	case SelfModAddMCPServer:
		label = "add_mcp_server"
	}

	if actor.Kind != ActorAgent {
		return deny(fmt.Sprintf("%s is a container-originated action.", label)), nil
	}

	if action == SelfModInstallPackages {
		supported, err := caps.ImageBuildSupported(ctx)
		if err != nil {
			return Decision{}, fmt.Errorf("guardpolicy: checking imageBuild capability: %w", err)
		}
		if !supported {
			return deny("install_packages needs an image rebuild and the session runtime does not declare the 'imageBuild' " +
				"capability — packages cannot be installed on this runtime (image changes are built and imported out of band)"), nil
		}
	}

	return hold(fmt.Sprintf("%s always requires admin approval from the container path", label)), nil
}

// selfModGrantAction maps a SelfModAction to the pending_approvals.action
// value a satisfying grant must carry — src/modules/self-mod/guard.ts's own
// grantActionName ('install_packages'/'add_mcp_server'), distinct from the
// dotted catalog action name (SelfModAction itself).
func selfModGrantAction(action SelfModAction) string {
	switch action {
	case SelfModInstallPackages:
		return "install_packages"
	case SelfModAddMCPServer:
		return "add_mcp_server"
	default:
		return ""
	}
}

// EvaluateSelfModWithGrant is the Go port of guard()'s wrapper as applied to
// the self-mod catalog entries: run DecideSelfMod, and — only when that
// decision is a hold AND a grant was presented — independently re-confirm
// the grant is live and names the right action, by reading the
// pending_approvals row itself. Unlike the CLI-restart guard's
// EvaluateWithGrant, self-mod's real grantCoversRequest is unset in
// src/modules/self-mod/guard.ts (no per-request payload binding beyond the
// action name), so any live row with a matching action satisfies — mirrored
// here exactly, not tightened.
func EvaluateSelfModWithGrant(ctx context.Context, caps RuntimeCapabilities, approvals ApprovalLookup, action SelfModAction, actor Actor, grant *Grant) (Decision, error) {
	decision, err := DecideSelfMod(ctx, caps, action, actor)
	if err != nil {
		return Decision{}, err
	}
	if grant == nil || decision.Effect != "hold" {
		return decision, nil
	}
	expected := selfModGrantAction(action)
	if expected == "" || grant.Action != expected {
		return deny("replay carried an invalid or mismatched grant"), nil
	}
	liveAction, _, ok, err := approvals.PendingApproval(ctx, grant.ApprovalID)
	if err != nil {
		return Decision{}, fmt.Errorf("guardpolicy: resolving pending approval %q: %w", grant.ApprovalID, err)
	}
	if !ok || liveAction != expected {
		return deny("replay carried an invalid or mismatched grant"), nil
	}
	return allow(fmt.Sprintf("hold satisfied by approval %s", grant.ApprovalID)), nil
}

package guardpolicy

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// ActorKind mirrors src/guard/types.ts's GuardActor discriminant.
type ActorKind string

// The four actor kinds src/guard/types.ts's GuardActor discriminates on.
const (
	ActorHost   ActorKind = "host"
	ActorAgent  ActorKind = "agent"
	ActorHuman  ActorKind = "human"
	ActorSystem ActorKind = "system"
)

// Actor mirrors GuardActor. AgentGroupID is set only for ActorAgent.
type Actor struct {
	Kind         ActorKind
	AgentGroupID string
}

// Access mirrors src/cli/registry.ts's Access ('open' | 'approval' | 'hidden').
type Access string

// The three access levels src/cli/registry.ts's CommandDef.access can take.
const (
	AccessOpen     Access = "open"
	AccessApproval Access = "approval"
	AccessHidden   Access = "hidden"
)

// CommandSpec mirrors the fields of src/cli/registry.ts's CommandDef that
// commandDecide actually reads.
type CommandSpec struct {
	Name     string
	Resource string // "" means no resource (exempt from the group-scope allowlist)
	HostOnly bool
	Access   Access
}

// Decision mirrors src/guard/types.ts's GuardDecision.
type Decision struct {
	Effect string // "allow" | "hold" | "deny"
	Reason string
}

func allow(reason string) Decision { return Decision{Effect: "allow", Reason: reason} }
func deny(reason string) Decision  { return Decision{Effect: "deny", Reason: reason} }
func hold(reason string) Decision  { return Decision{Effect: "hold", Reason: reason} }

// Catalog constants ported verbatim from src/cli/registry.ts and
// src/cli/guard.ts.
var groupScopeResources = map[string]bool{
	"groups":       true,
	"sessions":     true,
	"destinations": true,
	"members":      true,
	"tasks":        true,
}

var groupWiringCommands = map[string]bool{
	"wirings-get":    true,
	"wirings-update": true,
}

var groupWiringUpdateArgs = map[string]bool{
	"id":             true,
	"agent_group_id": true,
	"group":          true,
	"help":           true,
	"engage_mode":    true,
	"engage_pattern": true,
}

// CLIScopeLookup resolves the live cli_scope for an agent group, read by
// the kernel from its own database connection — never a caller-supplied
// value. Mirrors src/db/container-configs.ts's getContainerConfig, narrowed
// to the one column commandDecide reads. An absent row's effective scope is
// "group" (the container_configs.cli_scope column's own DEFAULT, migration
// 015) — implementations should return "" (or "group") for that case, not
// an error.
type CLIScopeLookup interface {
	CLIScope(ctx context.Context, agentGroupID string) (string, error)
}

// Grant is what a replay claims was already approved — mirrors the shape of
// input.grant in src/guard/types.ts's GuardInput, narrowed to the fields
// grantSatisfies actually reads.
type Grant struct {
	ApprovalID string
	Action     string // must equal "cli_command" for a restart-guard grant
}

// ApprovalLookup independently confirms a claimed grant is still live and
// matches, by reading the pending_approvals row itself — never trusting a
// caller-asserted "already approved" boolean. Mirrors
// src/guard/guard.ts's grantSatisfies, which re-fetches
// getPendingApproval(grant.approval_id) rather than trusting the grant
// object's own fields, because resolution DELETES the row: a grant
// referencing an already-resolved (or fabricated) approval must not pass.
type ApprovalLookup interface {
	// PendingApproval returns the live row's action and payload JSON, or
	// ok=false if no such row exists (already resolved, expired, or never
	// existed).
	PendingApproval(ctx context.Context, approvalID string) (action string, payloadJSON string, ok bool, err error)
}

// DecideRestartLike is the Go port of src/cli/guard.ts's commandDecide,
// generic over any CommandSpec exactly as the TypeScript original is
// generic over any CommandDef — in production this is only ever consulted
// for the real `restart` command (resource: "groups", access: "approval",
// hostOnly: false), but the generic form is what lets this package's tests
// reproduce all 12 golden fixtures from fixtures-guard-catalog.test.ts
// verbatim, several of which exercise synthetic CommandDefs other than
// restart to isolate individual branches.
//
// args is the request's arguments (GuardInput.payload in the TypeScript
// original) — string-keyed, matching how CLI args arrive; a non-string arg
// value that would matter to a check below (there are none today) would
// need this signature to widen.
func DecideRestartLike(ctx context.Context, scopes CLIScopeLookup, cmd CommandSpec, actor Actor, args map[string]string) (Decision, error) {
	if actor.Kind == ActorHost {
		return allow("host caller (trusted socket)"), nil
	}
	if actor.Kind != ActorAgent {
		return deny("CLI commands accept host or agent callers only."), nil
	}

	// Host-only commands are operator-only: rejected for ANY container
	// caller, regardless of cli_scope (even "global") or approval.
	if cmd.HostOnly {
		return deny(fmt.Sprintf("%q is operator-only and cannot be run from inside a container.", cmd.Name)), nil
	}

	cliScope, err := scopes.CLIScope(ctx, actor.AgentGroupID)
	if err != nil {
		return Decision{}, fmt.Errorf("guardpolicy: resolving cli_scope for %q: %w", actor.AgentGroupID, err)
	}
	if cliScope == "" {
		cliScope = "group"
	}

	if cliScope == "disabled" {
		return deny("CLI access is disabled for this agent group."), nil
	}

	if cliScope == "group" {
		groupWiringCommand := cmd.Resource == "wirings" && groupWiringCommands[cmd.Name]

		if cmd.Resource != "" && !groupScopeResources[cmd.Resource] && !groupWiringCommand {
			return deny(fmt.Sprintf("CLI access is scoped to this agent group. Cannot access %q.", cmd.Resource)), nil
		}

		for _, key := range [...]string{"agent_group_id", "group"} {
			if v, present := args[key]; present && v != "" && v != actor.AgentGroupID {
				return deny("CLI access is scoped to this agent group."), nil
			}
		}
		if cmd.Resource == "groups" || cmd.Resource == "destinations" {
			if v, present := args["id"]; present && v != "" && v != actor.AgentGroupID {
				return deny("CLI access is scoped to this agent group."), nil
			}
		}

		if groupWiringCommand && cmd.Name == "wirings-update" {
			for key := range args {
				normalized := strings.ReplaceAll(key, "-", "_")
				if !groupWiringUpdateArgs[normalized] {
					return deny("Group-scoped wiring updates may only change engage_mode or engage_pattern."), nil
				}
			}
		}

		if _, present := args["cli_scope"]; present {
			return deny("Cannot change cli_scope from a group-scoped agent."), nil
		}
		if _, present := args["cli-scope"]; present {
			return deny("Cannot change cli_scope from a group-scoped agent."), nil
		}
	}

	if cmd.Access == AccessApproval {
		return hold(fmt.Sprintf("agent-initiated %q requires admin approval", cmd.Name)), nil
	}
	return allow("open command"), nil
}

// grantPayload is the shape grantSatisfies parses out of a pending_approvals
// row's payload column for a cli_command grant (src/cli/guard.ts's
// commandGuardSpec: `payload.frame?.command`).
type grantPayload struct {
	Frame struct {
		Command string `json:"command"`
	} `json:"frame"`
}

const cliCommandGrantAction = "cli_command"

// EvaluateWithGrant is the Go port of src/guard/guard.ts's guard() wrapper
// as applied to the restart-like catalog entry: it runs DecideRestartLike,
// then — only when that decision is a hold AND a grant was presented —
// independently re-confirms the grant is live and names this exact command,
// by reading the pending_approvals row itself (never trusting the caller's
// claim that the grant is valid). A grant never loosens a deny (the checks
// above already re-ran live), matching guard()'s own comment: "approve-then-
// revoke no longer executes."
func EvaluateWithGrant(ctx context.Context, scopes CLIScopeLookup, approvals ApprovalLookup, cmd CommandSpec, actor Actor, args map[string]string, grant *Grant) (Decision, error) {
	decision, err := DecideRestartLike(ctx, scopes, cmd, actor, args)
	if err != nil {
		return Decision{}, err
	}
	if grant == nil || decision.Effect != "hold" {
		return decision, nil
	}
	satisfied, err := grantSatisfies(ctx, approvals, cmd, grant)
	if err != nil {
		return Decision{}, err
	}
	if satisfied {
		return allow(fmt.Sprintf("hold satisfied by approval %s", grant.ApprovalID)), nil
	}
	return deny("replay carried an invalid or mismatched grant"), nil
}

func grantSatisfies(ctx context.Context, approvals ApprovalLookup, cmd CommandSpec, grant *Grant) (bool, error) {
	if grant.Action != cliCommandGrantAction {
		return false, nil
	}
	liveAction, livePayloadJSON, ok, err := approvals.PendingApproval(ctx, grant.ApprovalID)
	if err != nil {
		return false, fmt.Errorf("guardpolicy: resolving pending approval %q: %w", grant.ApprovalID, err)
	}
	if !ok || liveAction != cliCommandGrantAction {
		return false, nil
	}
	var payload grantPayload
	if err := json.Unmarshal([]byte(livePayloadJSON), &payload); err != nil {
		// A malformed payload fails closed, exactly like commandGuardSpec's
		// grantCoversRequest catching JSON.parse and returning false.
		return false, nil
	}
	return payload.Frame.Command == cmd.Name, nil
}

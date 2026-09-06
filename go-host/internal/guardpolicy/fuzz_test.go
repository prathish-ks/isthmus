package guardpolicy

// P9-02 (Phase 9/10 hardening): fuzz target #4 of 5 — DB-record-shaped
// capability inputs. DecideRestartLike's own doc comment is explicit about
// what makes it different from a decision mirror: cliScope is "read by the
// kernel from its own database connection — never a caller-supplied value."
// That still means an arbitrary string can reach it, just one hop removed
// (a corrupted or hand-edited container_configs.cli_scope row, rather than
// a forged request field). This fuzzer feeds DecideRestartLike a fuzzed
// cliScope value (via a fake CLIScopeLookup, standing in for a malformed DB
// row) alongside fuzzed actor/command/arg shapes, and asserts the one
// invariant that must hold for literally any input: a Decision with a
// nonsense Effect must never come back, and the function must never panic.
// It complements policy_test.go's 13 golden fixtures (which pin specific,
// meaningful scenarios) with breadth over garbage the fixtures don't
// enumerate.

import (
	"context"
	"testing"
)

type fuzzScopeLookup struct{ scope string }

func (l fuzzScopeLookup) CLIScope(ctx context.Context, agentGroupID string) (string, error) {
	return l.scope, nil
}

func FuzzDecideRestartLike(f *testing.F) {
	f.Add("group", "agent", "ag-1", "groups", false, "approval", "id", "other-group")
	f.Add("", "host", "", "groups", false, "approval", "", "")
	f.Add("bogus-scope-value", "agent", "ag-1", "groups", true, "hidden", "cli_scope", "anything")
	f.Add("all", "human", "", "", false, "open", "", "")
	f.Add("group\x00trailing-nul", "agent", "ag-1\n", "groups", false, "approval", "agent_group_id", "ag-2")

	f.Fuzz(func(t *testing.T, cliScope, actorKindRaw, agentGroupID, resource string, hostOnly bool, accessRaw, argKey, argVal string) {
		actorKind := ActorHost
		switch actorKindRaw {
		case "agent":
			actorKind = ActorAgent
		case "human":
			actorKind = ActorHuman
		case "system":
			actorKind = ActorSystem
		}
		access := AccessOpen
		switch accessRaw {
		case "approval":
			access = AccessApproval
		case "hidden":
			access = AccessHidden
		}

		cmd := CommandSpec{Name: "restart", Resource: resource, HostOnly: hostOnly, Access: access}
		actor := Actor{Kind: actorKind, AgentGroupID: agentGroupID}
		args := map[string]string{}
		if argKey != "" {
			args[argKey] = argVal
		}

		decision, err := DecideRestartLike(context.Background(), fuzzScopeLookup{scope: cliScope}, cmd, actor, args)
		if err != nil {
			return // an error is always an acceptable outcome for garbage input
		}
		switch decision.Effect {
		case "allow", "deny", "hold":
			// valid
		default:
			t.Fatalf("DecideRestartLike returned an unrecognized Effect %q for cliScope=%q actor=%+v cmd=%+v args=%v",
				decision.Effect, cliScope, actor, cmd, args)
		}
	})
}

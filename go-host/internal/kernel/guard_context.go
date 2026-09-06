package kernel

// GuardContext carries what internal/guardpolicy (ADR-015) needs to
// independently evaluate the narrow EC-04 guard slice for a capability
// request that originated from a guarded TypeScript call site — the CLI
// `restart` command (container.wake/container.kill) or the self-mod
// install_packages flow (container.build_image). Absent (nil) for every
// other caller: an ordinary lifecycle wake/kill/build that never went
// through a guard in TypeScript is not newly gated by EC-02/EC-04 either —
// only the path that already had a guard to bypass gets one here.
//
// Exactly one of CLIRestart/SelfMod is set, matching which capability the
// request names (container.wake/container.kill carry CLIRestart;
// container.build_image carries SelfMod). handleCapabilityRequest ignores
// the wrong one for a given capability rather than erroring on it, the same
// "unused fields are ignored, never an alternate path" discipline
// CapabilityRequestPayload's own doc comment states.
type GuardContext struct {
	CLIRestart *CLIRestartGuardContext `json:"cliRestart,omitempty"`
	SelfMod    *SelfModGuardContext    `json:"selfMod,omitempty"`
}

// CLIRestartGuardContext mirrors the GuardInput src/cli/guard.ts's
// commandDecide consults for the real `restart` command — everything
// except cli_scope and grant liveness, which the kernel reads itself from
// the shared central DB (SQLCLIScopeLookup/SQLApprovalLookup) rather than
// trusting a caller-supplied claim.
type CLIRestartGuardContext struct {
	// ActorKind is one of guardpolicy's ActorKind values ("host", "agent",
	// "human", "system") — asserted by the TypeScript host process, which is
	// the sole terminus of every per-container connection in v1 (see
	// ADR-015's "what is not independently verified" section: this
	// assertion itself is the accepted v1 trust limit).
	ActorKind string `json:"actorKind"`
	// AgentGroupID is set only when ActorKind is "agent".
	AgentGroupID string `json:"agentGroupId,omitempty"`
	// Args are the restart command's own CLI arguments (e.g. "id",
	// "agent_group_id", "cli_scope") — read-only inputs to
	// guardpolicy.DecideRestartLike's cross-group and mutation checks.
	Args map[string]string `json:"args,omitempty"`
	// Grant carries a replay's claimed approval, if any. The kernel
	// independently re-verifies it is still live and names this exact
	// command via ApprovalLookup — never trusting that the grant is valid
	// merely because the caller sent one (see guardpolicy.EvaluateWithGrant).
	Grant *GuardGrant `json:"grant,omitempty"`
}

// SelfModGuardContext mirrors self-mod's install_packages/add_mcp_server
// gate. Only install_packages ever reaches container.build_image (an
// add_mcp_server hold never rebuilds an image), so Action is expected to
// always be "install_packages" here — carried explicitly anyway so a future
// guarded build-triggering action doesn't silently reuse this struct
// incorrectly.
//
// Grant carries the replay's approval — src/modules/self-mod/apply.ts's
// applyInstallPackages runs only after runGuarded's own guard() call has
// already resolved "allow" via a grant satisfying self-mod's unconditional
// per-agent hold (DecideSelfMod never allows an agent outright), so by
// construction this call site always has a live approval id in hand. The
// kernel re-verifies it independently here exactly as ADR-015 does for the
// CLI-restart path — without this field EvaluateSelfModWithGrant is always
// called with grant=nil, which can never satisfy an agent-actor hold, so a
// guarded container.build_image request would always be denied.
type SelfModGuardContext struct {
	ActorKind string      `json:"actorKind"`
	Action    string      `json:"action"`
	Grant     *GuardGrant `json:"grant,omitempty"`
}

// GuardGrant mirrors guardpolicy.Grant.
type GuardGrant struct {
	ApprovalID string `json:"approvalId"`
	Action     string `json:"action"`
}

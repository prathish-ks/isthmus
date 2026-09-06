package kernel

import (
	"database/sql"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

// withGuardTables adds container_configs and pending_approvals to a test DB
// already opened via testDB — the same minimal-columns discipline
// internal/guardpolicy's own tests use (see guardpolicy's doc.go: this
// package never asserts ownership of tables TypeScript's migrations
// create).
func withGuardTables(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
		CREATE TABLE container_configs (
			agent_group_id TEXT PRIMARY KEY,
			cli_scope      TEXT NOT NULL DEFAULT 'group'
		);
		CREATE TABLE pending_approvals (
			approval_id TEXT PRIMARY KEY,
			action      TEXT NOT NULL,
			payload     TEXT NOT NULL
		);
	`); err != nil {
		t.Fatalf("creating guard tables: %v", err)
	}
}

func TestCapabilityRequest_Wake_NoGuardContext_ExecutesUngatedAsBefore(t *testing.T) {
	// An ordinary lifecycle wake (no CLI restart involved) carries no Guard
	// field at all — this must behave exactly as it did before EC-02/EC-04,
	// even with no session DB wired.
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
	})
	if !resp.OK {
		t.Fatalf("expected an ungated wake to succeed, got %+v", resp)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected exactly one Wake call, got %d", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_GuardedButNoSessionDB_DeniedFailClosed(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec)) // no WithSessionDB
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
		Guard: &GuardContext{CLIRestart: &CLIRestartGuardContext{
			ActorKind:    "agent",
			AgentGroupID: "ag-1",
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: a guarded request with no session DB cannot verify cli_scope/approval state")
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("expected exec never reached, got %d wake calls", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_HostActorAlwaysAllowed(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
		Guard:      &GuardContext{CLIRestart: &CLIRestartGuardContext{ActorKind: "host"}},
	})
	if !resp.OK {
		t.Fatalf("expected a host-actor guarded wake to succeed, got %+v", resp)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected exactly one Wake call, got %d", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_AgentActorScopeDisabled_Denied(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	if _, err := db.Exec(`INSERT INTO container_configs (agent_group_id, cli_scope) VALUES ('ag-1', 'disabled')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
		Guard: &GuardContext{CLIRestart: &CLIRestartGuardContext{
			ActorKind:    "agent",
			AgentGroupID: "ag-1",
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: cli_scope=disabled for this agent group")
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("expected exec never reached, got %d wake calls", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_AgentActorApprovalHold_DeniedWithoutGrant(t *testing.T) {
	// The real `restart` command is access:'approval' — a bare agent
	// request (no grant) must NOT execute. A hold is not an allow.
	db := testDB(t)
	withGuardTables(t, db)
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
		Guard: &GuardContext{CLIRestart: &CLIRestartGuardContext{
			ActorKind:    "agent",
			AgentGroupID: "ag-1",
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: an approval-required command with no grant must never execute")
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("expected exec never reached, got %d wake calls", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_AgentActorApprovalHold_AllowedWithLiveMatchingGrant(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	if _, err := db.Exec(
		`INSERT INTO pending_approvals (approval_id, action, payload) VALUES (?, ?, ?)`,
		"appr-1", "cli_command", `{"frame":{"command":"restart"}}`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
		Guard: &GuardContext{CLIRestart: &CLIRestartGuardContext{
			ActorKind:    "agent",
			AgentGroupID: "ag-1",
			Grant:        &GuardGrant{ApprovalID: "appr-1", Action: "cli_command"},
		}},
	})
	if !resp.OK {
		t.Fatalf("expected the live matching grant to satisfy the hold, got %+v", resp)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected exactly one Wake call, got %d", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Wake_AgentActorGrantForDeletedApproval_Denied(t *testing.T) {
	// Independent verification, the whole point of ADR-015: a caller cannot
	// merely CLAIM its hold was approved. No row in pending_approvals means
	// no execution, however confidently the request asserts a grant.
	db := testDB(t)
	withGuardTables(t, db)
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerWake,
		Session:    ptrSession(validSession()),
		Guard: &GuardContext{CLIRestart: &CLIRestartGuardContext{
			ActorKind:    "agent",
			AgentGroupID: "ag-1",
			Grant:        &GuardGrant{ApprovalID: "appr-never-existed", Action: "cli_command"},
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: the claimed approval does not exist in pending_approvals")
	}
	if exec.wakeCalls != 0 {
		t.Fatalf("expected exec never reached, got %d wake calls", exec.wakeCalls)
	}
}

func TestCapabilityRequest_Kill_GuardEvaluatedBeforeExec(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	if _, err := db.Exec(`INSERT INTO container_configs (agent_group_id, cli_scope) VALUES ('ag-1', 'disabled')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	// Register a live session so the ownership/registry checks alone
	// wouldn't be what denies this — the guard must be what stops it.
	dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{Capability: CapabilityContainerWake, Session: ptrSession(validSession())})
	exec.wakeCalls = 0

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
		Reason:     "restart",
		Guard: &GuardContext{CLIRestart: &CLIRestartGuardContext{
			ActorKind:    "agent",
			AgentGroupID: "ag-1",
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: cli_scope=disabled must stop a guarded kill before exec")
	}
	if exec.killCalls != 0 {
		t.Fatalf("expected exec.Kill never reached, got %d calls", exec.killCalls)
	}
}

func TestCapabilityRequest_Kill_UsesGraceSecondsRecordedAtWakeTime(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	spec := validSession()
	spec.StopGraceSeconds = 9
	dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{Capability: CapabilityContainerWake, Session: ptrSession(spec)})

	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability: CapabilityContainerKill,
		SessionID:  "sess-1",
		Reason:     "test",
	})
	if !resp.OK {
		t.Fatalf("expected kill to succeed, got %+v", resp)
	}
	if exec.killedGrace != 9 {
		t.Fatalf("killedGrace = %d, want the 9 seconds recorded at wake time (never re-asserted by the caller)", exec.killedGrace)
	}
}

func TestCapabilityRequest_BuildImage_SelfModGuard_DeniedForNonAgentActor(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent-ag-1",
		Dockerfile:   "FROM scratch\n",
		Guard: &GuardContext{SelfMod: &SelfModGuardContext{
			ActorKind: "host",
			Action:    "self_mod.install_packages",
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: install_packages is a container-originated action only")
	}
	if exec.buildCalls != 0 {
		t.Fatalf("expected exec never reached, got %d build calls", exec.buildCalls)
	}
}

func TestCapabilityRequest_BuildImage_SelfModGuard_HoldWithoutGrantDenied(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent-ag-1",
		Dockerfile:   "FROM scratch\n",
		Guard: &GuardContext{SelfMod: &SelfModGuardContext{
			ActorKind: "agent",
			Action:    "self_mod.install_packages",
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: install_packages always holds for admin approval; no grant means no execution")
	}
	if exec.buildCalls != 0 {
		t.Fatalf("expected exec never reached, got %d build calls", exec.buildCalls)
	}
}

// TestCapabilityRequest_BuildImage_SelfModGuard_HoldSatisfiedByLiveGrant_Allowed
// is the fix for the gap SelfModGuardContext.Grant closes: before it
// existed, checkSelfModGuard always called EvaluateSelfModWithGrant with
// grant=nil, and DecideSelfMod never allows an agent actor outright — so a
// guarded container.build_image request could never succeed at all,
// regardless of a real, live, matching approval. This is the same
// hold-satisfied-by-grant shape TestCapabilityRequest_Wake_
// AgentActorApprovalHold_AllowedWithLiveMatchingGrant already proves for the
// CLI-restart path.
func TestCapabilityRequest_BuildImage_SelfModGuard_HoldSatisfiedByLiveGrant_Allowed(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	if _, err := db.Exec(`INSERT INTO pending_approvals (approval_id, action, payload) VALUES ('appr-1', 'install_packages', '{}')`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent-ag-1",
		Dockerfile:   "FROM scratch\n",
		Guard: &GuardContext{SelfMod: &SelfModGuardContext{
			ActorKind: "agent",
			Action:    "self_mod.install_packages",
			Grant:     &GuardGrant{ApprovalID: "appr-1", Action: "install_packages"},
		}},
	})
	if !resp.OK {
		t.Fatalf("expected a hold satisfied by a live matching grant to succeed, got %+v", resp)
	}
	if exec.buildCalls != 1 {
		t.Fatalf("expected exactly one BuildImage call, got %d", exec.buildCalls)
	}
}

func TestCapabilityRequest_BuildImage_SelfModGuard_GrantForDeletedApproval_Denied(t *testing.T) {
	db := testDB(t)
	withGuardTables(t, db)
	// No row inserted — mirrors an already-resolved (deleted) approval.
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec), WithSessionDB(db))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent-ag-1",
		Dockerfile:   "FROM scratch\n",
		Guard: &GuardContext{SelfMod: &SelfModGuardContext{
			ActorKind: "agent",
			Action:    "self_mod.install_packages",
			Grant:     &GuardGrant{ApprovalID: "appr-gone", Action: "install_packages"},
		}},
	})
	if resp.OK {
		t.Fatal("expected denial: grant references an approval this DB no longer has")
	}
	if exec.buildCalls != 0 {
		t.Fatalf("expected exec never reached, got %d build calls", exec.buildCalls)
	}
}

func TestCapabilityRequest_BuildImage_NoGuardContext_ExecutesUngatedAsBefore(t *testing.T) {
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
		t.Fatalf("expected an ungated build to succeed, got %+v", resp)
	}
	if exec.buildCalls != 1 {
		t.Fatalf("expected exactly one BuildImage call, got %d", exec.buildCalls)
	}
}

// TestCapabilityRequest_BuildImage_RepoColonTagImageTag_Accepted pins the
// real TS caller's shape: container-runner.ts's buildAgentGroupImage (the
// only production caller of container.build_image, per ADR-016) always
// sends `${CONTAINER_IMAGE_BASE}:${agentGroupId}` — a full docker
// reference, not a bare single fragment. Before legalTagFragment allowed an
// optional `:tag` suffix, this exact real-shaped value would have been
// rejected as spec-invalid, making the only production caller of this
// capability permanently unable to use it.
func TestCapabilityRequest_BuildImage_RepoColonTagImageTag_Accepted(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent-v2-ab12cd34:ag-1",
		Dockerfile:   "FROM scratch\n",
	})
	if !resp.OK {
		t.Fatalf("expected a real-shaped repo:tag ImageTag to be accepted, got %+v", resp)
	}
	if exec.buildCalls != 1 {
		t.Fatalf("expected exactly one BuildImage call, got %d", exec.buildCalls)
	}
}

// TestCapabilityRequest_BuildImage_MultipleColons_Denied confirms the
// widened regex still rejects anything beyond exactly one repo:tag
// separator — a second colon (e.g. a registry-port-prefixed reference like
// "host:5000:extra") is not a shape this capability accepts.
func TestCapabilityRequest_BuildImage_MultipleColons_Denied(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))
	resp := dispatch(t, k, OpCapabilityRequest, CapabilityRequestPayload{
		Capability:   CapabilityContainerBuildImage,
		AgentGroupID: "ag-1",
		GroupFolder:  "ag-1-folder",
		ImageTag:     "nanoclaw-agent:ag-1:extra",
		Dockerfile:   "FROM scratch\n",
	})
	if resp.OK {
		t.Fatal("expected denial: more than one colon is not a legal repo:tag pair")
	}
	if exec.buildCalls != 0 {
		t.Fatalf("expected exec never reached, got %d build calls", exec.buildCalls)
	}
}

func ptrSession(s mount.Session) *mount.Session { return &s }

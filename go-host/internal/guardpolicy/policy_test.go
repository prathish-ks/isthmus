package guardpolicy

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// openTestDB creates container_configs and pending_approvals tables
// matching the columns this package's SQL lookups actually read — NOT the
// full production schema (see doc.go: this package never asserts ownership
// of tables TypeScript's own migrations create; a Go process against the
// real central DB finds them already there). This CREATE TABLE only ever
// fires against a fresh, Go-only test database, exactly like
// internal/session's own established practice.
func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "guardpolicy-test.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("opening test db: %v", err)
	}
	t.Cleanup(func() {
		if cerr := db.Close(); cerr != nil {
			t.Logf("closing test db: %v", cerr)
		}
	})

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
		t.Fatalf("creating test schema: %v", err)
	}
	return db
}

func setCLIScope(t *testing.T, db *sql.DB, agentGroupID, scope string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO container_configs (agent_group_id, cli_scope) VALUES (?, ?)`,
		agentGroupID, scope,
	); err != nil {
		t.Fatalf("seeding container_configs: %v", err)
	}
}

func insertApproval(t *testing.T, db *sql.DB, approvalID, action, payloadJSON string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO pending_approvals (approval_id, action, payload) VALUES (?, ?, ?)`,
		approvalID, action, payloadJSON,
	); err != nil {
		t.Fatalf("seeding pending_approvals: %v", err)
	}
}

func agentActor(agentGroupID string) Actor {
	return Actor{Kind: ActorAgent, AgentGroupID: agentGroupID}
}

// The five synthetic CommandDefs below are ported verbatim (same names,
// same fields) from fixtures-guard-catalog.test.ts lines 585-624, so that
// each Go test below exercises the identical shape of input the real
// snapshot-backed TypeScript fixture does.

var restartLikeCmd = CommandSpec{Name: "test-restart", Access: AccessApproval, Resource: "groups"}
var openGroupsCmd = CommandSpec{Name: "test-open-groups", Access: AccessOpen, Resource: "groups"}
var hostOnlyCmd = CommandSpec{Name: "test-hostonly", Access: AccessOpen, HostOnly: true}
var disallowedResourceCmd = CommandSpec{Name: "test-roles", Access: AccessOpen, Resource: "roles"}
var wiringUpdateCmd = CommandSpec{Name: "wirings-update", Access: AccessOpen, Resource: "wirings"}

// --- The 13 golden fixtures from fixtures-guard-catalog.test.ts's
// "P2-04 guard catalog: CLI-derived restart-style guard (commandDecide)"
// describe block (lines 632-747), reproduced with the exact same cmd/actor/
// args per case. Each test names the .snap export it corresponds to. ---

func TestDecide_CLI_HostCallerAllowed(t *testing.T) {
	// guard-cli-host-caller
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, restartLikeCmd, Actor{Kind: ActorHost}, map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "allow" {
		t.Fatalf("effect = %q, want allow", got.Effect)
	}
}

func TestDecide_CLI_NonHostNonAgentDenied(t *testing.T) {
	// guard-cli-non-host-non-agent
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, Actor{Kind: ActorSystem}, map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_HostOnlyDeniedEvenAtGlobalScope(t *testing.T) {
	// guard-cli-host-only-denied
	db := openTestDB(t)
	setCLIScope(t, db, "ag-hostonly", "global")
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, hostOnlyCmd, agentActor("ag-hostonly"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ScopeDisabledDenies(t *testing.T) {
	// guard-cli-scope-disabled
	db := openTestDB(t)
	setCLIScope(t, db, "ag-disabled", "disabled")
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("ag-disabled"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ScopeGroupDeniesUnallowlistedResource(t *testing.T) {
	// guard-cli-scope-resource-not-allowlisted (g1 has no config row -> default "group")
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, disallowedResourceCmd, agentActor("g1"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ScopeGroupDeniesCrossGroupArg(t *testing.T) {
	// guard-cli-scope-cross-group-arg
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("g1"), map[string]string{"agent_group_id": "someone-elses-group"})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ScopeGroupDeniesCrossGroupID(t *testing.T) {
	// guard-cli-scope-cross-group-id
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("g1"), map[string]string{"id": "someone-elses-group"})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ScopeGroupDeniesWiringUpdateArgsOutsideAllowedSet(t *testing.T) {
	// guard-cli-scope-wiring-update-args
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, wiringUpdateCmd, agentActor("g1"), map[string]string{"engage_pattern": ".", "foo": "bar"})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ScopeGroupDeniesCLIScopeMutation(t *testing.T) {
	// guard-cli-scope-mutation-denied
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("g1"), map[string]string{"cli_scope": "global"})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecide_CLI_ApprovalRequiredHolds(t *testing.T) {
	// guard-cli-approval-required-hold
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, restartLikeCmd, agentActor("g1"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "hold" {
		t.Fatalf("effect = %q, want hold", got.Effect)
	}
}

func TestDecide_CLI_OpenCommandAllowed(t *testing.T) {
	// guard-cli-open-command
	db := openTestDB(t)
	got, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("g1"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if got.Effect != "allow" {
		t.Fatalf("effect = %q, want allow", got.Effect)
	}
}

func TestEvaluateWithGrant_CLI_GrantSatisfiesHold(t *testing.T) {
	// guard-cli-grant-satisfied
	db := openTestDB(t)
	insertApproval(t, db, "appr-cli-1", "cli_command", `{"frame":{"command":"test-restart"}}`)
	grant := &Grant{ApprovalID: "appr-cli-1", Action: "cli_command"}
	got, err := EvaluateWithGrant(context.Background(), SQLCLIScopeLookup{DB: db}, SQLApprovalLookup{DB: db}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if err != nil {
		t.Fatalf("EvaluateWithGrant: %v", err)
	}
	if got.Effect != "allow" {
		t.Fatalf("effect = %q, want allow (grant satisfied)", got.Effect)
	}
}

func TestEvaluateWithGrant_CLI_GrantMismatchDenied(t *testing.T) {
	// guard-cli-grant-mismatch
	db := openTestDB(t)
	insertApproval(t, db, "appr-cli-2", "cli_command", `{"frame":{"command":"some-other-command"}}`)
	grant := &Grant{ApprovalID: "appr-cli-2", Action: "cli_command"}
	got, err := EvaluateWithGrant(context.Background(), SQLCLIScopeLookup{DB: db}, SQLApprovalLookup{DB: db}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if err != nil {
		t.Fatalf("EvaluateWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (grant names a different command)", got.Effect)
	}
}

// Independent-verification-specific cases, beyond the 13 ported fixtures:
// these pin the exact property ADR-015 exists for — the kernel reads
// cli_scope/approval state itself and is not fooled by a caller's claim.

func TestEvaluateWithGrant_CLI_GrantForDeletedApprovalDenied(t *testing.T) {
	// A caller presents a Grant referencing an approval_id that does not
	// (or no longer) exist in pending_approvals — mirroring "resolution
	// deletes it, so a grant can only execute once". Never trust the
	// caller's claim that it's still valid.
	db := openTestDB(t)
	grant := &Grant{ApprovalID: "appr-never-existed", Action: "cli_command"}
	got, err := EvaluateWithGrant(context.Background(), SQLCLIScopeLookup{DB: db}, SQLApprovalLookup{DB: db}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if err != nil {
		t.Fatalf("EvaluateWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (approval row absent)", got.Effect)
	}
}

func TestEvaluateWithGrant_CLI_MalformedApprovalPayloadFailsClosed(t *testing.T) {
	db := openTestDB(t)
	insertApproval(t, db, "appr-cli-bad", "cli_command", `not json`)
	grant := &Grant{ApprovalID: "appr-cli-bad", Action: "cli_command"}
	got, err := EvaluateWithGrant(context.Background(), SQLCLIScopeLookup{DB: db}, SQLApprovalLookup{DB: db}, restartLikeCmd, agentActor("g1"), map[string]string{}, grant)
	if err != nil {
		t.Fatalf("EvaluateWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (malformed payload fails closed)", got.Effect)
	}
}

func TestDecide_CLI_ScopeIndependentlyReadFromDB_NotCallerAsserted(t *testing.T) {
	// The Actor carries no cli_scope field at all — DecideRestartLike's
	// only signature is (ctx, scopes, cmd, actor, args); there is no field
	// a caller could set to assert "my scope is group" and skip the DB
	// read. This test exists to make that structural guarantee visible: two
	// otherwise-identical requests differing only in what's actually stored
	// in container_configs produce different decisions.
	db := openTestDB(t)
	setCLIScope(t, db, "ag-x", "disabled")
	gotDisabled, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("ag-x"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if gotDisabled.Effect != "deny" {
		t.Fatalf("effect = %q, want deny for cli_scope=disabled", gotDisabled.Effect)
	}

	setCLIScope(t, db, "ag-y", "global")
	gotGlobal, err := DecideRestartLike(context.Background(), SQLCLIScopeLookup{DB: db}, openGroupsCmd, agentActor("ag-y"), map[string]string{})
	if err != nil {
		t.Fatalf("DecideRestartLike: %v", err)
	}
	if gotGlobal.Effect != "allow" {
		t.Fatalf("effect = %q, want allow for cli_scope=global on an open command", gotGlobal.Effect)
	}
}

// --- Self-mod gate fixtures, ported from
// src/modules/self-mod/guard.ts / its test coverage described in
// EC-04-guard-scope-design-notes.md ---

type fixedCapabilities struct{ imageBuild bool }

func (f fixedCapabilities) ImageBuildSupported(context.Context) (bool, error) {
	return f.imageBuild, nil
}

func TestDecideSelfMod_InstallPackages_NonAgentDenied(t *testing.T) {
	got, err := DecideSelfMod(context.Background(), fixedCapabilities{imageBuild: true}, SelfModInstallPackages, Actor{Kind: ActorHost})
	if err != nil {
		t.Fatalf("DecideSelfMod: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestDecideSelfMod_InstallPackages_DeniedBeforeHoldWhenRuntimeCannotRebuild(t *testing.T) {
	got, err := DecideSelfMod(context.Background(), fixedCapabilities{imageBuild: false}, SelfModInstallPackages, agentActor("g1"))
	if err != nil {
		t.Fatalf("DecideSelfMod: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (no imageBuild capability)", got.Effect)
	}
}

func TestDecideSelfMod_InstallPackages_HoldsWhenRuntimeCanRebuild(t *testing.T) {
	got, err := DecideSelfMod(context.Background(), fixedCapabilities{imageBuild: true}, SelfModInstallPackages, agentActor("g1"))
	if err != nil {
		t.Fatalf("DecideSelfMod: %v", err)
	}
	if got.Effect != "hold" {
		t.Fatalf("effect = %q, want hold", got.Effect)
	}
}

func TestDecideSelfMod_AddMCPServer_NonAgentDenied(t *testing.T) {
	got, err := DecideSelfMod(context.Background(), fixedCapabilities{imageBuild: true}, SelfModAddMCPServer, Actor{Kind: ActorHost})
	if err != nil {
		t.Fatalf("DecideSelfMod: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny", got.Effect)
	}
}

func TestEvaluateSelfModWithGrant_InstallPackages_GrantSatisfiesHold(t *testing.T) {
	db := openTestDB(t)
	insertApproval(t, db, "appr-sm-1", "install_packages", `{}`)
	grant := &Grant{ApprovalID: "appr-sm-1", Action: "install_packages"}
	got, err := EvaluateSelfModWithGrant(context.Background(), fixedCapabilities{imageBuild: true}, SQLApprovalLookup{DB: db}, SelfModInstallPackages, agentActor("g1"), grant)
	if err != nil {
		t.Fatalf("EvaluateSelfModWithGrant: %v", err)
	}
	if got.Effect != "allow" {
		t.Fatalf("effect = %q, want allow (grant satisfied)", got.Effect)
	}
}

func TestEvaluateSelfModWithGrant_InstallPackages_GrantForWrongActionDenied(t *testing.T) {
	db := openTestDB(t)
	insertApproval(t, db, "appr-sm-2", "add_mcp_server", `{}`)
	grant := &Grant{ApprovalID: "appr-sm-2", Action: "add_mcp_server"}
	got, err := EvaluateSelfModWithGrant(context.Background(), fixedCapabilities{imageBuild: true}, SQLApprovalLookup{DB: db}, SelfModInstallPackages, agentActor("g1"), grant)
	if err != nil {
		t.Fatalf("EvaluateSelfModWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (grant names a different action)", got.Effect)
	}
}

func TestEvaluateSelfModWithGrant_InstallPackages_DeletedApprovalDenied(t *testing.T) {
	db := openTestDB(t)
	grant := &Grant{ApprovalID: "appr-sm-never-existed", Action: "install_packages"}
	got, err := EvaluateSelfModWithGrant(context.Background(), fixedCapabilities{imageBuild: true}, SQLApprovalLookup{DB: db}, SelfModInstallPackages, agentActor("g1"), grant)
	if err != nil {
		t.Fatalf("EvaluateSelfModWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (approval row absent)", got.Effect)
	}
}

func TestEvaluateSelfModWithGrant_InstallPackages_NoImageBuildDeniesEvenWithGrant(t *testing.T) {
	// The capability gate runs first inside DecideSelfMod and returns deny,
	// not hold — a grant must never turn that deny into an allow.
	db := openTestDB(t)
	insertApproval(t, db, "appr-sm-3", "install_packages", `{}`)
	grant := &Grant{ApprovalID: "appr-sm-3", Action: "install_packages"}
	got, err := EvaluateSelfModWithGrant(context.Background(), fixedCapabilities{imageBuild: false}, SQLApprovalLookup{DB: db}, SelfModInstallPackages, agentActor("g1"), grant)
	if err != nil {
		t.Fatalf("EvaluateSelfModWithGrant: %v", err)
	}
	if got.Effect != "deny" {
		t.Fatalf("effect = %q, want deny (no imageBuild capability, grant irrelevant)", got.Effect)
	}
}

func TestDecideSelfMod_AddMCPServer_HoldsEvenWithoutImageBuild(t *testing.T) {
	// "it needs no rebuild, so it must not inherit install_packages' gate"
	got, err := DecideSelfMod(context.Background(), fixedCapabilities{imageBuild: false}, SelfModAddMCPServer, agentActor("g1"))
	if err != nil {
		t.Fatalf("DecideSelfMod: %v", err)
	}
	if got.Effect != "hold" {
		t.Fatalf("effect = %q, want hold (add_mcp_server needs no rebuild)", got.Effect)
	}
}

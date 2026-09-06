package guardpolicy

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// SQLCLIScopeLookup implements CLIScopeLookup against the real
// container_configs table (created by TypeScript's migration 014/015, never
// by this package — see doc.go). It is deliberately a thin, single-query
// wrapper: the security property this whole package exists for is that the
// kernel reads this value itself rather than trusting a caller, not that
// the query is clever.
type SQLCLIScopeLookup struct {
	DB *sql.DB
}

var _ CLIScopeLookup = SQLCLIScopeLookup{}

// CLIScope returns the agent group's cli_scope column, or "group" (the
// column's own migration-015 DEFAULT) when no container_configs row exists
// yet for this agent group — mirroring
// `getContainerConfig(id)?.cli_scope ?? 'group'` exactly, including the
// row-absent case, not just a null column.
func (l SQLCLIScopeLookup) CLIScope(ctx context.Context, agentGroupID string) (string, error) {
	var scope sql.NullString
	err := l.DB.QueryRowContext(ctx,
		`SELECT cli_scope FROM container_configs WHERE agent_group_id = ?`, agentGroupID,
	).Scan(&scope)
	if errors.Is(err, sql.ErrNoRows) {
		return "group", nil
	}
	if err != nil {
		return "", fmt.Errorf("guardpolicy: querying container_configs.cli_scope: %w", err)
	}
	if !scope.Valid || scope.String == "" {
		return "group", nil
	}
	return scope.String, nil
}

// SQLApprovalLookup implements ApprovalLookup against the real
// pending_approvals table (created by TypeScript's pending-approvals
// migration, never by this package).
type SQLApprovalLookup struct {
	DB *sql.DB
}

var _ ApprovalLookup = SQLApprovalLookup{}

// PendingApproval mirrors src/db/sessions.ts's getPendingApproval: an exact
// SELECT by approval_id, no status filter — resolution (approve/reject)
// deletes the row entirely (guard.ts's own comment: "resolution deletes it,
// so a grant can only execute once"), so mere existence is liveness.
func (l SQLApprovalLookup) PendingApproval(ctx context.Context, approvalID string) (action string, payloadJSON string, ok bool, err error) {
	err = l.DB.QueryRowContext(ctx,
		`SELECT action, payload FROM pending_approvals WHERE approval_id = ?`, approvalID,
	).Scan(&action, &payloadJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, fmt.Errorf("guardpolicy: querying pending_approvals: %w", err)
	}
	return action, payloadJSON, true, nil
}

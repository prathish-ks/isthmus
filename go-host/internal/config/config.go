// Package config implements P3-02's minimal, single-instance configuration:
// exactly the fields needed to identify one local user, one agent group, and
// one session for the Phase 3 protocol-proof round trip. It is deliberately
// NOT a general configuration framework — no defaults, no env-var layering,
// no multi-tenant lookup, no central-DB read. Later phases may replace this
// outright once the Go host needs to read NanoClaw's real central DB
// (src/types.ts's AgentGroup/Session tables).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// Config is the minimal set of facts this proof needs: which user, which
// agent group (and its on-disk folder, mirroring NanoClaw's
// AgentGroup.folder in src/types.ts), which session, and the two
// directories NanoClaw's own src/config.ts resolves as DATA_DIR/GROUPS_DIR
// — the roots the inbound/outbound mailboxes and the agent's mounted folder
// live under.
type Config struct {
	DataDir      string `json:"data_dir"`
	GroupsDir    string `json:"groups_dir"`
	UserID       string `json:"user_id"`
	AgentGroupID string `json:"agent_group_id"`
	AgentFolder  string `json:"agent_folder"`
	SessionID    string `json:"session_id"`
}

// Load reads and validates a Config from a JSON file at path. On any error
// the returned Config is the zero value — never a partially-valid one.
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("reading config file %q: %w", path, err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, fmt.Errorf("parsing config file %q as JSON: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, fmt.Errorf("config file %q is invalid: %w", path, err)
	}

	return cfg, nil
}

// Validate reports every missing required field at once, via errors.Join,
// rather than stopping at the first — so fixing a bad config file takes one
// pass instead of one error per re-run. Returns nil when every field is
// present.
func (c Config) Validate() error {
	var errs []error
	require := func(value, field string) {
		if value == "" {
			errs = append(errs, fmt.Errorf("%s is required", field))
		}
	}

	require(c.DataDir, "data_dir")
	require(c.GroupsDir, "groups_dir")
	require(c.UserID, "user_id")
	require(c.AgentGroupID, "agent_group_id")
	require(c.AgentFolder, "agent_folder")
	require(c.SessionID, "session_id")

	return errors.Join(errs...)
}

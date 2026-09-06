package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTempConfig(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("writing temp config: %v", err)
	}
	return path
}

func TestLoadValid(t *testing.T) {
	path := writeTempConfig(t, `{
		"data_dir": "/tmp/nanoclaw-data",
		"groups_dir": "/tmp/nanoclaw-groups",
		"user_id": "discord:owner",
		"agent_group_id": "ag-1",
		"agent_folder": "test-agent",
		"session_id": "sess-1"
	}`)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v, want nil", err)
	}
	if cfg.AgentGroupID != "ag-1" {
		t.Errorf("AgentGroupID = %q, want %q", cfg.AgentGroupID, "ag-1")
	}
	if cfg.SessionID != "sess-1" {
		t.Errorf("SessionID = %q, want %q", cfg.SessionID, "sess-1")
	}
}

func TestLoadMissingFile(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err == nil {
		t.Fatal("Load() error = nil, want an error for a missing file")
	}
}

func TestLoadMalformedJSON(t *testing.T) {
	path := writeTempConfig(t, `{ not valid json `)
	_, err := Load(path)
	if err == nil {
		t.Fatal("Load() error = nil, want an error for malformed JSON")
	}
}

func TestLoadMissingFieldsReportsAll(t *testing.T) {
	path := writeTempConfig(t, `{"data_dir": "/tmp/x"}`)

	_, err := Load(path)
	if err == nil {
		t.Fatal("Load() error = nil, want an error for missing fields")
	}

	for _, field := range []string{"groups_dir", "user_id", "agent_group_id", "agent_folder", "session_id"} {
		want := field + " is required"
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention missing field %q", err.Error(), want)
		}
	}
	// data_dir WAS supplied — must not be reported as missing.
	if strings.Contains(err.Error(), "data_dir is required") {
		t.Errorf("error %q wrongly reports data_dir as missing", err.Error())
	}
}

func TestValidateAllPresent(t *testing.T) {
	cfg := Config{
		DataDir:      "d",
		GroupsDir:    "g",
		UserID:       "u",
		AgentGroupID: "a",
		AgentFolder:  "f",
		SessionID:    "s",
	}
	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate() error = %v, want nil", err)
	}
}

func TestValidateAllMissing(t *testing.T) {
	err := (Config{}).Validate()
	if err == nil {
		t.Fatal("Validate() error = nil, want an error when every field is empty")
	}
	count := strings.Count(err.Error(), "is required")
	if count != 6 {
		t.Errorf("Validate() reported %d missing-field errors (message: %q), want 6", count, err.Error())
	}
}

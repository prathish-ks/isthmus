package kernel

import (
	"context"
	"encoding/json"
	"testing"
)

// TestWireFormat_HandAuthoredJSONContainerWake pins the exact camelCase wire
// contract a real, non-Go caller (the TypeScript kernel client, EC-02) has
// to speak — as opposed to every other test in this package, which
// round-trips through json.Marshal(CapabilityRequestPayload{...}) and so
// would still pass even if mount.Session/Container/Spec/SessionKey/
// Capabilities or containerdefaults.RunAs/Resources had no json tags at all
// (Go's default PascalCase-field-name marshaling is self-consistent on
// both ends of a Go-to-Go round trip). This test instead hand-authors the
// envelope as a literal JSON string — exactly what a TS client emits — so a
// future accidental removal of a json tag on any of these nested types
// fails here first, not as a silent zero-value Session reaching
// mount.ValidateSpec with a confusing denial on the real Mac.
func TestWireFormat_HandAuthoredJSONContainerWake(t *testing.T) {
	exec := &fakeExecutor{}
	k := New(testPolicy(), withExecutor(exec))

	payload := []byte(`{
		"capability": "container.wake",
		"session": {
			"key": {"installSlug": "test", "agentGroupId": "ag-1", "sessionId": "sess-1"},
			"labels": {"nanoclaw-group-folder": "ag-1-folder"},
			"containers": [{
				"role": "agent",
				"env": {"FOO": "bar"},
				"contributedEnv": {"BEARER": "placeholder"},
				"mounts": [{
					"class": "group-state",
					"hostPath": "/data/groups/ag-1-folder/state",
					"containerPath": "/workspace/state",
					"mode": "rw",
					"groupScope": "ag-1"
				}],
				"image": "nanoclaw-agent:ag-1",
				"command": ["/bin/entrypoint.sh"],
				"args": ["--flag"],
				"labels": {"nanoclaw-container-name": "legacy-name"}
			}],
			"runtimeTier": "container",
			"stopGraceSeconds": 5
		},
		"runAs": {"uid": 1000, "gid": 1000, "set": true},
		"resources": {"memoryMB": 512, "pidsLimit": 100, "shmSizeMB": 64, "cpus": "1.0"},
		"capabilities": {"isolationTiers": ["container"]}
	}`)

	resp := k.Dispatch(context.Background(), Envelope{
		Version:   ProtocolVersion,
		Op:        OpCapabilityRequest,
		RequestID: "wire-1",
		Payload:   json.RawMessage(payload),
	})
	if !resp.OK {
		t.Fatalf("hand-authored camelCase JSON was not accepted: %+v", resp.Error)
	}
	if exec.wakeCalls != 1 {
		t.Fatalf("expected exactly 1 Wake call, got %d", exec.wakeCalls)
	}

	var out CapabilityResponsePayload
	if err := json.Unmarshal(resp.Payload, &out); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if !out.Allowed || out.ContainerID == "" || out.ContainerName == "" {
		t.Fatalf("expected allowed with container id+name, got %+v", out)
	}

	// Response envelope's own field names — also part of the contract a TS
	// client hand-decodes, not just the request side.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(resp.Payload, &raw); err != nil {
		t.Fatalf("unmarshal response as map: %v", err)
	}
	for _, key := range []string{"allowed", "containerId", "containerName"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("response payload missing expected camelCase key %q: %s", key, resp.Payload)
		}
	}
}

// TestWireFormat_HandAuthoredJSONGuardContext pins the guard envelope's own
// camelCase contract (cliRestart/selfMod/actorKind/agentGroupId/grant/
// approvalId), independent of the session/runAs/resources contract above.
func TestWireFormat_HandAuthoredJSONGuardContext(t *testing.T) {
	// ActorKind "host" allows without ever consulting cli_scope/approval
	// tables (guardpolicy.DecideRestartLike's first branch), so this test
	// isolates the guard envelope's OWN wire contract (cliRestart/actorKind/
	// agentGroupId/args) from the separate cli_scope-lookup contract
	// capability_guard_test.go's Go-to-Go tests already cover.
	db := testDB(t)
	k := New(testPolicy(), withExecutor(&fakeExecutor{}), WithSessionDB(db))

	payload := []byte(`{
		"capability": "container.wake",
		"session": {
			"key": {"installSlug": "test", "agentGroupId": "ag-1", "sessionId": "sess-1"},
			"labels": {"nanoclaw-group-folder": "ag-1-folder"},
			"containers": [{"role": "agent", "env": {}}],
			"runtimeTier": "container"
		},
		"guard": {
			"cliRestart": {
				"actorKind": "host",
				"args": {"agent_group_id": "ag-1"}
			}
		}
	}`)

	resp := k.Dispatch(context.Background(), Envelope{
		Version:   ProtocolVersion,
		Op:        OpCapabilityRequest,
		RequestID: "wire-2",
		Payload:   json.RawMessage(payload),
	})
	if !resp.OK {
		t.Fatalf("hand-authored camelCase guard JSON was not accepted: %+v", resp.Error)
	}
}

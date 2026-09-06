package trace

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRedact_EmptyString(t *testing.T) {
	if got := Redact(""); got != "(empty)" {
		t.Fatalf("Redact(\"\") = %q", got)
	}
}

func TestRedact_NeverReturnsTheOriginalContent(t *testing.T) {
	secret := "hunter2 my password is also in here"
	got := Redact(secret)
	if got == secret {
		t.Fatal("Redact must never return the original content verbatim")
	}
	if len(got) == 0 {
		t.Fatal("Redact must return something non-empty for non-empty input")
	}
}

func TestStore_RecordAndTrace_OrderedOldestFirst(t *testing.T) {
	s := NewStore(0)
	base := time.Now()
	s.Record(Event{Key: "msg-1", Stage: StageRoute, At: base.Add(2 * time.Second)})
	s.Record(Event{Key: "msg-1", Stage: StageSession, At: base.Add(1 * time.Second)})
	s.Record(Event{Key: "msg-1", Stage: StageContainerWake, At: base.Add(3 * time.Second)})

	events := s.Trace("msg-1")
	if len(events) != 3 {
		t.Fatalf("len(events) = %d, want 3", len(events))
	}
	if events[0].Stage != StageSession || events[1].Stage != StageRoute || events[2].Stage != StageContainerWake {
		t.Fatalf("events not ordered oldest-first: %+v", events)
	}
}

func TestStore_UnknownKeyReturnsEmptyNotNilOrError(t *testing.T) {
	s := NewStore(0)
	events := s.Trace("never-recorded")
	if events == nil {
		t.Fatal("Trace of an unknown key must return a non-nil empty slice")
	}
	if len(events) != 0 {
		t.Fatalf("len(events) = %d, want 0", len(events))
	}
}

func TestStore_BlankKeyIsANoOp(t *testing.T) {
	s := NewStore(0)
	s.Record(Event{Key: "", Stage: StageRoute})
	if len(s.Trace("")) != 0 {
		t.Fatal("recording with a blank key must not be retrievable")
	}
}

func TestStore_SetsAtWhenZero(t *testing.T) {
	s := NewStore(0)
	before := time.Now()
	s.Record(Event{Key: "msg-2", Stage: StageDelivery})
	events := s.Trace("msg-2")
	if len(events) != 1 {
		t.Fatalf("len(events) = %d, want 1", len(events))
	}
	if events[0].At.Before(before) {
		t.Fatal("At should default to a time no earlier than just before Record was called")
	}
}

func TestStore_EvictsOldestBeyondCapacity(t *testing.T) {
	s := NewStore(3)
	for i := 0; i < 5; i++ {
		s.Record(Event{Key: "msg-3", Stage: StageRoute, At: time.Now().Add(time.Duration(i) * time.Millisecond), Summary: string(rune('a' + i))})
	}
	events := s.Trace("msg-3")
	if len(events) != 3 {
		t.Fatalf("len(events) = %d, want 3 (capacity-bounded)", len(events))
	}
	// The three most recent (c, d, e) should survive, oldest (a, b) evicted.
	if events[0].Summary != "c" || events[2].Summary != "e" {
		t.Fatalf("expected oldest-evicted retention of the most recent 3, got %+v", events)
	}
}

func TestFileBackedStore_RecordAlsoAppendsToFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace.jsonl")
	s := NewFileBackedStore(path, 0)
	s.Record(Event{Key: "msg-1", Stage: StageRoute, Summary: "engage=true"})
	s.Record(Event{Key: "msg-1", Stage: StageContainerWake, Summary: "allowed=true"})
	s.Record(Event{Key: "msg-2", Stage: StageDelivery, Summary: "allowed=true"})

	// In-memory read still works, same as a plain Store.
	if len(s.Trace("msg-1")) != 2 {
		t.Fatalf("in-memory Trace(msg-1) = %d events, want 2", len(s.Trace("msg-1")))
	}

	// A completely separate read (simulating a different CLI process with
	// no access to s's memory) sees the same history via the file.
	fromFile, err := ReadFile(path, "msg-1")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if len(fromFile) != 2 {
		t.Fatalf("ReadFile(msg-1) = %d events, want 2", len(fromFile))
	}
	if fromFile[0].Stage != StageRoute || fromFile[1].Stage != StageContainerWake {
		t.Fatalf("unexpected order/stages from file: %+v", fromFile)
	}

	other, err := ReadFile(path, "msg-2")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if len(other) != 1 {
		t.Fatalf("ReadFile(msg-2) = %d events, want 1", len(other))
	}
}

func TestReadFile_MissingFileReturnsEmptyNotError(t *testing.T) {
	events, err := ReadFile(filepath.Join(t.TempDir(), "does-not-exist.jsonl"), "any-key")
	if err != nil {
		t.Fatalf("ReadFile of a missing file should not error, got %v", err)
	}
	if events == nil || len(events) != 0 {
		t.Fatalf("expected empty, non-nil slice, got %+v", events)
	}
}

func TestReadFile_SkipsMalformedLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace.jsonl")
	if err := AppendToFile(path, Event{Key: "ok", Stage: StageRoute}); err != nil {
		t.Fatalf("AppendToFile: %v", err)
	}
	// Simulate a partial/corrupt write by appending a raw non-JSON line.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open for corrupt append: %v", err)
	}
	if _, err := f.WriteString("{not valid json\n"); err != nil {
		t.Fatalf("write corrupt line: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close after corrupt append: %v", err)
	}
	if err := AppendToFile(path, Event{Key: "ok", Stage: StageDelivery}); err != nil {
		t.Fatalf("AppendToFile: %v", err)
	}

	events, err := ReadFile(path, "ok")
	if err != nil {
		t.Fatalf("ReadFile should skip the malformed line rather than error: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("len(events) = %d, want 2 (malformed line skipped)", len(events))
	}
}

func TestStore_KeysAreIndependent(t *testing.T) {
	s := NewStore(0)
	s.Record(Event{Key: "a", Stage: StageRoute})
	s.Record(Event{Key: "b", Stage: StageDelivery})
	if len(s.Trace("a")) != 1 || len(s.Trace("b")) != 1 {
		t.Fatal("events for one key must not leak into another key's trace")
	}
}

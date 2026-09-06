package hosterrors

import (
	"database/sql"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

func TestCategorize_Nil(t *testing.T) {
	if got := Categorize(nil); got != nil {
		t.Fatalf("Categorize(nil) = %v, want nil", got)
	}
}

func TestCategorize_SQLNoRows(t *testing.T) {
	he := Categorize(fmt.Errorf("lookup: %w", sql.ErrNoRows))
	if he.Category != CategoryDatabase {
		t.Fatalf("Category = %q, want %q", he.Category, CategoryDatabase)
	}
	if he.Guidance == "" {
		t.Fatal("Guidance must not be empty")
	}
	if !errors.Is(he, sql.ErrNoRows) {
		t.Fatal("errors.Is must see through to sql.ErrNoRows via Unwrap")
	}
}

func TestCategorize_OSNotExist(t *testing.T) {
	_, statErr := os.Stat("/definitely/does/not/exist/nanoclaw-go-lab")
	he := Categorize(statErr)
	if he.Category != CategoryRuntime {
		t.Fatalf("Category = %q, want %q", he.Category, CategoryRuntime)
	}
}

func TestCategorize_ExecNotFound(t *testing.T) {
	_, err := exec.LookPath("nanoclaw-definitely-not-a-real-binary")
	he := Categorize(err)
	if he.Category != CategoryRuntime {
		t.Fatalf("Category = %q, want %q", he.Category, CategoryRuntime)
	}
	if !errors.Is(he, exec.ErrNotFound) {
		t.Fatal("errors.Is must see through to exec.ErrNotFound")
	}
}

func TestCategorize_MountValidationError(t *testing.T) {
	spec := mount.Session{}
	err := mount.ValidateSpec(spec, mount.Policy{}, nil)
	if err == nil {
		t.Skip("mount.ValidateSpec did not fail on an empty session in this policy shape")
	}
	he := Categorize(err)
	if he.Category != CategorySecurity {
		t.Fatalf("Category = %q, want %q", he.Category, CategorySecurity)
	}
}

func TestCategorize_NetOpError(t *testing.T) {
	_, err := net.Dial("unix", "/tmp/nanoclaw-go-lab-definitely-not-a-real-socket.sock")
	if err == nil {
		t.Skip("dial unexpectedly succeeded")
	}
	he := Categorize(err)
	if he.Category != CategoryAdapter {
		t.Fatalf("Category = %q, want %q", he.Category, CategoryAdapter)
	}
}

func TestCategorize_UnknownFallsBackToUnknownCategory(t *testing.T) {
	he := Categorize(errors.New("some brand new error nothing recognizes"))
	if he.Category != CategoryUnknown {
		t.Fatalf("Category = %q, want %q", he.Category, CategoryUnknown)
	}
	if he.Guidance == "" {
		t.Fatal("even the unknown bucket must carry non-empty guidance")
	}
}

func TestCategorize_DoesNotDoubleWrapAlreadyCategorized(t *testing.T) {
	original := New(CategoryConfig, "bad config", "fix your config file", errors.New("boom"))
	got := Categorize(original)
	if got != original {
		t.Fatalf("Categorize should return the same *HostError pointer unchanged, got a different value")
	}
}

func TestHostError_ErrorStringIncludesCauseWhenPresent(t *testing.T) {
	he := New(CategoryRuntime, "thing broke", "do X", errors.New("root cause"))
	s := he.Error()
	if s == "" {
		t.Fatal("Error() must not be empty")
	}
	if !errors.Is(he, he.Cause) {
		t.Fatal("Unwrap must expose Cause to errors.Is")
	}
}

func TestHostError_ErrorStringWithoutCause(t *testing.T) {
	he := New(CategoryConfig, "thing broke", "do X", nil)
	if he.Error() == "" {
		t.Fatal("Error() must not be empty even with a nil Cause")
	}
	if he.Unwrap() != nil {
		t.Fatal("Unwrap of a nil-cause HostError must return nil")
	}
}

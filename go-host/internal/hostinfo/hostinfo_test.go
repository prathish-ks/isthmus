package hostinfo

import "testing"

func TestDescribe(t *testing.T) {
	got := Describe()
	want := "nanogo: minimal Go host scaffold (P3-01)"
	if got != want {
		t.Fatalf("Describe() = %q, want %q", got, want)
	}
}

func TestModuleName(t *testing.T) {
	if ModuleName == "" {
		t.Fatal("ModuleName must not be empty")
	}
}

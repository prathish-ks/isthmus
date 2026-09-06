package kernel

import (
	"strings"
	"testing"

	"github.com/prathish-ks/isthmus/go-host/internal/mount"
)

func TestContainerName_ShortKeyGetsPlainPrefix(t *testing.T) {
	key := mount.SessionKey{InstallSlug: "test", SessionID: "sess-1"}
	got := ContainerName(key)
	want := "ncl-test-sess-1"
	if got != want {
		t.Fatalf("ContainerName = %q, want %q", got, want)
	}
}

func TestContainerName_SanitizesIllegalCharacters(t *testing.T) {
	key := mount.SessionKey{InstallSlug: "te st!", SessionID: "sess/1"}
	got := ContainerName(key)
	if strings.ContainsAny(got, " !/") {
		t.Fatalf("ContainerName = %q, contains an illegal docker-name character", got)
	}
}

func TestContainerName_LongKeyTruncatesAndHashes(t *testing.T) {
	key := mount.SessionKey{
		InstallSlug: "an-install-slug-that-is-quite-long-indeed",
		SessionID:   "a-session-id-that-is-also-fairly-long",
	}
	got := ContainerName(key)
	if !strings.HasPrefix(got, "ncl-") {
		t.Fatalf("ContainerName = %q, want ncl- prefix", got)
	}
	if len(got) > 4+39+1+8 {
		t.Fatalf("ContainerName = %q (len %d), want truncated-plus-hash length", got, len(got))
	}
}

func TestContainerName_DistinctKeysWithSharedLongPrefixStayDistinct(t *testing.T) {
	base := "a-shared-prefix-that-is-long-enough-to-force-truncation-on-both"
	key1 := mount.SessionKey{InstallSlug: base, SessionID: "one"}
	key2 := mount.SessionKey{InstallSlug: base, SessionID: "two"}
	if ContainerName(key1) == ContainerName(key2) {
		t.Fatalf("two distinct keys sharing a long prefix produced the same container name: %q", ContainerName(key1))
	}
}

func TestContainerName_Deterministic(t *testing.T) {
	key := mount.SessionKey{InstallSlug: "test", SessionID: "sess-1"}
	first := ContainerName(key)
	second := ContainerName(key)
	if first != second {
		t.Fatalf("ContainerName is not deterministic for the same key: %q vs %q", first, second)
	}
}

func TestLabelsForKey_CarriesAllFourCanonicalLabels(t *testing.T) {
	key := mount.SessionKey{InstallSlug: "inst", AgentGroupID: "ag-1", SessionID: "sess-1"}
	labels := LabelsForKey(key, "agent", nil)
	want := map[string]string{
		"nanoclaw-install": "inst",
		"nanoclaw-group":   "ag-1",
		"nanoclaw-session": "sess-1",
		"nanoclaw-role":    "agent",
	}
	for k, v := range want {
		if labels[k] != v {
			t.Fatalf("labels[%q] = %q, want %q (full: %v)", k, labels[k], v, labels)
		}
	}
}

func TestLabelsForKey_ExtraLayersOnTopWithoutDroppingCanonical(t *testing.T) {
	key := mount.SessionKey{InstallSlug: "inst", AgentGroupID: "ag-1", SessionID: "sess-1"}
	labels := LabelsForKey(key, "agent", map[string]string{mount.GroupFolderLabel: "ag-1-folder"})
	if labels[mount.GroupFolderLabel] != "ag-1-folder" {
		t.Fatalf("extra label not carried through: %v", labels)
	}
	if labels["nanoclaw-group"] != "ag-1" {
		t.Fatalf("canonical label dropped when extra was applied: %v", labels)
	}
}

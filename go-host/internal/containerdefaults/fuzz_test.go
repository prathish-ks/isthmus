package containerdefaults

// P9-02 (Phase 9/10 hardening): fuzz target #3 of 5 — capability/resource
// inputs. EnforceSafeDefaults is the composed gate P5-03 introduced
// specifically to "reject unsafe requested settings rather than silently
// accepting them" (see the package doc comment) — a SessionSpec's
// runAs/resources fields arrive from the same untrusted-composition path
// mount.ValidateSpec guards, so this fuzzer targets the numeric/pointer
// inputs that class of gate is weakest against: overflow-shaped ints,
// negative values, and the nil-vs-zero-vs-negative distinction Resources'
// pointer fields exist to preserve. The property under test is simple and
// absolute: EnforceSafeDefaults must never panic, and it must never return
// nil (accept) for a root identity (uid==0 or gid==0 when Set) or a
// non-positive resource limit that was actually specified — those are its
// entire reason for existing (ValidateRunAs/ValidateResources's own doc
// comments).
import "testing"

func FuzzEnforceSafeDefaults(f *testing.F) {
	f.Add(0, 0, true, int64(0), int64(0), int64(0), "")
	f.Add(1000, 1000, true, int64(512), int64(64), int64(64), "1.5")
	f.Add(-1, -1, true, int64(-1), int64(-1), int64(-1), "-1")
	f.Add(0, 0, false, int64(0), int64(0), int64(0), "")
	f.Add(1<<31, 1<<31, true, int64(1<<62), int64(1<<62), int64(1<<62), "999999999999999999999")

	f.Fuzz(func(t *testing.T, uid, gid int, set bool, memoryMB, pidsLimit, shmSizeMB int64, cpus string) {
		runAs := RunAs{UID: uid, GID: gid, Set: set}

		// Reconstruct the nil-vs-pointer distinction Resources actually
		// uses: fuzzing can't produce *int directly, so treat a sentinel
		// (math.MinInt64) as "field omitted" to still exercise the nil path
		// alongside real values, without every fuzz case being forced to
		// specify all three.
		var memPtr, pidsPtr, shmPtr *int
		if memoryMB != -9223372036854775808 {
			v := int(memoryMB)
			memPtr = &v
		}
		if pidsLimit != -9223372036854775808 {
			v := int(pidsLimit)
			pidsPtr = &v
		}
		if shmSizeMB != -9223372036854775808 {
			v := int(shmSizeMB)
			shmPtr = &v
		}
		var cpusPtr *string
		if cpus != "" {
			cpusPtr = &cpus
		}
		resources := Resources{MemoryMB: memPtr, PidsLimit: pidsPtr, ShmSizeMB: shmPtr, CPUs: cpusPtr}

		err := EnforceSafeDefaults(runAs, resources)

		if set && (uid == 0 || gid == 0) && err == nil {
			t.Fatalf("EnforceSafeDefaults accepted root identity uid=%d gid=%d set=%v", uid, gid, set)
		}
		if pidsPtr != nil && *pidsPtr <= 0 && err == nil {
			t.Fatalf("EnforceSafeDefaults accepted non-positive pidsLimit=%d", *pidsPtr)
		}
		if memPtr != nil && *memPtr <= 0 && err == nil {
			t.Fatalf("EnforceSafeDefaults accepted non-positive memoryMB=%d", *memPtr)
		}
		if shmPtr != nil && *shmPtr <= 0 && err == nil {
			t.Fatalf("EnforceSafeDefaults accepted non-positive shmSizeMB=%d", *shmPtr)
		}

		// Downstream argv builders must never panic either, on whatever
		// this run's (runAs, resources) pair happens to be — including the
		// rejected ones, since a caller could in principle call these
		// argv-only helpers directly (they are exported) without going
		// through EnforceSafeDefaults first.
		_ = UserArgs(runAs)
		_ = ResourceArgs(resources)
		_ = PidsLimitArg(resources)
	})
}

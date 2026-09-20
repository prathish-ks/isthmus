//go:build windows

package kernel

import (
	"fmt"
	"os"
)

// acquireServeLock on Windows: no real advisory lock, by design — see
// lock_unix.go's doc comment for the full rationale (flock/LOCK_EX/LOCK_NB
// don't exist in Go's Windows syscall package, and nanogo serve was never
// a real Windows runtime target; go-host-os-matrix's CI job already skips
// `go test` on windows-latest for the same reason, WSL2 being the expected
// POSIX environment there instead). This still opens/creates the lock file
// so the exported surface matches lock_unix.go's exactly, but a second
// concurrent `nanogo serve` on native Windows would NOT be rejected the
// way it is on the real target platforms — a disclosed gap, not a
// silent claim of protection this build can't actually provide.
func acquireServeLock(socketPath string) (*os.File, error) {
	lockPath := socketPath + ".lock"
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("kernel: open lock file %s: %w", lockPath, err)
	}
	return f, nil
}

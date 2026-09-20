//go:build !windows

package kernel

import (
	"fmt"
	"os"
	"syscall"
)

// acquireServeLock takes an exclusive, non-blocking flock on
// socketPath+".lock" so a second `nanogo serve` invocation targeting the
// same socket path fails loudly instead of silently stealing the socket
// out from under a still-running kernel. Without this, Serve's own
// os.Remove+net.Listen lets two independent kernel processes each
// successfully unlink and rebind the same path in turn — the second wins
// with no error at all, the first is silently orphaned (still holding
// stale registry/executor state), and every future request racily lands
// on whichever kernel happened to bind last. For a trust kernel, a
// silently-swappable control socket is a real integrity gap, not just a
// reliability one: it means the security boundary itself can be replaced
// without anything — the operator, the TS host, a log line — noticing.
// flock rather than a PID file deliberately: a stale lock from a
// hard-killed process is released by the kernel automatically when the fd
// closes, with no manual cleanup step to forget (see restart_test.go's
// TestServe_RestartOverSameSocketPath_* for the legitimate
// stop-then-restart case this must not block — it doesn't, since the
// prior Serve's deferred Close releases the lock before a new one runs).
//
// Unix-only (see lock_windows.go): syscall.Flock/LOCK_EX/LOCK_NB don't
// exist in Go's Windows syscall package, and nanogo serve was never a
// real Windows runtime target in the first place — go-host-os-matrix's
// own CI comments already document WSL2 as the expected POSIX
// environment there, the same "disclosed gap, not a failure" stance
// internal/egress takes for its own Linux-only mechanism.
func acquireServeLock(socketPath string) (*os.File, error) {
	lockPath := socketPath + ".lock"
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("kernel: open lock file %s: %w", lockPath, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("kernel: another nanogo serve is already running against %s (lock held on %s) — refusing to start a second instance against the same socket", socketPath, lockPath)
	}
	return f, nil
}

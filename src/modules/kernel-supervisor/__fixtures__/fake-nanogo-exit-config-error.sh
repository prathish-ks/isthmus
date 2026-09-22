#!/usr/bin/env bash
# Always exits 78 (EX_CONFIG) immediately, like the real nanogo does for
# kernel.ErrSocketPathTooLong (go-host/cmd/nanogo/serve.go's
# exitCodeForServeErr). Never opens the socket, never retried — simulates
# the non-retryable-configuration-error path kernel-supervisor's
# EXIT_CONFIG_ERROR handling exists for.
set -e
echo "simulated config error: socket path too long" >&2
exit 78

#!/usr/bin/env bash
# Test fixture standing in for a healthy `nanogo serve`: parses -kernel-socket
# out of argv (matching cmd/nanogo/serve.go's real flag), creates that socket
# path after a short delay, then blocks until signaled — exiting 0 on SIGTERM
# like a graceful server shutdown, and removing the socket file first (the
# real kernel's listener close does the equivalent cleanup).
set -e
SOCKET=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-kernel-socket" ]; then
    SOCKET="$2"
    shift
  fi
  shift
done
trap 'rm -f "$SOCKET"; exit 0' TERM
sleep 0.2
mkdir -p "$(dirname "$SOCKET")"
touch "$SOCKET"
while true; do sleep 0.1; done

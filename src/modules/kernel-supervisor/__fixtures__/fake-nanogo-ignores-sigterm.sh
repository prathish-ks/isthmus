#!/usr/bin/env bash
# Simulates a hung/misbehaving nanogo that ignores SIGTERM entirely, to
# prove the supervisor's SIGKILL escalation actually fires and stop() does
# not hang forever.
set -e
SOCKET=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-kernel-socket" ]; then
    SOCKET="$2"
    shift
  fi
  shift
done
trap '' TERM
sleep 0.1
mkdir -p "$(dirname "$SOCKET")"
touch "$SOCKET"
while true; do sleep 0.1; done

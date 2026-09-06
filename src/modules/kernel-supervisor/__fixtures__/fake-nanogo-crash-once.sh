#!/usr/bin/env bash
# Crashes immediately on its first invocation (tracked via a marker file at
# $NANOCLAW_KERNEL_CRASH_MARKER, set by the test), behaves like the normal
# fixture on every invocation after that.
set -e
SOCKET=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-kernel-socket" ]; then
    SOCKET="$2"
    shift
  fi
  shift
done
MARKER="${NANOCLAW_KERNEL_CRASH_MARKER:?NANOCLAW_KERNEL_CRASH_MARKER must be set by the test}"
if [ ! -f "$MARKER" ]; then
  touch "$MARKER"
  echo "simulated crash" >&2
  exit 1
fi
trap 'rm -f "$SOCKET"; exit 0' TERM
sleep 0.1
mkdir -p "$(dirname "$SOCKET")"
touch "$SOCKET"
while true; do sleep 0.1; done

#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Root setup requires exactly one command" >&2
  exit 2
fi

# PID 1 owns Docker's immutable container configuration. Do not trust the
# caller's environment: the node user can replace it before invoking sudo.
# Tests may point this at a fixture file; production always reads PID 1.
read_pid1_environ() {
  if [ -n "${ORKESTRATOR_PID1_ENVIRON:-}" ]; then
    cat "$ORKESTRATOR_PID1_ENVIRON"
    return
  fi
  # PID 1 runs as node, and the kernel gates /proc/<pid>/environ on a ptrace
  # check: a different uid needs CAP_SYS_PTRACE, which Docker drops, so even
  # root is denied. Read it with PID 1's own credentials instead.
  setpriv --reuid="$(stat -c %u /proc/1)" --regid="$(stat -c %g /proc/1)" \
    --clear-groups cat /proc/1/environ
}
network_mode=$(read_pid1_environ | tr '\0' '\n' | sed -n 's/^NETWORK_MODE=//p' | head -n 1)
if [ "${network_mode:-restricted}" != "full" ]; then
  echo "Root project setup is disabled in restricted-network environments" >&2
  exit 1
fi

exec /bin/bash -lc "$1"

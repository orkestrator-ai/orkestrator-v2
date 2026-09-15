#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Root setup requires exactly one command" >&2
  exit 2
fi

# PID 1 owns Docker's immutable container configuration. Do not trust the
# caller's environment: the node user can replace it before invoking sudo.
# Tests may point this at a fixture file; production always reads PID 1.
pid1_environ="${ORKESTRATOR_PID1_ENVIRON:-/proc/1/environ}"
network_mode=$(tr '\0' '\n' < "$pid1_environ" | sed -n 's/^NETWORK_MODE=//p' | head -n 1)
if [ "${network_mode:-restricted}" != "full" ]; then
  echo "Root project setup is disabled in restricted-network environments" >&2
  exit 1
fi

exec /bin/bash -lc "$1"

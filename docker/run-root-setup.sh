#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Root setup requires exactly one command" >&2
  exit 2
fi

if ! IFS= read -r network_mode < /etc/orkestrator/network-mode || [ "${network_mode:-}" != "full" ]; then
  echo "Root project setup is disabled in restricted-network environments" >&2
  exit 1
fi

exec /bin/bash -lc "$1"

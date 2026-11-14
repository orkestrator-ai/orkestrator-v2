#!/usr/bin/env bash
# Runs apps/backend/tests/codex-managed-network-card-live.test.ts (to-do 0723
# task 7): the Codex managed-network approval card through the real bridge,
# the backend's card mapping and the permission-rule enforcer.
#
# Codex only asks about a host when `/etc/codex/requirements.toml` enables its
# network proxy, a file no test may write on a real machine. So this runs in a
# disposable container: the repository is mounted read-only, the pinned Linux
# Codex is downloaded inside it, and each test's CODEX_HOME is a temporary
# directory holding a made-up key. A loopback server plays the model and the
# probe host, which `--add-host` points at loopback; `allow_local_binding`
# lets an approved request reach it. No login and no credits are involved.
# Privileged only because Codex's bubblewrap sandbox needs user namespaces.
#
# On a shared host, point Docker at a disposable daemon first:
#   mise run docker:disposable -- start --name <name>
#   eval "$(mise run docker:disposable -- env --name <name>)"
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
image="oven/bun:$(sed -n 's/^bun = "\(.*\)"$/\1/p' "$repo/mise.toml" | head -n 1)"

docker run --rm --privileged --add-host probe-host.example.test:127.0.0.1 \
  --volume "$repo:/repo:ro" --workdir /repo --env DEBIAN_FRONTEND=noninteractive "$image" bash -euc '
  apt-get update -qq >/dev/null
  apt-get install -y -qq bubblewrap curl ca-certificates >/dev/null
  mkdir -p /etc/codex
  printf "[network_proxy]\nenabled = true\nallow_local_binding = true\n" >/etc/codex/requirements.toml
  bun scripts/download-agent.ts codex --dir /tmp/codex
  cd apps/backend
  RUN_LIVE_CODEX_MANAGED_NETWORK_CARD=1 CODEX_PROTOCOL_BINARY=/tmp/codex/codex TMPDIR=/tmp \
    bun test --preload ../../tests/setup-node.ts ./tests/codex-managed-network-card-live.test.ts \
    --timeout 300000
'

#!/usr/bin/env bash
# Runs the managed-network half of live-policy-amendment.test.ts (todo 0160).
#
# Codex only asks about a host when `/etc/codex/requirements.toml` enables its
# network proxy, a file no test may write on a real machine. So this runs in a
# disposable container: the repository is mounted read-only, the pinned Linux
# Codex is downloaded inside it, and CODEX_HOME is a temporary directory. A
# loopback server plays the model, so no login and no credits are involved.
# Privileged only because Codex's bubblewrap sandbox needs user namespaces.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
image="oven/bun:$(sed -n 's/^bun = "\(.*\)"$/\1/p' "$repo/mise.toml" | head -n 1)"

docker run --rm --privileged --volume "$repo:/repo:ro" --workdir /repo --env DEBIAN_FRONTEND=noninteractive "$image" bash -euc '
  apt-get update -qq >/dev/null
  apt-get install -y -qq bubblewrap curl ca-certificates >/dev/null
  mkdir -p /etc/codex
  printf "[network_proxy]\nenabled = true\n" >/etc/codex/requirements.toml
  bun scripts/download-agent.ts codex --dir /tmp/codex
  RUN_LIVE_CODEX_NETWORK_APPROVAL=1 CODEX_PROTOCOL_BINARY=/tmp/codex/codex TMPDIR=/tmp \
    bun test bridges/codex-bridge/src/app-server/live-policy-amendment.test.ts --timeout 300000
'

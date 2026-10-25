#!/usr/bin/env bash
# A real monorepo build of the source tree in /home/node/src (this
# repository's HEAD): a cold `bun install` (the container's Bun cache starts
# empty; the user's own caches are never touched), a warm reinstall from that
# cache, a Turbo typecheck of every workspace and a Vite production build.
# Prints one JSON line of step durations and exit codes; logs stay inside.
set -u
cd /home/node/src
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
now() { date +%s%3N; }
# An image older than the checkout can ship an older Bun (one without
# `bun check`, say): install the checkout's pinned Bun into this throwaway
# container first, untimed, and say so in the result.
pinned=$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' package.json)
bun_replaced=false
if [[ -n "$pinned" && "$(bun --version)" != "$pinned" ]]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$pinned" > /tmp/w/build-bun.log 2>&1 \
    && export PATH="$HOME/.bun/bin:$PATH" && bun_replaced=true
fi
results=""
step() {
  local name=$1 started rc
  shift
  started=$(now)
  bash -c "$*" > "/tmp/w/build-$name.log" 2>&1
  rc=$?
  results+="\"${name}Ms\":$(( $(now) - started )),\"${name}Exit\":$rc,"
}
step installCold "bun install --frozen-lockfile && bun install --frozen-lockfile --cwd bridges/claude-bridge"
step installWarm "find . -name node_modules -type d -prune -exec rm -rf {} + && bun install --frozen-lockfile && bun install --frozen-lockfile --cwd bridges/claude-bridge"
step typecheck "bunx turbo run typecheck"
step webBuild "cd apps/web && bunx vite build"
printf '{"workload":"build",%s"bunVersion":"%s","bunReplaced":%s,"cpusVisible":%d}\n' "$results" "$(bun --version)" "$bun_replaced" "$(nproc)"

#!/bin/sh
# Tells the backend that /tmp/.claude-state changed.
#
# Claude state signal contract (docker/image-manifest.ts):
# ORKESTRATOR_CAPABILITY claude-state-signal=1
#
#   orkestrator-state-signal
#
# The Claude Code hooks the entrypoint installs call this right after writing
# the state file. The request carries no state: the backend answers it by
# reading the file itself, so a late or reordered request cannot report a
# stale value. The backend writes the curl config (its URL and a bearer token
# for this container's poll) to /tmp/.orkestrator-claude-state-signal. Without
# that file, or with the backend unreachable, this does nothing and the
# backend's slow safety read still sees the change.
#
# It never blocks or fails its caller. A hook that exits non-zero shows an
# error in Claude, and one that waits on the network holds up the turn, so the
# request runs detached with every descriptor closed and this exits 0 (the
# status of a background command).
config="${ORKESTRATOR_STATE_SIGNAL_CONFIG:-/tmp/.orkestrator-claude-state-signal}"
[ -r "$config" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
curl --config "$config" --request POST --silent --fail --noproxy '*' \
  --connect-timeout 2 --max-time 3 --output /dev/null </dev/null >/dev/null 2>&1 &

#!/bin/bash
# Runs inside a disposable container as `node`, started by
# scripts/qualify-opencode-seeded-data.sh. Seeds what entrypoint.sh used to
# copy from a host's /opencode-data (account.json, storage/, snapshot/), watches
# OpenCode's whole data directory with inotify, and drives one real turn
# against a local mock model: a `write` tool call, the session diff, a revert
# and an unrevert. Prints a summary and `RESULT key=value` lines.
#
#   probe.sh <volume|legacy> <migrated|unmigrated|none>
#
# volume: OPENCODE_DB on its own directory, as on persistent storage; legacy:
# OpenCode's default database path. migrated: the seed includes
# storage/migration (a current host); unmigrated: it does not (an old host);
# none: nothing is seeded, which is what a container gets now.
set -euo pipefail
MODE="${1:?mode: volume or legacy}"
SEED="${2:?seed: migrated, unmigrated or none}"
PROBE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$HOME/.local/share/opencode"
WORK="$(mktemp -d)"
REPO="$(mktemp -d)/repo"
PORT=4096
mkdir -p "$DATA" "$HOME/.config/opencode" "$REPO"

commit() { git -C "$REPO" -c user.name=probe -c user.email=probe@example.invalid commit -q "$@"; }
git -C "$REPO" init -q -b main
commit --allow-empty -m root
printf 'tracked\n' > "$REPO/tracked.txt"
git -C "$REPO" add tracked.txt
commit -m tracked
# OpenCode's project id is the root commit, which a host checkout of the same
# repository shares; a snapshot directory below it is keyed by the worktree
# path, which on a host is never the container's.
ROOT_SHA="$(git -C "$REPO" rev-list --max-parents=0 HEAD)"

: > "$WORK/seeded.txt"
if [ "$SEED" != none ]; then
    printf '{"accounts":[],"active":null}\n' > "$DATA/account.json"
    mkdir -p "$DATA/storage/session_diff" "$DATA/storage/project" \
        "$DATA/storage/session/$ROOT_SHA" "$DATA/storage/message/ses_hostseed" \
        "$DATA/storage/part/msg_hostseed"
    [ "$SEED" = unmigrated ] || printf 2 > "$DATA/storage/migration"
    printf '[]\n' > "$DATA/storage/session_diff/ses_hostseed.json"
    printf '{"id":"%s","vcs":"git","worktree":"/Users/host/project","time":{"created":1,"initialized":1}}\n' \
        "$ROOT_SHA" > "$DATA/storage/project/$ROOT_SHA.json"
    printf '{"id":"ses_hostseed","projectID":"%s","directory":"/Users/host/project","title":"host","version":"1.0.0","time":{"created":1,"updated":1}}\n' \
        "$ROOT_SHA" > "$DATA/storage/session/$ROOT_SHA/ses_hostseed.json"
    printf '{"id":"msg_hostseed","sessionID":"ses_hostseed","role":"user","time":{"created":1}}\n' \
        > "$DATA/storage/message/ses_hostseed/msg_hostseed.json"
    printf '{"id":"prt_hostseed","sessionID":"ses_hostseed","messageID":"msg_hostseed","type":"text","text":"host"}\n' \
        > "$DATA/storage/part/msg_hostseed/prt_hostseed.json"
    host_hash="$(printf '/Users/host/project' | sha1sum | cut -d' ' -f1)"
    for snapshot_dir in "$DATA/snapshot/$ROOT_SHA/$host_hash" "$DATA/snapshot/$ROOT_SHA-older-layout"; do
        mkdir -p "$snapshot_dir"
        git --git-dir="$snapshot_dir" init -q
    done
    find "$DATA/account.json" "$DATA/storage" "$DATA/snapshot" -print | sort > "$WORK/seeded.txt"
fi

cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{
  "provider": {
    "mock": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Mock",
      "options": { "baseURL": "http://127.0.0.1:4010/v1", "apiKey": "mock" },
      "models": { "m": { "name": "Mock", "tool_call": true } }
    }
  },
  "model": "mock/m",
  "small_model": "mock/m",
  "permission": { "edit": "allow", "bash": "allow", "external_directory": "allow" },
  "share": "disabled",
  "autoupdate": false
}
JSON

if [ "$MODE" = volume ]; then
    mkdir -p "$DATA/orkestrator-db"
    export OPENCODE_DB="$DATA/orkestrator-db/opencode.db"
fi
export OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1

inotifywait -m -r -q -e open,access,modify,attrib,close_write,create,delete,moved_from,moved_to \
    --format '%e %w%f' "$DATA" > "$WORK/events.txt" 2> "$WORK/inotify.err" &
INOTIFY=$!
sleep 1
MOCK_WRITE_PATH="$REPO/written.txt" bun "$PROBE_DIR/mock-llm.js" 2> "$WORK/mock.err" &
MOCK=$!
cd "$REPO"
opencode serve --port "$PORT" --hostname 127.0.0.1 > "$WORK/serve.out" 2>&1 &
SERVE=$!
cleanup() { kill "$SERVE" "$MOCK" "$INOTIFY" 2>/dev/null || true; }
trap cleanup EXIT

api() { curl -sS --max-time 120 -H 'content-type: application/json' "$@"; }
base="http://127.0.0.1:$PORT"
for _ in $(seq 1 150); do
    api "$base/global/health" > "$WORK/health.json" 2>/dev/null && break
    sleep 0.2
done
written() { [ -f "$REPO/written.txt" ] && echo yes || echo no; }

session="$(api -X POST -d '{}' "$base/session" | jq -r .id)"
api -X POST -d '{"parts":[{"type":"text","text":"write the file"}],"model":{"providerID":"mock","modelID":"m"}}' \
    "$base/session/$session/message" > "$WORK/turn.json"
api "$base/session/$session/message" > "$WORK/messages.json"
user_message="$(jq -r '[.[] | select(.info.role == "user")][0].info.id' "$WORK/messages.json")"
api "$base/session/$session/diff?messageID=$user_message" > "$WORK/diff.json"
after_turn="$(written)"
api -X POST -d "{\"messageID\":\"$user_message\"}" "$base/session/$session/revert" > /dev/null
after_revert="$(written)"
api -X POST "$base/session/$session/unrevert" > /dev/null
after_unrevert="$(written)"
api "$base/session" > "$WORK/sessions.json"
sleep 1
cleanup
wait "$SERVE" 2>/dev/null || true
trap - EXIT

# A seeded path is one that existed before OpenCode started.
seeded_events="$(awk 'NR==FNR { seeded[$0]=1; next }
    { path=$2; sub(/\/$/, "", path); if (path in seeded) print $1, path }' \
    "$WORK/seeded.txt" "$WORK/events.txt" | sort | uniq -c | sort -rn)"
opened_seeded() {
    awk -v prefix="$1" 'NR==FNR { seeded[$0]=1; next }
        $1 ~ /^OPEN/ { path=$2; sub(/\/$/, "", path); if ((path in seeded) && index(path, prefix) == 1) n++ }
        END { print n + 0 }' "$WORK/seeded.txt" "$WORK/events.txt"
}
turn="$(jq -r '.info.finish // .info.error.name // "unknown"' "$WORK/turn.json")"
tools="$(jq -r '[.[] | .parts[] | select(.type == "tool") | "\(.tool):\(.state.status)"] | join(",")' "$WORK/messages.json")"
diff_files="$(jq -r '[.[]?.file] | join(",")' "$WORK/diff.json")"
host_session_listed="$(jq -r '[.[].id] | index("ses_hostseed") != null' "$WORK/sessions.json")"

echo "== mode=$MODE seed=$SEED opencode=$(opencode --version) health=$(jq -c . "$WORK/health.json")"
echo "turn=$turn tools=$tools diff=$diff_files written: turn=$after_turn revert=$after_revert unrevert=$after_unrevert"
echo "-- events on seeded paths (count event path):"
echo "${seeded_events:-  (none)}"
echo "RESULT mode=$MODE"
echo "RESULT seed=$SEED"
echo "RESULT turn=$turn"
echo "RESULT tools=$tools"
echo "RESULT diff=$diff_files"
echo "RESULT written=$after_turn,$after_revert,$after_unrevert"
echo "RESULT host_session_listed=$host_session_listed"
echo "RESULT opened_account=$(opened_seeded "$DATA/account.json")"
echo "RESULT opened_snapshot=$(opened_seeded "$DATA/snapshot/")"
echo "RESULT opened_storage_migration=$(opened_seeded "$DATA/storage/migration")"
echo "RESULT opened_storage_other=$(( $(opened_seeded "$DATA/storage/") - $(opened_seeded "$DATA/storage/migration") ))"

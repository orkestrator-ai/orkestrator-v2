#!/bin/bash
# C13 qualification: a native-agent conversation survives a preserving
# rebuild of its container. Uses real provider credentials of an isolated
# agent-test profile (never a production instance) and a scoped, harmless
# prompt: a codeword the agent is asked to repeat after the rebuild.
#
#   scripts/qualify-session-resume.sh <profile> <agent> [environment-name]
#
# Exits 0 when the session answered with the codeword after the rebuild on a
# new runtime generation, 1 when it did not, 2 on setup errors. Prints no
# transcript text beyond the pass/fail line.
set -euo pipefail

PROFILE="${1:?usage: qualify-session-resume.sh <profile> <agent> [environment-name]}"
AGENT="${2:?agent: claude, codex, cursor, grok, opencode or pi}"
ENVIRONMENT_NAME="${3:-fixture-container}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ORKESTRATOR_CLI_CONFIG_DIR="${ORKESTRATOR_CLI_CONFIG_DIR:-$(mktemp -d)/orkestrator-cli}"
ork() { bun "$ROOT/packages/cli/bin/orkestrator.js" --profile "$PROFILE" "$@"; }

CODEWORD="ORK-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | tr 'a-f' 'A-F')"

environment="$(ork environment list --json | jq -r --arg name "$ENVIRONMENT_NAME" '.result.items[] | select(.name == $name) | .id' | head -n 1)"
[ -n "$environment" ] || { echo "setup: no environment named $ENVIRONMENT_NAME" >&2; exit 2; }
ork environment start "$environment" --wait ready --timeout 10m >/dev/null

# Completion is observed from the session itself (idle, with a non-empty
# assistant reply), because the public CLI reports completion only for
# providers qualified there.
wait_for_reply() {
    local replies="$1" deadline=$(( $(date +%s) + 300 ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        local activity count
        activity="$(ork session get "$session" --json | jq -r '.result.activity')"
        count="$(ork session transcript "$session" --json \
            | jq '[.result.messages[]? | select(.role == "assistant")
                   | select((((.text // "") | tostring) + ([.parts[]? | .text? // empty | tostring] | join(""))) | length > 0)] | length')"
        if [ "$activity" = idle ] && [ "$count" -ge "$replies" ]; then return 0; fi
        sleep 3
    done
    return 1
}

session="$(ork session start --environment "$environment" --agent "$AGENT" \
    --prompt "Remember this codeword for later: $CODEWORD. Reply with only the word OK." \
    --output id)" || { echo "setup: $AGENT session did not start" >&2; exit 2; }
wait_for_reply 1 || { echo "setup: first turn did not finish for $AGENT" >&2; exit 2; }

runtime_generation() {
    docker ps --filter "label=environment-id=$environment" --filter status=running \
        --format '{{.Label "orkestrator-runtime-generation"}}' | head -n 1
}
generation_before="$(runtime_generation)"
ork environment recreate "$environment" --wait ready --timeout 15m >/dev/null
generation_after="$(runtime_generation)"
if [ -z "$generation_after" ] || [ "$generation_after" = "$generation_before" ]; then
    echo "FAIL $AGENT: the rebuild did not produce a new runtime generation"
    exit 1
fi

ork session prompt "$session" \
    --prompt "What was the codeword I asked you to remember? Reply with only the codeword." \
    >/dev/null || { echo "FAIL $AGENT: the follow-up prompt was refused after the rebuild"; exit 1; }
wait_for_reply 2 || { echo "FAIL $AGENT: the follow-up turn did not finish after the rebuild"; exit 1; }

# The codeword appears once in the first prompt; a second occurrence is the
# answer given after the rebuild.
answers="$(ork session transcript "$session" --json | grep -o "$CODEWORD" | wc -l)"
if [ "$answers" -ge 2 ]; then
    echo "PASS $AGENT: session resumed with its history after the rebuild (runtime generation ${generation_before:-?} -> ${generation_after:-?})"
    exit 0
fi
echo "FAIL $AGENT: the session did not recall the codeword after the rebuild"
exit 1

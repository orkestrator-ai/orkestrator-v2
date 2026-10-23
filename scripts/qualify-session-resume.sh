#!/bin/bash
# C13 qualification: a native-agent conversation survives a preserving
# rebuild of its container. Uses real provider credentials of an isolated
# agent-test profile (never a production instance) and a scoped, harmless
# prompt: a codeword the agent is asked to repeat after the rebuild.
#
#   scripts/qualify-session-resume.sh <profile> <agent> [environment-name]
#
# Optional environment:
#   QUALIFY_MODEL, QUALIFY_REASONING  model/reasoning for the session (from
#       `orkestrator agent options`), for a profile whose default model the
#       provider login does not serve.
#   QUALIFY_AMBIGUOUS=1  after the resume passes, also prove that a prompt whose
#       dispatch outcome is unknown when the runtime is replaced stays
#       unresolved and is not re-sent to the provider. The prompt is made
#       ambiguous by dropping its request inside this environment's own
#       container (an iptables rule there, gone with the rebuild), so it is
#       written but never answered, and then rebuilding while it is in flight.
#
# Exits 0 when the session answered with the codeword after the rebuild on a
# new runtime generation (and, with QUALIFY_AMBIGUOUS=1, the ambiguous prompt
# stayed unresolved and unsent), 1 when it did not, 2 on setup errors. Prints
# no transcript text beyond the pass/fail line; progress goes to stderr.
set -euo pipefail

PROFILE="${1:?usage: qualify-session-resume.sh <profile> <agent> [environment-name]}"
AGENT="${2:?agent: claude, codex, cursor, grok, opencode or pi}"
ENVIRONMENT_NAME="${3:-fixture-container}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ORKESTRATOR_CLI_CONFIG_DIR="${ORKESTRATOR_CLI_CONFIG_DIR:-$(mktemp -d)/orkestrator-cli}"
ork() { bun "$ROOT/packages/cli/bin/orkestrator.js" --profile "$PROFILE" "$@"; }
# A provider's cold start can outlast the CLI's default 60 s request deadline
# on a loaded host; the submission then reads as transport-uncertain.
REQUEST_TIMEOUT=(--request-timeout "${QUALIFY_REQUEST_TIMEOUT:-5m}")

STARTED_AT="$(date +%s)"
progress() { echo "[resume $AGENT +$(( $(date +%s) - STARTED_AT ))s] $*" >&2; }

new_codeword() { echo "ORK-$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | tr 'a-f' 'A-F')"; }
CODEWORD="$(new_codeword)"

session_options=()
[ -n "${QUALIFY_MODEL:-}" ] && session_options+=(--model "$QUALIFY_MODEL")
[ -n "${QUALIFY_REASONING:-}" ] && session_options+=(--reasoning "$QUALIFY_REASONING")

environment="$(ork environment list --json | jq -r --arg name "$ENVIRONMENT_NAME" '.result.items[] | select(.name == $name) | .id' | head -n 1)"
[ -n "$environment" ] || { echo "setup: no environment named $ENVIRONMENT_NAME" >&2; exit 2; }
ork environment start "$environment" --wait ready --timeout 10m >/dev/null
progress "environment $environment ready"

runtime_container() {
    docker ps --filter "label=environment-id=$environment" --filter status=running \
        --format '{{.ID}}' | head -n 1
}
runtime_generation() {
    docker ps --filter "label=environment-id=$environment" --filter status=running \
        --format '{{.Label "orkestrator-runtime-generation"}}' | head -n 1
}

# Completion is observed from the session itself (idle, with a non-empty
# assistant reply), because the public CLI reports completion only for
# providers qualified there. A turn that stays idle with fewer non-empty
# replies than expected (for example a provider error the transcript does not
# carry) fails early instead of waiting out the deadline.
wait_for_reply() {
    local replies="$1" deadline=$(( $(date +%s) + 300 )) idle_short=0 polls=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
        local activity counts total nonempty
        activity="$(ork session get "$session" --json | jq -r '.result.activity')"
        counts="$(ork session transcript "$session" --json \
            | jq -r '[.result.messages[]? | select(.role == "assistant")] as $a
                   | "\($a | length) \([$a[] | select((((.text // "") | tostring) + ([.parts[]? | .text? // empty | tostring] | join(""))) | length > 0)] | length)"')"
        total="${counts% *}" nonempty="${counts#* }"
        if [ "$activity" = idle ] && [ "$nonempty" -ge "$replies" ]; then return 0; fi
        if [ "$activity" = idle ] && [ "$total" -ge "$replies" ]; then
            idle_short=$(( idle_short + 1 ))
            if [ "$idle_short" -ge 10 ]; then
                progress "turn ended idle with $nonempty non-empty of $total assistant messages"
                return 1
            fi
        else
            idle_short=0
        fi
        polls=$(( polls + 1 ))
        if [ $(( polls % 10 )) -eq 0 ]; then
            progress "waiting: activity=$activity assistant=$total non-empty=$nonempty"
        fi
        sleep 3
    done
    return 1
}

# Codex keeps its runtime databases on the state volume (CODEX_SQLITE_HOME).
# Report, for the session's own thread, whether its row is present in the
# relocated thread database, how many turns the relocated history database
# holds for it, and the databases' quick_check. Counts only, never content.
codex_database_evidence() {
    local container request
    container="$(runtime_container)"
    request="$(ork session get "$session" --json | jq -r '.result.latestRequestId // empty')"
    docker exec -u node -e "REQUEST_ID=$request" "$container" bun -e '
        import { Database } from "bun:sqlite";
        import { readdirSync, readFileSync } from "node:fs";
        const home = "/home/node/.codex/orkestrator-sqlite";
        const bridge = "/home/node/.codex/orkestrator-bridge";
        let thread = "";
        for (const name of readdirSync(bridge)) {
          if (!name.startsWith("dispatch-journal-")) continue;
          const journal = JSON.parse(readFileSync(`${bridge}/${name}`, "utf8"));
          const record = (journal.records ?? []).find((r) => r.requestId === process.env.REQUEST_ID);
          if (record?.threadId) thread = record.threadId;
        }
        const open = (file) => new Database(`${home}/${file}`, { readonly: true });
        const state = readdirSync(home).find((f) => /^state_\d+\.sqlite$/.test(f));
        const history = readdirSync(home).find((f) => /^thread_history_\d+\.sqlite$/.test(f));
        const stateDb = open(state);
        const historyDb = open(history);
        const threadRow = stateDb.query("select count(*) as n from threads where id = ?").get(thread).n;
        const turns = historyDb.query("select count(*) as n from thread_turns where thread_id = ?").get(thread).n;
        const check = (db) => db.query("pragma quick_check").get().quick_check;
        console.log(`thread=${thread ? "found" : "missing"} ${state}:thread-row=${threadRow} quick_check=${check(stateDb)} ${history}:turns=${turns} quick_check=${check(historyDb)}`);
    '
}
provider_state_evidence() {
    if [ "$AGENT" = codex ]; then
        progress "codex databases ($1): $(codex_database_evidence 2>&1 | tail -n 1)"
    fi
}

session="$(ork session start "${REQUEST_TIMEOUT[@]}" --environment "$environment" --agent "$AGENT" ${session_options[@]+"${session_options[@]}"} \
    --prompt "Remember this codeword for later: $CODEWORD. Reply with only the word OK." \
    --output id)" || { echo "setup: $AGENT session did not start" >&2; exit 2; }
progress "session $session started"
wait_for_reply 1 || { echo "setup: first turn did not finish for $AGENT" >&2; exit 2; }
progress "first turn finished"
provider_state_evidence "before rebuild"

container_before="$(runtime_container)"
generation_before="$(runtime_generation)"
progress "rebuilding (container $container_before, generation $generation_before)"
ork environment recreate "$environment" --wait ready --timeout 15m >/dev/null
container_after="$(runtime_container)"
generation_after="$(runtime_generation)"
progress "rebuilt (container $container_after, generation $generation_after)"
if [ -z "$generation_after" ] || [ "$generation_after" = "$generation_before" ]; then
    echo "FAIL $AGENT: the rebuild did not produce a new runtime generation"
    exit 1
fi
provider_state_evidence "after rebuild, before the follow-up"

ork session prompt "$session" "${REQUEST_TIMEOUT[@]}" \
    --prompt "What was the codeword I asked you to remember? Reply with only the codeword." \
    >/dev/null || { echo "FAIL $AGENT: the follow-up prompt was refused after the rebuild"; exit 1; }
wait_for_reply 2 || { echo "FAIL $AGENT: the follow-up turn did not finish after the rebuild"; exit 1; }
provider_state_evidence "after the follow-up"

# The codeword appears once in the first prompt; a second occurrence is the
# answer given after the rebuild.
answers="$(ork session transcript "$session" --json | grep -o "$CODEWORD" | wc -l)"
if [ "$answers" -lt 2 ]; then
    echo "FAIL $AGENT: the session did not recall the codeword after the rebuild"
    exit 1
fi
echo "PASS $AGENT: session resumed with its history after the rebuild (runtime generation ${generation_before:-?} -> ${generation_after:-?})"
[ "${QUALIFY_AMBIGUOUS:-0}" = 1 ] || exit 0

# --- Ambiguous dispatch across a rebuild -------------------------------------
# Inside this environment's own container, drop inbound packets that carry a
# bridge prompt request line. Every other bridge call (health, attach, status)
# still works, so the backend opens its dispatch window, writes the prompt
# request and gets no answer: its outcome is genuinely unknown to the backend,
# while the provider provably never received it. The rebuild then replaces the
# runtime (and the rule with it) while that request is in flight.
container="$(runtime_container)"
bridge_ports="$(docker port "$container" | awk -F/ '{ print $1 }' | sort -n | sed -n '1p;$p' | paste -sd: -)"
[ -n "$bridge_ports" ] || { echo "setup: no published bridge ports on $container" >&2; exit 2; }
AMBIGUOUS_CODEWORD="$(new_codeword)"
docker exec -u root "$container" iptables -I INPUT 1 -p tcp --dport "$bridge_ports" \
    -m string --algo bm --string "/prompt HTTP/1.1" -j DROP \
    || { echo "setup: could not hold prompt requests in $container" >&2; exit 2; }
progress "holding prompt requests to bridge ports $bridge_ports in $container so the next prompt's outcome is unknown"

ambiguous_out="$(mktemp)"
ork session prompt "$session" "${REQUEST_TIMEOUT[@]}" --json --request-id "c13-ambiguous-$(date +%s)-$$" \
    --prompt "Reply with only this word: $AMBIGUOUS_CODEWORD." >"$ambiguous_out" 2>/dev/null &
prompt_pid=$!
# Let the prompt request be written and held, then rebuild under it.
sleep 8
container_before="$(runtime_container)"
generation_before="$(runtime_generation)"
progress "rebuilding with the prompt in flight (generation $generation_before)"
ork environment recreate "$environment" --wait ready --timeout 15m >/dev/null
generation_after="$(runtime_generation)"
prompt_status=0
wait "$prompt_pid" || prompt_status=$?
progress "rebuilt (generation $generation_after); prompt exited $prompt_status with $(jq -c '{state: .receipt.state, dispatch: .receipt.dispatch.state, error: .error.code}' "$ambiguous_out" 2>/dev/null)"
if [ -z "$generation_after" ] || [ "$generation_after" = "$generation_before" ]; then
    echo "FAIL $AGENT: the rebuild under the ambiguous prompt did not produce a new runtime generation"
    exit 1
fi
operation="$(jq -r '.receipt.operationId // empty' "$ambiguous_out")"
dispatch_request="$(jq -r '.receipt.resources.dispatchRequestId // empty' "$ambiguous_out")"

# The parked dispatch must survive the rebuild as unresolved, stay unresolved
# after reconciliation (the 15 s grace and a later settle read), and never
# reach the provider.
sleep 20
check_unresolved() {
    local summary
    summary="$(ork session get "$session" --json | jq -c '.result.recoverableDispatch')"
    progress "recoverableDispatch ($1): $summary"
    [ "$(jq -r '.kind // empty' <<<"$summary")" = prompt ] || return 1
    [ "$(jq -r '.status // empty' <<<"$summary")" = action-required ] || return 1
    [ -n "$dispatch_request" ] && [ "$(jq -r '.requestId // empty' <<<"$summary")" = "$dispatch_request" ] || return 1
    # The transcript read also runs the backend's read-only settle.
    if ork session transcript "$session" --json | jq -e --arg w "$AMBIGUOUS_CODEWORD" \
        '[.result.messages[]? | select(.role == "assistant") | tostring | select(contains($w))] | length > 0' >/dev/null; then
        progress "an assistant message answered the ambiguous prompt"
        return 1
    fi
    local sent
    sent="$(docker exec "$(runtime_container)" sh -c \
        "grep -rlF '$AMBIGUOUS_CODEWORD' /home/node/.claude/projects /home/node/.codex/sessions /home/node/.pi/agent/sessions /home/node/.grok/sessions /tmp/orkestrator-cursor-sdk-state /tmp/orkestrator-pi-state /tmp/orkestrator-acp-state /home/node/.codex/orkestrator-bridge /home/node/.claude/orkestrator 2>/dev/null | wc -l")"
    progress "provider state files containing the ambiguous prompt ($1): $sent"
    [ "$sent" -eq 0 ]
}
check_unresolved "after rebuild" || { echo "FAIL $AGENT: the ambiguous prompt did not stay unresolved and unsent after the rebuild"; exit 1; }
[ -n "$operation" ] || { echo "FAIL $AGENT: the ambiguous prompt returned no operation"; exit 1; }
run_state() {
    ork run get "$operation" --json \
        | jq -c '.receipt | {state, stage, dispatch: .dispatch.state, recoverable: .dispatch.recoverable, error: .error.code}'
}
run_unknown() {
    local run
    run="$(run_state)"
    progress "run $operation ($1): $run"
    [ "$(jq -r '"\(.state) \(.dispatch) \(.recoverable)"' <<<"$run")" = "unknown unknown true" ]
}
run_unknown "after rebuild" || { echo "FAIL $AGENT: the ambiguous prompt's run did not stay unknown after the rebuild"; exit 1; }
# A new prompt must not replace or resend the parked one.
refused="$(ork session prompt "$session" --json --prompt "Reply with only the word OK." 2>/dev/null | jq -r '.error.code // "accepted"')" || true
progress "a new prompt while parked: $refused"
sleep 60
check_unresolved "60 s later" || { echo "FAIL $AGENT: the ambiguous prompt was resolved or re-sent after the rebuild"; exit 1; }
run_unknown "60 s later" || { echo "FAIL $AGENT: the ambiguous prompt's run was settled after the rebuild"; exit 1; }
[ "$refused" = dispatch-parked ] || { echo "FAIL $AGENT: a new prompt was accepted while the ambiguous one was parked"; exit 1; }
echo "PASS $AGENT: the ambiguous prompt stayed unresolved and unsent across the rebuild (runtime generation $generation_before -> $generation_after)"
exit 0

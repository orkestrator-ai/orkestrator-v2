#!/usr/bin/env bash
# AGENTS concurrent Claude Code CLIs, each running TURNS sequential print-mode
# turns against the local mock API (mock-anthropic.ts). Every turn makes real
# Bash and Read tool calls. Prints one JSON line of timings and exit codes.
set -u
AGENTS=${AGENTS:-3}
TURNS=${TURNS:-3}
cd /tmp/w
bun mock-anthropic.ts > /tmp/w/mock.out 2>/dev/null &
mock=$!
for _ in $(seq 1 50); do
  curl -s -o /dev/null -X POST http://127.0.0.1:8787/ && break
  read -r -t 0.1 <> <(:) || true
done
now() { date +%s%3N; }
agent() {
  local index=$1 turn started rc
  mkdir -p "/tmp/w/agent-$index"
  for turn in $(seq 1 "$TURNS"); do
    started=$(now)
    (cd "/tmp/w/agent-$index" && \
      ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=sk-ant-workload-mock \
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 \
      DISABLE_ERROR_REPORTING=1 \
      timeout 300 "$CLAUDE_CLI_PATH" -p "Inspect the workload directory." \
        --output-format stream-json --verbose --dangerously-skip-permissions \
        > "/tmp/w/agent-$index/turn-$turn.jsonl" 2>/dev/null)
    rc=$?
    echo "$index $turn $rc $(( $(now) - started )) $(grep -c '"type":"tool_result"' "/tmp/w/agent-$index/turn-$turn.jsonl" 2>/dev/null || echo 0)" >> /tmp/w/provider.tsv
  done
}
: > /tmp/w/provider.tsv
started=$(now)
for index in $(seq 1 "$AGENTS"); do agent "$index" & done
wait $(jobs -p | grep -v "^$mock$")
wall=$(( $(now) - started ))
kill -TERM "$mock" 2>/dev/null; wait "$mock" 2>/dev/null
turns_done=$(wc -l < /tmp/w/provider.tsv)
failed=$(awk '$3 != 0' /tmp/w/provider.tsv | wc -l)
tools=$(awk '{ t += $5 } END { print t + 0 }' /tmp/w/provider.tsv)
median=$(cut -d' ' -f4 /tmp/w/provider.tsv | sort -n | sed -n "$(( (turns_done + 1) / 2 ))p")
max=$(cut -d' ' -f4 /tmp/w/provider.tsv | sort -n | tail -1)
printf '{"workload":"provider","agents":%d,"turnsPerAgent":%d,"wallMs":%d,"turns":%d,"failedTurns":%d,"toolResults":%d,"turnMedianMs":%d,"turnMaxMs":%d}\n' \
  "$AGENTS" "$TURNS" "$wall" "$turns_done" "$failed" "$tools" "${median:-0}" "${max:-0}"

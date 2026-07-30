# App-server replay fixtures

Recorded `codex app-server --stdio` streams, replayed through the production
rendering pipeline by `notification-replay.test.ts`.

## Why these exist

Every other reducer/renderer test uses **hand-authored** notifications, so they
encode what we *believe* app-server emits. These fixtures are real traffic, which
is what catches the failure mode a Codex upgrade actually causes: a renamed field
or a new item variant that silently renders as nothing.

## Recording a new one

```bash
# Both variables are required: recording persists prompts and file contents, so
# it never activates from a single stray value in a checked-out `.env`.
CODEX_BRIDGE_RECORD_NOTIFICATIONS=/tmp/codex-recordings \
  CODEX_BRIDGE_RECORD_CONFIRM=1 bun run dev
# …drive the scenario in the UI, then:
bun scripts/scrub-codex-recording.ts /tmp/codex-recordings/<file>.jsonl \
  bridges/codex-bridge/src/testing/fixtures/<scenario>.jsonl
```

The test picks up any `*.jsonl` in this directory automatically — no registration
step. Name it after the scenario (`plan-mode.jsonl`, `subagent-spawn.jsonl`).

## Scrub before committing — this is not optional

A raw recording contains your prompts, file contents, absolute paths, and
potentially anything an agent read into context, including credentials. Always run
it through `scripts/scrub-codex-recording.ts`, then **read the diff** before
committing. The scrubber is a safety net, not a guarantee — it cannot recognise a
secret it has no pattern for.

The `synthetic-*.jsonl` fixtures are hand-written, not recorded, and contain no
real data. They exist so the harness is covered even with no recordings
committed.

- `synthetic-full-turn.jsonl` — reasoning, command, web search, structured patch,
  message; plus an interrupted and a failed turn.
- `synthetic-raw-apply-patch.jsonl` — `apply_patch` reported only as a raw
  `custom_tool_call`, in all three shapes: superseded by a structured
  `fileChange`, raw-only across multiple files, and failed. These replay as
  `item.dynamic.*` events, which are *known* kinds — a harness that dropped them
  would report no unknown methods while rendering a transcript with every patch
  missing.

## Scenarios worth recording

Ticked off as they land. Each needs one real model run.

- [ ] simple text reply
- [ ] reasoning (each effort tier: minimal / low / medium / high)
- [ ] command execution with large output
- [ ] file edits — single file, then a second edit to the same file
- [ ] plan mode (read-only sandbox)
- [ ] web search
- [ ] MCP tool call
- [ ] sub-agent spawn and collaboration
- [ ] image input
- [ ] slash command
- [ ] abort mid-text
- [ ] abort mid-command
- [ ] model error / usage-limit error
- [ ] long multi-turn conversation (10+ turns)

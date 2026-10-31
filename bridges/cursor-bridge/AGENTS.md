# Cursor bridge

`bridges/cursor-bridge` is the only Cursor engine. It drives Cursor's TypeScript
SDK (`@cursor/sdk`) in process and serves the shared HTTP session surface on
container port 4099. Cursor has no managed CLI or terminal mode; the ACP bridge
is Grok-only. The rules in [`bridges/AGENTS.md`](../AGENTS.md) and the root
[`AGENTS.md`](../../AGENTS.md) also apply.

## When touching the SDK bridge

- The engine boundary is `src/translate.ts` and `src/tool-rendering.ts`. Every
  Cursor-specific shape stops there; nothing downstream should learn a new
  field to render a Cursor turn.
- `applyInteractionUpdate` never awaits. It runs on the SDK's own callback, so
  an await there would let a large transcript back-pressure a live run.
- A tool variant the SDK adds must degrade to a plain card, never throw. The
  SDK is a fast-moving dependency and these branches run mid-turn.
- Sign-in runs the bridge's own `--login` mode as a short-lived child. Keeping
  `@cursor/sdk` out of the backend is deliberate: it is a five-megabyte bundle
  with native helpers, and a login needs no environment and no session.
- The credential lives in Orkestrator's data directory, not the SDK's default
  `~/.cursor/sdk/auth.json`, so a container can be handed exactly one file.
- Project settings (`.cursor/`) load only when the resolved environment
  execution policy enables project resources, on both host and container runs.
  Host project resources are off by default; enabling them permits repository
  configuration to start MCP processes on the host.
- The Orkestrator Agent MCP server is injected from a per-tab `agentMcp`
  body or, as fallback, `ORKESTRATOR_AGENT_MCP_URL` /
  `ORKESTRATOR_AGENT_MCP_TOKEN` as `AgentOptions.mcpServers.orkestrator`
  (`src/mcp.ts`). A repo's `.cursor/mcp.json` loads on the host only when
  the resolved environment policy enables project resources.
  Native Cursor mail is on (`{canPull,canSend,canInject}=true`). A rotated
  tab token detaches and re-attaches the SDK agent; the bearer is never
  persisted.
- The host launcher spawns the bridge in its own package directory, never in
  the worktree. `bun` reads `bunfig.toml` — `preload` included — and `.env`
  from its working directory before the entrypoint runs, so spawning there
  hands a cloned repository arbitrary code execution inside a process holding
  the credential path, the bridge token and the agent MCP token. The SDK's
  Shell tool does default to `process.cwd()`, but the bridge enters the
  workspace itself afterwards (`applyWorkingDirectory` in `config.ts`, called
  at module load and again from `start()`), which is why `index.ts` exports
  `./config.js` before anything that loads `@cursor/sdk`.
- Permanent close (`DELETE /session/:id` and `POST /session/:id/close`, which
  are the same non-destructive operation here) lives in `src/session-close.ts`.
  It sets `state.closed` before its first await, and every admission path —
  prompt, attach, config, steer, same-key create, resume — refuses a closed
  session. A late attach is disposed instead of installed, and a late
  `agent.send` result is cancelled and followed. The close answers 503
  `pending` until owned work has actually stopped, and it publishes the
  removal before it answers success. Idle detach (`detachAgent`) is not a
  close and never sets the marker. A method the bridge does not serve on a
  session it *does* have answers 405, so a real gap cannot hide as a missing
  session. A close a previous process recorded but did not finish (a restored
  tombstone) is finished by `src/session-tombstones.ts`, and resuming the same
  conversation waits for it first.
- `persistBarrier()` is a mandatory publication: it rejects when nothing
  reached disk, and prompt/steer dispatch, create, resume and identity-changing
  attach all wait for it. `schedulePersist()` is best-effort. Both share one
  serialized queue, so never write the state file directly. When the
  aggregate state outgrows `MAX_STATE_FILE_BYTES`, the oldest-touched persisted
  transcript copies are shed (`src/persistence-budget.ts`). If the recovery
  metadata alone does not fit, the publication fails with a typed error rather
  than being skipped.
- `GET /session/:id/dispatch` answers `absent` only when the prompt journal
  has no record of the id and is complete for the session
  (`promptJournalComplete`): the bridge created the session with a new agent,
  every restart loaded its journal whole, and no record was ever evicted. It is
  never answered for a resumed or adopted agent, a closing session, or while a
  prompt claim is in flight. The flag is persisted only as `true`, so an older
  bridge, which rewrites only the fields it knows, drops it and leaves the
  safe answer. Any new way of forgetting a journal record must clear the flag;
  the only deletion that keeps it is the rollback of an attempt that never
  reached the SDK.
- The steer journal is bounded by count and bytes (`src/steer-journal.ts`).
  Records that could still be retried against the running turn are never
  evicted. A new steer that does not fit is refused with 429
  `{ outcome: "rejected" }` before anything is journaled or sent. Do not
  replace this with a FIFO: an evicted record would turn an exact retry into
  a second delivery.
- Never compress a response the client did not ask for. `json` reads
  `Accept-Encoding` once per request; this repository already has a hop that
  asks for `identity` on purpose. Compression defers the write past the
  caller's return, so every write also has to survive a socket that is already
  gone.
- Giving up on a turn is not the same as the run stopping. Anything that fails
  a turn without the run acknowledging it — the prompt timeout above all — has
  to cancel that run, or it keeps writing to the workspace while `/activity`
  answers idle and `cancelTurn` has already been cleared.
- A cancel that arrives before `agent.send` resolves has no run to act on. It
  parks against the sequence of the turn it meant to stop and is honoured the
  moment the handle exists; answering it as `cancelled` would tell the user a
  turn stopped while it carried on.

## Compaction

`POST /session/:id/compact` runs `agent.summarize()` as a turn: it holds the
session busy, a cancel stops it and a close waits for it. It answers 202 as soon
as the run starts, because a summary can outlast any request budget, and the
boundary on the transcript carries the outcome. The SDK takes no `onDelta` here,
so `dispatchCompaction` opens the boundary and `finishTurn` settles it from the
run's terminal result, not `onDelta`, and never backfills that result as prose.
A `summary` message with `status: "error"` fails the boundary while the run
still finishes, and leaves the conversation as it was. `summarize()` rejects
before any run exists, so unlike a failed `send` that rejection is not ambiguous.

## One row per model step

The translator (`src/translate.ts`) writes each model step to a row of its
own: a top-level `step-started` (or, failing that, `turn-ended`) ends the
current assistant row, and the next content opens a new one lazily. A
sub-agent's steps never split rows; its output stays on the row holding its
launch card, and the per-child bounds apply to that row. Never fold a whole
turn back into one row: a turn runs for hours, and a multi-megabyte row fits
no transcript window, so readers can only show a trimmed copy and lose it once
a newer row pushes it out of the live tail. A late result, shell output,
progress line, image or compaction summary patches the row holding its call,
found across the current turn's rows (`beginAssistantTurn` and the turn tags
in `src/transcript.ts`), never a second card on the newest one. Mutating an
older row must still bump `revision`, which is the transcript token readers
compare. History hydration (`appendHistoricTurn`) has no step frames and
starts a row wherever prose or reasoning follows a tool call, so a reload
matches the live split; it marks `planReview` from the `create_plan` row to the
end of that turn, because the tab offers Approve and Build only while the
newest assistant row is marked.

Those lookups must stay constant-time on a turn of thousands of rows: the
turn's call index (`indexToolCall`, capped at `MAX_INDEXED_CALLS`), row
ordinals and the cached turn start replace scans of the turn, and a scan
remains only for what the index cannot answer. When the run's terminal text
completes streamed prose, it extends the row holding that prose; any other
terminal text is the final model call's, on a row of its own unless the row
being written still ends in prose or reasoning. After `turn-ended` has
closed that row, missing terminal prose opens a separate answer row (including
for a reasoning-only final step); prefix completion still extends its prose row.

Every in-place row change goes through `rowChanged` / `noteRowRevised`
(`src/transcript.ts`), which note the row for `revisedMessageIds`, so a late
update to a row outside the live window reaches readers through
`revisedMessages`. `startTranscriptEpoch` (rewind, rebuilt history) clears the
notes; a new change site must use the helper, not bump `revision` alone.

## Background sub-agents

A background sub-agent is settled when its parent run ends. The SDK reports
children only through nested updates on that run, so once it is over there is
no channel left to observe them on — the card says the child was detached
rather than claiming it completed, because holding it active would report the
environment as permanently busy. The same applies across a restart: the live
child registry is deliberately not persisted, so a card restored at `active`
would spin forever with nothing left that could settle it, and `loadPersistedState`
closes those out on the way in.

## Goals

Orkestrator's goal loop runs in the backend (`plans/goals.md`). Cursor's model is
offered its own `CreateGoal` and `UpdateGoal`, and `@cursor/sdk` 1.2.0 has no option to
turn them off, so this path stays open. The carrier tells the agent to use no other
goal tool. Re-check on each SDK upgrade.

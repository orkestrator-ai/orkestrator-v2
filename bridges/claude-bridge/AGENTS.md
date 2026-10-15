# Claude bridge

`bridges/claude-bridge` drives the Claude Agent SDK and serves the shared HTTP
session surface. The rules in [`bridges/AGENTS.md`](../AGENTS.md) and the root
[`AGENTS.md`](../../AGENTS.md) also apply.

## One CLI per session

A session is one conversation, and only one Claude CLI may run its root agent
loop. `session-manager-runtime.ts` owns that process (`session.claudeRuntime`):
its input stream, the single consumer of its frames, and which turn each frame
belongs to. Two CLIs resumed from the same rollout each answer their own task
notifications as the coordinator — duplicated agents, interleaved edits, two
writers on one `.jsonl`. When touching the prompt path:

- **Never start a query for a session whose runtime is open.** A turn that ends
  while its CLI still owns background work releases the foreground but leaves
  the process running; the next prompt is written into it (`submitClaudeTurn`).
  A new process starts only when there is none, or after a draining one has
  exited (`retireDrainingClaudeRuntime`). Probes that never run the model
  (`maxTurns: 0` rewind, catalogue reads) are not turns.
- **The newest turn owns the root conversation.** Root frames, results, hooks
  and continuations go to `runtime.latestTurn`; only a subagent's frames go to
  the turn whose row holds its call (`routeClaudeFrame`). A superseded turn
  never closes input, releases retention or arms the continuation watchdog —
  the newer turn may be waiting on all three.
- **Launch-only settings are refused, not ignored.** Output schema, execution
  policy, agent, settings sources, effective context beta, prompt suggestions,
  plugins and managed credentials cannot change on a live CLI. Adaptive thinking
  can only reset a runtime launched in adaptive mode; bypass mode requires the
  launch capability. A prompt that changes them while the runtime is open is a 409 before anything is
  journaled (`assertClaudeRuntimeAccepts`, checked by the route and again by
  `sendPrompt`); one that leaves agent or settings sources unsaid inherits the
  running values. Model, mode, effort, thinking, fast mode and Ultracode are
  restated on the live process every time it is joined, within those launch
  constraints. An abort or close request fences the runtime immediately but
  does not prove termination: replacement and transient rewind wait for
  `runtime.ended`, with a bounded retryable conflict when it cannot be confirmed.
  A failed live MCP update remains pending and is retried, never recorded as
  applied. During join setup, the session generation fences the old turn's
  input-close and retention paths until submission transfers runtime ownership.

## One row per model response

The live loop (`session-manager-prompt-stream.ts`) writes each root model
response (one API message id) to a row of its own; a subagent's output joins
the row holding the call that started it. Never fold a whole turn back into one
row: a turn the CLI keeps alive for background work runs for hours, and a
single multi-megabyte row fits no transcript window, so readers can only show a
trimmed copy and lose it once a newer row pushes it out of the live tail. A
tool result, denial or command change rebuilds the row holding that call
(`refreshToolRows`), not only the newest one.

## Session catalogue and transport

When touching the session catalogue (`session-manager-catalog.ts`):

- **A control that is still set is not necessarily usable.**
  `session.queryControl` lives until the turn's `finally`, but the CLI's stdin
  closes earlier, at the result boundary. Every control request issued in that
  window races the process exit and is rejected with
  `Query closed before response received`. Reads go through `readableControl`,
  which skips a control marked `queryControlDraining`. `closeTurnInput()` in
  `session-manager-prompt-turn-lifecycle.ts` is the one place that sets the marker, so a new
  stdin-close site cannot forget it.
- **Reads fall back, writes conflict.** `isClosedTransportError` maps a dead
  transport onto the cached answer for `/commands` and `/mcp`, and onto 409 for
  `/config` — a settings change that never reached the CLI must not look like it
  succeeded. Every other error still propagates; do not widen that match.
- **The no-control fallback costs a process.** `createProbe()` spawns a whole
  Claude CLI, so `commandInventory` caches the catalogue the way `mcpInventory`
  already did. The backend re-reads both on every session projection
  (`native-agent-service-projection.ts`), so an uncached fallback is one spawn
  per turn boundary rather than a one-off.
- **Every SDK frame has a declared fate.** `HANDLED_SDK_MESSAGE_TYPES` and
  `SYSTEM_SUBTYPE_DISPOSITIONS` (`src/types/index.ts`) are `Record`s over the
  SDK's own unions, so an SDK bump that adds a message type or `system`
  subtype fails the typecheck until someone decides whether it is handled,
  kept as a health notice, or ignored as inventory. Content blocks the parser
  has no branch for are counted as `block:<type>` drift.
- **The native tab never sees SSE.** The backend polls `GET /session/:id` and
  the transcript routes; `session.updated` frames only reach the legacy web
  client. Turn-scoped state the tab must show (activity, thinking estimate,
  background tasks) has to be in that snapshot. A row derived from a record
  the rollout keeps (a task report, an interruption marker) must be produced
  by both the live loop and `normalizePersistedSessionMessages`, or a reload
  will disagree with the live tab.
- **`DELETE /session/:id` is destructive.** It calls the SDK's
  `deleteSession`, which removes the `{sessionId}.jsonl` rollout. Tab close
  uses `POST /session/:id/close` (`closeSessionRetainingHistory`), which stops
  the query and keeps the rollout; nothing may fall back from close to DELETE.
  Close answers 503 pending, keeping the session registered and fenced, when
  it cannot prove the query stopped (`Query.close()` threw or did not settle,
  or a racing dispatch claim did not settle).
- **`app.onError` is registered on purpose.** Hono's default handler passes the
  raw error to `console.error`, which under Bun prints a source-context dump of
  whichever minified vendor file threw, with no indication of which request
  produced it.

## Coordinator shell allowlist

`src/services/read-only-policy.ts` holds the read-only boundary for shell,
because no tool-name rule can separate `git log` from `git commit` — which is
why `capabilityPolicy`'s `shell.mutate` maps to no tool names at all. Two
invariants keep it honest:

- **The command checked must be the command that runs.** `COMPOSITION_PATTERN`
  refuses anything that can become several commands, and a newline counts: the
  shell treats it exactly as `;` does, while a whitespace split would reduce
  `ls\nrm -rf .` to a harmless-looking `ls`.
- **The program name is not the whole command.** A program that launches another
  program does not belong in `READ_ONLY_COMMANDS` whatever it is called — `env`
  is absent for that reason. Where a reading tool has a writing flag, name it in
  `MUTATING_ARGUMENTS` (`find -delete`, `sort -o`, `yq -i`) rather than dropping
  the tool. Git subcommands whose effect depends on their arguments belong in
  `CONDITIONAL_GIT_SUBCOMMANDS`, not the flat read-only set: `branch`, `tag`,
  `remote` and `config` all read in one form and write in another.

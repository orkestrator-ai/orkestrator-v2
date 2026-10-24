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
  releases the foreground but leaves the process running, whether or not it
  still owns background work; the next prompt is written into it
  (`submitClaudeTurn`). A new process starts only when there is none, or after
  a draining one has exited (`retireDrainingClaudeRuntime`). Probes that never
  run the model (the rewind query, catalogue reads) are not turns.
- **The runtime ends itself; turns never close its input.** Its idle window
  (`session-manager-runtime-idle.ts`, `CLAUDE_BRIDGE_RUNTIME_IDLE_MS`, default
  10 minutes; 0 closes input at turn end) closes input after that much silence
  with no foreground turn, no live task and no parked card. An owed
  continuation stretches the window to `CONTINUATION_SILENCE_MS`. No route
  read extends it: the backend polls `GET /session/:id` and `/activity`, so a
  window that counted reads would never release an open tab's CLI. At most
  `CLAUDE_BRIDGE_MAX_IDLE_RUNTIMES` (default 3) idle CLIs stay warm per bridge;
  the one idle longest goes first. A hard abort with nothing running leaves a
  warm CLI alone.
- **A metadata read goes through `controlOnlyQuery`.** The Agent SDK drops
  `maxTurns: 0`, so a `prompt: ""` query sends an empty user message and starts
  a real turn (model calls, tools, an empty session file under
  `~/.claude/projects`) unless it is closed first. `controlOnlyQuery` sends no
  message at all.
- **The newest turn owns the root conversation.** Root frames, results, hooks
  and continuations go to `runtime.latestTurn`; only a subagent's frames go to
  the turn whose row holds its call (`routeClaudeFrame`). A superseded turn
  never releases the foreground or waits for a continuation — the newer turn
  inherits both. The latest turn may have settled its prompt already: a root
  loop the CLI resumes on its own reclaims the foreground through it and
  publishes its own idle edge (`finishTurnInputIfSettled`), and a process that
  ends under such a turn hands the foreground back (`endClaudeRuntime`).
- **Launch-only settings are refused, not ignored.** Output schema, execution
  policy, agent, settings sources, effective context beta, prompt suggestions,
  effective Chrome access, cost budget, plugins and managed credentials cannot change on a live CLI. Adaptive thinking
  can only reset a runtime launched in adaptive mode; bypass mode requires the
  launch capability. A prompt that changes them while the runtime still owes
  work (a live task, an owed continuation, a parked card) is a 409 before
  anything is journaled (`assertClaudeRuntimeAccepts`, checked by the route and
  again by `sendPrompt`); an idle warm runtime is retired instead and the turn
  launches a new one (`runTurnOnRuntime`). One that leaves agent or settings sources unsaid inherits the
  running values. Model, mode, effort, thinking, fast mode and Ultracode are
  restated on the live process every time it is joined, within those launch
  constraints. An abort or close request fences the runtime immediately but
  does not prove termination: replacement and transient rewind wait for
  `runtime.ended`, with a bounded retryable conflict when it cannot be confirmed.
  A failed live MCP update remains pending and is retried, never recorded as
  applied. During join setup, the session generation fences the old turn's
  release and continuation paths until submission transfers runtime ownership.
- **A running CLI unloads only what `setMcpServers` gave it.** Servers passed
  to `query()` at launch survive an update that omits them, so the first
  update that drops one restates the launch set first
  (`syncClaudeRuntimeMcp` in `session-manager-prompt-mcp-sync.ts`). A server
  the configuration dropped that the CLI still runs is never reported as
  unloaded: a PreToolUse hook refuses its tools and the revision names it in
  `staleServers`. Re-prove the CLI behaviour with
  `mise run verify:claude:mcp-live` on every Claude bump.

## The policy caps the permission mode

The backend sends `bypassPermissions` with every build prompt, so the prompt's
mode is never taken as given. Under an `ask` or `deny` policy
`claudePermissionMode` (`claude-query-config.ts`) lowers anything wider than
`default`; a prompt may still narrow it to `plan` or `dontAsk`.

- **`ask`** pre-approves only reading tools; `canUseTool` parks the rest as
  approval cards (`session-manager-parked-interactions.ts`).
- **`deny`** runs in `default` too, and `canUseTool` refuses what reaches it.
  Do not move it to `dontAsk`: the pinned CLI refuses AskUserQuestion there
  without consulting `canUseTool`, so a coordinator could no longer ask the
  user anything.
- **An allow never returns the SDK's `suggestions`.** They are durable rules,
  and nothing lists or revokes them yet.
- **A pause only moves a card's deadline.** Questions, plan approvals and
  parked interactions each run on an `InteractionDeadline`
  (`session-manager-interaction-holds.ts`); `POST …/hold` stops the countdown
  until the hold ceiling, and expiry still denies or cancels. A hold never
  answers anything. While any card waits, the runtime's idle window re-arms
  instead of closing the CLI: a paused card is not silence.

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

- **A control that is still set is not necessarily usable.** Once the CLI's
  input is closed (an idle release, a retirement, a close) the process is
  exiting, and every control request races that exit and is rejected with
  `Query closed before response received`. Reads go through `readableControl`,
  which skips a control marked `queryControlDraining`. Input closes and the
  marker is set in two places only: `drainClaudeRuntime()` in
  `session-manager-runtime.ts`, and teardown (`takeQueryControls`). Route a new
  close site through the first so it cannot forget the marker. A turn hands
  `session.queryControl` back when it releases the foreground. `readableControl`
  then uses the open runtime's control directly for catalogues and MCP actions;
  configuration writes use it too. None of these reads extends the idle window.
- **Reads fall back, writes conflict.** `isClosedTransportError` maps a dead
  transport onto the cached answer for `/commands` and `/mcp`, and onto 409 for
  `/config` — a settings change that never reached the CLI must not look like it
  succeeded. Every other error still propagates; do not widen that match.
- **The no-control fallback costs a process.** `createProbe()` spawns a whole
  Claude CLI, so `commandInventory` caches the catalogue the way `mcpInventory`
  already did. The backend re-reads both on every session projection
  (`native-agent-transcript-projection.ts`), so an uncached fallback is one spawn
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
why `capabilityPolicy`'s `shell.mutate` maps to no tool names at all. Three
invariants keep it honest:

- **The command checked must be the command that runs.** `COMPOSITION_PATTERN`
  refuses anything that can become several commands, and a newline counts: the
  shell treats it exactly as `;` does, while a whitespace split would reduce
  `ls\nrm -rf .` to a harmless-looking `ls`.
- **The program name is not the whole command.** A program that launches another
  program does not belong in `READ_ONLY_COMMANDS` whatever it is called — `env`
  is absent for that reason, and a path (`bin/cat`) names whatever the checkout
  put there, so programs run by bare name only. Where a reading tool has a
  writing flag, name it in `MUTATING_ARGUMENTS` (`find -delete`, `sort -o`,
  `yq -i`) rather than dropping the tool; a one-letter flag there also matches
  inside a cluster or with its value attached (`-no out`, `-oout`). A tool that
  writes a positional (`uniq in out`) belongs in `POSITIONAL_LIMITS`, and one
  with too many writing options to list (gawk) in `OPTION_ALLOWLISTS`. Git
  subcommands whose effect depends on their arguments belong in
  `CONDITIONAL_GIT_SUBCOMMANDS`, not the flat read-only set: `branch`, `tag`,
  `remote` and `config` all read in one form and write in another.
- **Assume no sandbox behind it.** The SDK sandbox lets a command write its
  working directory, which for a coordinator is the user's checkout, so
  `claudeReadOnlySandbox` denies writes there (`filesystem.denyWrite`). Where
  the sandbox cannot start at all (Windows, Linux without bubblewrap and
  socat; the launcher says so in `ORKESTRATOR_COORDINATOR_COMMAND_SANDBOX`)
  this allowlist is the whole boundary. A command it admits must neither write
  nor reach the network on its own, which is why `gh`, `curl` and
  `git ls-remote` are refused rather than left to the sandbox.

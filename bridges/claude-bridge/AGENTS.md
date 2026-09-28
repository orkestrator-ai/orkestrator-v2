# Claude bridge

`bridges/claude-bridge` drives the Claude Agent SDK and serves the shared HTTP
session surface. The rules in [`bridges/AGENTS.md`](../AGENTS.md) and the root
[`AGENTS.md`](../../AGENTS.md) also apply.

## Session catalogue and transport

When touching the session catalogue (`session-manager-catalog.ts`):

- **A control that is still set is not necessarily usable.**
  `session.queryControl` lives until the turn's `finally`, but the CLI's stdin
  closes earlier, at the result boundary. Every control request issued in that
  window races the process exit and is rejected with
  `Query closed before response received`. Reads go through `readableControl`,
  which skips a control marked `queryControlDraining`. `closeTurnInput()` in
  `session-manager-prompt.ts` is the one place that sets the marker, so a new
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

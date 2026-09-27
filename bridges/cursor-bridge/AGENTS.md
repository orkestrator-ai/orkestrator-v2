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
- Project settings (`.cursor/`) are read inside containers and not on the host,
  so cloning a repository is not enough to run its code on the user's machine.
- The Orkestrator Agent MCP server is injected from a per-tab `agentMcp`
  body or, as fallback, `ORKESTRATOR_AGENT_MCP_URL` /
  `ORKESTRATOR_AGENT_MCP_TOKEN` as `AgentOptions.mcpServers.orkestrator`
  (`src/mcp.ts`). Host runs still do not load a repo's `.cursor/mcp.json`.
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
  session.
- `persistBarrier()` is a mandatory publication: it rejects when nothing
  reached disk, and prompt/steer dispatch, create, resume and identity-changing
  attach all wait for it. `schedulePersist()` is best-effort. Both share one
  serialized queue, so never write the state file directly. When the
  aggregate state outgrows `MAX_STATE_FILE_BYTES`, the oldest-touched persisted
  transcript copies are shed (`src/persistence-budget.ts`). If the recovery
  metadata alone does not fit, the publication fails with a typed error rather
  than being skipped.
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

## Background sub-agents

A background sub-agent is settled when its parent run ends. The SDK reports
children only through nested updates on that run, so once it is over there is
no channel left to observe them on — the card says the child was detached
rather than claiming it completed, because holding it active would report the
environment as permanently busy. The same applies across a restart: the live
child registry is deliberately not persisted, so a card restored at `active`
would spin forever with nothing left that could settle it, and `loadPersistedState`
closes those out on the way in.

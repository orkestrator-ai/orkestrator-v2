# Agent engine architecture

Orkestrator provisions six coding-agent platforms. They are listed once, in
`packages/protocol/src/agent-platforms.ts`, and everything else keys off that
list:

| Platform | Label | Integration |
| --- | --- | --- |
| `claude` | Claude Code | Bridge process wrapping the Claude Agent SDK |
| `codex` | Codex | Bridge process speaking JSON-RPC to `codex app-server` |
| `opencode` | OpenCode | No bridge — the backend drives `opencode serve` through the SDK |
| `cursor` | Cursor Agent | Bridge process wrapping `@cursor/sdk` |
| `grok` | Grok Build | Bridge process speaking ACP to the CLI over stdio |
| `pi` | Pi | Bridge process wrapping the Pi coding-agent SDK |

They do **not** share one mechanism. Each vendor exposes a different surface —
a TypeScript SDK, a JSON-RPC app-server, an HTTP server, or a raw stdio
protocol — and Orkestrator adapts each one rather than pretending they are
interchangeable. What *is* shared is the shape around them.

## The shape every engine has in common

Read `AGENTS.md` first — the background-reliability and transport invariants it
lists are the reason these engines are built the way they are. In short:

1. **The backend owns the process, not the renderer.** `apps/backend/src/core/commands.ts`
   spawns every bridge and server, keyed by environment id, and keeps them alive
   across tab switches and component unmounts. A React tree unmounting means
   "not currently visible", never "cancel the work".
2. **One process set per environment.** Environments differ in filesystem,
   container, `PATH`, credentials, and installed toolchains, so they never share
   an agent process.
3. **Every child is authenticated.** The backend generates a 32-byte token per
   environment and passes it in as `CLAUDE_BRIDGE_TOKEN`, `CODEX_BRIDGE_TOKEN`,
   `ACP_BRIDGE_TOKEN`, `PI_BRIDGE_TOKEN`, or `OPENCODE_SERVER_PASSWORD`. A missing or blank token
   makes a bridge fall back to a random value nobody holds, so it fails closed
   rather than open. The Claude and Codex bridges delete the variable from
   `process.env` after reading it, so a spawned agent child cannot inherit the
   bridge's own credential.
4. **Live events are incremental updates over authoritative snapshots.** Each
   engine exposes both a stream and a way to re-read current state, because a
   tab that was inactive must be able to catch up from the snapshot instead of
   depending on an event it never received.
5. **Approvals fail closed.** Timeout, disconnect, a malformed answer, or the
   death of the process that asked all deny. None of them approve.
6. **Managed executables are pinned and hash-verified.** `apps/desktop/electron/toolchain-manifest.ts`
   pins each managed binary; the backend passes the resolved path down
   (`CLAUDE_CLI_PATH`, `CODEX_PATH`, `ACP_AGENT_PATH`) so a packaged app never
   depends on a `PATH` lookup. See [`docs/upgrade-agents.md`](../upgrade-agents.md)
   for the bump procedure.

The renderer reaches a bridge over HTTP and SSE — directly on loopback when it
runs inside Electron, and through the gateway's authenticated loopback proxy
when it runs in a remote browser.

## Claude Code

**Bridge:** `bridges/claude-bridge/` · **Transport:** HTTP + SSE (Hono)

The bridge wraps `@anthropic-ai/claude-agent-sdk` and exposes it as a REST
surface: `POST /session/create`, `POST /session/:id/prompt`,
`GET /session/:id/messages`, `GET /session/:id/activity`, and an SSE stream at
`GET /event/subscribe`. `services/session-manager.ts` is the compatibility
surface — it is where the SDK's message union is normalized into Orkestrator's
own `NormalizedMessage`/`NormalizedPart` model, and it is the file to review on
every SDK bump.

Turns run through the SDK's `query()` with `includePartialMessages: true` so
partial assistant output streams as it arrives. Continuation uses the SDK's own
`resume` with the stored `sdkSessionId` rather than replaying the transcript.
The SDK is pointed at Orkestrator's managed executable through
`pathToClaudeCodeExecutable`.

Permission handling defaults to `bypassPermissions` for an interactive tab,
which is a deliberate choice: an Orkestrator agent tab is an interactive session
in an isolated environment. `plan` mode is the read-only alternative, and the
SDK's `canUseTool` callback is what routes a tool request back through the
bridge's approval flow when one is raised.

Claude also has a second, unrelated execution mode: `apps/backend/src/core/tmux.ts`
drives the Claude Code CLI inside a tmux session and observes its terminal
output. That path does not use the bridge or the SDK at all.

## Codex

**Bridge:** `bridges/codex-bridge/` · **Transport:** JSON-RPC over private stdio

The bridge supervises exactly one persistent `codex app-server --stdio` child
per environment and speaks JSON-RPC to it — `thread/start`, `thread/resume`,
`thread/read`, `thread/fork`, `thread/list`, `thread/unsubscribe`, `turn/start`,
`turn/steer`, `turn/interrupt`. One child serves every Codex tab and build phase
in that environment, which makes it a shared failure domain, so most of the
bridge exists to make that survivable:

- **Generations.** `app-server/process-supervisor.ts` stamps a monotonic
  generation on each child. Anything arriving from a dead generation is
  discarded, so a late event can never overwrite state owned by a newer process.
- **Ambiguous failures are not retried.** In-flight requests fail *ambiguously*
  rather than being replayed. Only an explicit `-32001` overload proves a turn
  did not run; anything else reconciles against persisted turns via
  `sessions/dispatch-journal.ts`, which is what makes prompt dispatch
  at-most-once.
- **A circuit breaker,** rather than restarting forever, plus an environment
  fingerprint that forces a controlled restart when the developer's `PATH`
  changes.
- **A pidfile and process-group termination,** so orphaned children cannot
  outlive the bridge and race over the same `CODEX_HOME`.

The transport is the other load-bearing constraint. app-server's outbound queue
is bounded, so the stdout read loop never awaits rendering, an SSE write, or any
other consumer — notifications go to a per-thread serial queue and fan out from
there. A slow consumer on one thread therefore cannot stall every other thread
in the environment.

SSE frames carry `id: <revision>`, and `event-ring.ts` keeps a bounded replay
buffer so a reconnecting client can ask for exactly what it missed. The
`connected` frame echoes the client's own cursor rather than the latest
revision, because a browser `EventSource` adopts every id it sees.

Idle threads are detached (`thread/unsubscribe`, state freed) and transparently
re-attached on the next request. `thread/delete` is never called: closing a
session unsubscribes, whereas deleting would destroy the user's rollout.

`session-titles.ts` is the one deliberate exception to all of the above — it
still spawns a hermetic `codex exec` with a custom model catalog, a read-only
sandbox, and user config ignored, so title generation cannot inherit the user's
tools or instructions.

## OpenCode

**Bridge:** none · **Transport:** HTTP + SSE via `@opencode-ai/sdk/v2/client`

OpenCode is the exception: it ships its own HTTP server, so Orkestrator does not
interpose a bridge process. The backend starts `opencode serve --port <port>`
for the environment and talks to it directly.

`apps/backend/src/core/native-agent-provider.ts` is where the split happens —
`createNativeAgentProvider()` returns an `OpenCodeProvider` for `opencode` and
an `HttpBridgeProvider` for every other platform. Both satisfy the same
`NativeAgentRuntimeProvider` contract in `agent-provider-contract.ts`, so
callers (interactive tabs and build pipelines alike) do not branch on platform.
`apps/backend/src/core/build-pipeline-provider.ts` re-exports a deliberately
smaller slice of that contract for pipeline code.

Always use **v2** of the SDK (`@opencode-ai/sdk/v2/client`). v2 takes flat
parameters — `client.session.promptAsync({ sessionID, parts })` — where v1 took
nested `{ path, body }` objects, and the question APIs
(`client.question.list/reply/reject`) exist only in v2. The renderer has its own
v2 wrapper at `apps/web/src/lib/opencode-client.ts`.

Because the server is the vendor's rather than ours, the SSE event vocabulary is
theirs too: `message.updated`, `message.part.updated`, `session.updated`,
`session.error`, `question.asked`, `question.replied`, `question.rejected`.
The SDK and CLI are pinned to the same exact version, and
`tests/unit/version-drift.test.ts` enforces that they agree.

## Cursor Agent

**Bridge:** `bridges/cursor-bridge/` · **Transport:** Cursor TypeScript SDK in process

Cursor sessions are SDK-only. The bridge owns one `SDKAgent` per attached
session and translates `InteractionUpdate` events into the shared transcript
shape. Cursor has no managed CLI, terminal mode, or ACP fallback. Local and
container sessions use the same bridge and HTTP routes.

The bridge keeps project `.cursor/` resources disabled on the host and enables
them only inside containers. Its SDK and native runtime closure are vendored
into the packaged bridge; see `docs/upgrade-agents.md` for the build and upgrade
checks.

## Grok Build

**Bridge:** `bridges/acp-bridge/` · **Transport:** ACP JSON-RPC over stdio

The bridge spawns the `grok` CLI and speaks the Agent Client Protocol over its
stdio. One bridge process serves the environment and spawns one CLI child per
session, lazily re-attaching through `ensureSessionProcess` when needed. It
launches Grok as
`--always-approve agent [--model M] [--reasoning-effort E] stdio`.

Because these are command-line flags rather than a typed SDK, **the argv is a
versioned contract that nothing in CI can check** — the bridge's own tests run
against a fake agent that accepts anything, so a renamed upstream flag leaves the
suite green and breaks every session at runtime. `docs/upgrade-agents.md` has the
manual verification steps to run after a version bump.

The permissive command flag is deliberate and matches the Claude bridge's local
default.

Protocol handling lives in `index.ts`. The bridge sends `initialize`,
`session/new`, `session/load`, `session/list`, and `session/prompt`, and
notifies `session/cancel`. Inbound, it handles `session/update` notifications
(`agent_message_chunk`, `tool_call`, `tool_call_update`,
`available_commands_update`, `model_changed`, and friends) and answers
`session/request_permission` requests through the approval flow. Any *other*
inbound request is refused with JSON-RPC `-32601` rather than silently
acknowledged — acknowledging a capability the bridge does not have would be a
lie the agent then acts on. Vendor notifications it does not model are ignored,
which costs nothing because notifications expect no reply.

Agent stderr is drained but never logged: it may contain prompts or file
contents. Vendor wire formats stay inside the adapter — `session-config.ts`
converts them to the shared `NativeAgentComposerState` that HTTP clients see.

## Pi

**Bridge:** `bridges/pi-bridge/` · **Transport:** HTTP (Node `http`)

Pi is the second SDK-in-process bridge, after Claude. It wraps
`@earendil-works/pi-coding-agent` and serves the same REST surface as every
other bridge: `POST /session/create`, `POST /session/:id/prompt`,
`GET /session/:id/messages`, `GET /session/:id/activity`, and the rest.
`src/translate.ts` is the compatibility surface — it turns Pi's
`AgentSessionEvent` stream into Orkestrator's `BridgeMessage`/`BridgeMessagePart`
model, and it is the file to review on every SDK bump.

What makes Pi structurally different from the other five is that it is a
*harness*, not a vendor. It fronts around fifteen model providers using the
user's own credentials, so:

- **A model is a pair.** `provider` plus `modelId`, encoded flat as
  `provider/modelId` and split on the first slash only, because an OpenRouter
  id carries its own slashes. Identical to OpenCode's encoding, deliberately.
- **"Signed in" is per provider.** `GET /global/auth` reports each provider's
  status; there is no single account. Sign-in itself is not served: Pi's login
  is an interactive multi-step prompt flow (`select`, `text`, `secret`) with no
  counterpart in Orkestrator's session surface, and the credential it writes is
  account-wide. Users sign in with `/login` in a Pi terminal tab, and containers
  receive `~/.pi` as a bind mount the entrypoint copies a bounded subset of.
- **Reasoning is Pi's thinking level** — the same off/minimal/low/medium/high/
  xhigh/max ladder `/thinking` sets, mapped onto the reasoning axis the Codex
  picker already uses, so an application-level effort default carries across
  without translation. Which levels a given model offers comes from Pi's own
  `getSupportedThinkingLevels`, because the rule has a corner: `xhigh` and `max`
  require an explicit `thinkingLevelMap` entry where every other level is
  included unless mapped to `null`. The default for a fresh session is resolved
  Pi's way too — per-model setting, then global default, then `medium` — off the
  same `settings.json` the CLI writes, so a level chosen in a terminal tab is
  the one the picker opens on. Pi clamps a level the model cannot honour, and
  `thinking_level_changed` carries the effective value back into the composer;
  without that the control would keep showing a selection the run is not using,
  and a clamped turn gives no other signal because it simply succeeds.

  There is no speed axis and no plan/build mode: "primitives, not features" is
  Pi's stated design, and both are things an extension adds rather than things
  the harness has.

The conversation is Pi's, not the bridge's. Pi persists each session to its own
JSONL file and resumes from it, so the bridge holds only the *rendered*
transcript, the composer selection and the prompt journal. An idle detach, a
bridge restart and a crashed process all recover by reopening that file, and
losing the bridge's own state costs a transcript rather than a conversation.
That also gives fork a real implementation: `createBranchedSession` writes a new
file holding the path to the chosen entry, so a fork is an independent
conversation rather than a copy of what was on screen.

Approvals exist but are off by default. Pi ships no permission system — a gate
is something you build on its `tool_call` extension hook — so the bridge
registers exactly that as an inline extension, enabled by
`PI_BRIDGE_REQUIRE_APPROVAL=1`. The default is permissive for the same reason
the Claude bridge's is: an Orkestrator tab is an interactive session in an
already-isolated environment. When the gate is on, timeout, disconnect, session
close and a malformed answer all deny, and a turn that ends with a call still
parked denies it rather than leaving the turn awaiting a promise nobody will
settle.

Project-local `.pi/` resources — extensions, skills, prompt templates — are
opt-in through `PI_BRIDGE_PROJECT_RESOURCES` and only the container launcher
opts in. A Pi extension is arbitrary TypeScript the bridge process would run, so
this is the same boundary `ACP_APPROVE_PROJECT_MCPS` draws for the ACP bridge:
cloning a repository must not be enough to run its code on the user's machine.

The SDK and the `pi` binary a terminal tab runs are the same program published
two ways, so they are pinned to one version and `tests/unit/version-drift.test.ts`
enforces that the bridge's dependencies, `PINNED_TOOLCHAIN_VERSIONS.pi` and the
Dockerfile's `PI_CLI_VERSION` all agree.

## Where to look next

| Topic | Document |
| --- | --- |
| Bumping any agent SDK, CLI, or pinned binary | [`docs/upgrade-agents.md`](../upgrade-agents.md) |
| Background-reliability and transport invariants | [`AGENTS.md`](../../AGENTS.md) |
| Agent-driven real-stack QA | [`docs/development/agent-testing.md`](../development/agent-testing.md) |
| Known flakes and their root causes | [`docs/flaky-tests.md`](../flaky-tests.md) |

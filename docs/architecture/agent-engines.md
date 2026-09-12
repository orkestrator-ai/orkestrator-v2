# Agent engine architecture

Status: Living — six-engine architecture; keep aligned with the tree.

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
   `CURSOR_BRIDGE_TOKEN`, `ACP_BRIDGE_TOKEN`, `PI_BRIDGE_TOKEN`, or
   `OPENCODE_SERVER_PASSWORD`. A missing or blank token
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
   depends on a `PATH` lookup. See [`docs/development/upgrade-agents.md`](../development/upgrade-agents.md)
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

### Project Coordinator

A Coordinator conversation is project-owned, not an environment disguised as a
local worktree. Its durable owner is `{ kind: "coordinator", projectId,
coordinatorId }`; provider processes, projections, queues, transcripts, and mail
use a distinct `coordinator:` runtime namespace. Each conversation gets its own
bridge so its scoped MCP/mail credential cannot be shared with a sibling tab.
Unmounting the project page does not stop that backend-owned runtime.

Coordinator qualification lives in one table,
`apps/backend/src/core/coordinator-providers.ts`. Every gate (workspace
service, runtime resolver, bridge launcher, trusted session input) consults it.
A conversation has no agent until the first prompt; that send binds the
conversation to one platform.

Default tiers:

| Tier | Meaning | Platforms |
| --- | --- | --- |
| `enforced` | The provider or the OS blocks mutation whatever the agent attempts | Codex; Claude where its command sandbox can start; Pi |
| `provider-configured` | The SDK is told to deny, with no independent verification | OpenCode; Cursor; Claude when the sandbox cannot start |
| `advisory` | The agent is asked to request permission first; a tool that does not ask is not stopped | Grok |

**Settings → Agent platforms → Coordinator safety level** chooses the weakest
tier this install will offer. It defaults to `provider-configured`, so Grok
stays opt-in. There is no silent fallback or provider substitution.

Delegation is derived, not declared: the platform must have an MCP client
*and* a mailbox that can inject replies. Native Claude, Codex, OpenCode, Pi,
Cursor, and Grok all have both, so delegation follows. Cursor and Grok
receive a per-tab `agentMcp` on create/prompt like Claude and Pi; the
process-env token is only the fallback.

The conversation always receives a trusted `coordinator-read-only` execution
policy. Codex additionally selects a per-conversation permission profile on
restored sessions and every turn: filesystem denied except the project and
managed Codex runtime, shell network off, isolated `CODEX_HOME` holding only
the credential, project hooks and plugin/browser paths disabled. Claude uses
the SDK command sandbox plus a read-only shell allowlist. Pi's gate runs
inside the bridge on every tool call. The only injected MCP server is the
scoped Orkestrator endpoint. The renderer stores pasted attachments outside
the checkout and hides mode/permission controls, resume/fork, and
file-rewinding actions; the backend independently rejects write-capable
history actions.

The working directory is the canonical `Project.localPath`. Bridge state and a
fresh coordinator `CODEX_HOME` live under application data, and initialization
does not run project setup scripts, dependency installation, environment-file
copying, or repository hooks. Git fetch/sync/switch is implemented by a separate
backend service, serialized by canonical repository root, and blocked while a
coordinator turn or another repository mutation is active. Sync is fast-forward
only with rebase/autostash disabled; switching never forces an occupied or dirty
worktree. Every successful or externally detected branch/HEAD change increments
the repository-context revision included before the next coordinator turn.

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

## Execution policy

The backend resolves one `NativeAgentExecutionPolicy` when it creates a native
agent session. The decision is based on the environment boundary and session
origin, with an optional per-environment override, and is persisted with the
session. Bridges receive the resolved value on `/session/create`, retain it
across detach and restart, and expose it in their authoritative snapshot. The
agent info panel renders that effective value rather than making trust decisions
in the renderer.

Interactive host sessions default to provider sandboxing, explicit approvals,
project resources off, and full network access. Container sessions use the
container as their sandbox, automatically approve inside that boundary, enable
project resources, and follow the environment network setting. Pipeline runs
are unattended. The coordinator always uses the immutable
`coordinator-read-only` policy regardless of an environment override.

| Adapter | Policy mapping |
| --- | --- |
| Claude | `permissionMode` and the approval callback; `allowedTools`/`disallowedTools`; `settingSources`; SDK sandbox options |
| Codex | `approvalPolicy`, thread sandbox and sandbox network; the coordinator's verified permission profile |
| Cursor | local SDK sandbox/auto-review; `settingSources`; `tools`/`disallowedTools`, re-applied on resume |
| Grok | `--always-approve` only for auto-approval; ACP permission requests otherwise; project MCP trust at the launcher boundary |
| Pi | approval extension; resource-loader exclusions and project trust; active SDK tool selection |
| OpenCode | session permission rules; project resources remain enabled because OpenCode owns config discovery, which is stated in the effective policy note |

Legacy bridge environment variables remain accepted temporarily as deprecated
compatibility overrides. Launchers no longer use them for normal sessions; the
backend policy is the source of truth.

## Cursor Agent

**Bridge:** `bridges/cursor-bridge/` · **Transport:** Cursor TypeScript SDK in process

Cursor sessions are SDK-only. The bridge owns one `SDKAgent` per attached
session and translates `InteractionUpdate` events into the shared transcript
shape. Cursor has no managed CLI, terminal mode, or ACP fallback. Local and
container sessions use the same bridge and HTTP routes.

Cursor receives project-resource, sandbox and tool restrictions from the
backend-owned execution policy. Its SDK and native runtime closure are vendored
into the packaged bridge; see `docs/development/upgrade-agents.md` for the build and upgrade
checks.

The backend exports `ORKESTRATOR_AGENT_MCP_URL` and
`ORKESTRATOR_AGENT_MCP_TOKEN` on the bridge process. `src/mcp.ts` turns those
into `AgentOptions.mcpServers.orkestrator` (HTTP, bearer header). A per-tab
`agentMcp` on create/prompt/attach wins over the process env; the token is
never persisted. Project `.cursor/mcp.json` is read only when the execution
policy opts into project settings (containers). Native Cursor mail is on:
`agentMailCapabilities("agent-native", "cursor")` is
`{canPull,canSend,canInject}=true`.

## Grok Build

**Bridge:** `bridges/acp-bridge/` · **Transport:** ACP JSON-RPC over stdio

The bridge spawns the `grok` CLI and speaks the Agent Client Protocol over its
stdio. One bridge process serves the environment and spawns one CLI child per
session, lazily re-attaching through `ensureSessionProcess` when needed. It
launches Grok as `agent [--model M] [--reasoning-effort E] stdio`, adding
`--always-approve` only when the execution policy selects automatic approval.

Because these are command-line flags rather than a typed SDK, **the argv is a
versioned contract that nothing in CI can check** — the bridge's own tests run
against a fake agent that accepts anything, so a renamed upstream flag leaves the
suite green and breaks every session at runtime. `docs/development/upgrade-agents.md` has the
manual verification steps to run after a version bump.

Protocol handling lives in `index.ts`. The bridge sends `initialize`,
`session/new`, `session/load`, `session/list`, and `session/prompt`, and
notifies `session/cancel`. `session/new` and `session/load` pass
`configuredAcpMcpServers(state.agentMcp)`, which injects the Orkestrator
HTTP MCP server from a per-tab `agentMcp` body or, as fallback, the same
process env the other bridges receive. The initialize handshake's
`_meta.mcpServers` is ignored because it is empty before the agent loads
that list. Native Grok mail is on:
`agentMailCapabilities("agent-native", "grok")` is
`{canPull,canSend,canInject}=true`. A rotated tab token closes that
session's CLI child and reloads it; it is never written into process env.

Inbound, it handles `session/update` notifications
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

Pi ships no permission system, so its adapter implements the execution policy's
approval mode on the SDK `tool_call` extension hook. Timeout, disconnect,
session close and a malformed answer all deny, and a turn that ends with a call
still parked denies it rather than leaving the turn awaiting a promise nobody
will settle. The same policy controls project-local `.pi/` extensions, skills
and prompt templates through Pi's resource loader and project-trust callback.

Pi's vendor SDK has no MCP client. The bridge owns one (`bridges/pi-bridge/src/mcp.ts`)
and loads it through `extensionFactories` next to the approval gate: Orkestrator
from env / per-tab `agentMcp` (reserved name, HTTP only), user servers from
`~/.pi/agent/mcp.json`, and project `.pi/mcp.json` only when
`policy.projectResources` is on. Orkestrator tools keep their Agent MCP names;
user/project tools are prefixed `mcp_<server>_<tool>`. `GET /session/:id/mcp`
returns the live inventory. Native Pi mail flags are on; terminal `pi` stays
off. A failed MCP connect is a notice, not a failed attach.

The SDK and the `pi` binary a terminal tab runs are the same program published
two ways, so they are pinned to one version and `tests/unit/version-drift.test.ts`
enforces that the bridge's dependencies, `PINNED_TOOLCHAIN_VERSIONS.pi` and the
Dockerfile's `PI_CLI_VERSION` all agree.

## Workflow results through tool calls

Backend-owned workflows — feature planning, build pipeline stages, review
fan-out, multi-review, and looped review — need a structured result from the
model. Two transports exist, and each attempt records which one it was admitted
under so old records stay readable.

**Tool mode (`tool-v1`).** The backend prepares a durable result slot, mints an
attempt-scoped MCP capability, and attaches it to that one turn. The agent tool
server publishes exactly two tools for that capability: one typed submission
tool for the attempt's result kind, and `get_workflow_result_status`. No Kanban
or mail tool is reachable through it, so a subagent cannot inherit anything
broader. The turn carries no provider final-output schema, and the prompt states
that the tool instruction supersedes any earlier "final JSON only" guidance.

**Legacy mode.** Review and pipeline attempts fall back to
`structured-output-v1`, the provider-enforced final-output schema. Feature
planning falls back to `planner-block-v1`, its tagged state block. Records
written before this transport existed carry no transport field and continue
through their original reader.

`WorkflowResultService` owns the slot lifecycle: `open`, `accepted`, `consumed`,
`cancelled`, `superseded`. It persists to a private file with atomic
replacement and a cross-process lock, so two backend processes sharing a data
directory serialize correctly. Submission returns a stable receipt. An identical
resubmission is deduplicated onto the original receipt, a different payload for
an accepted key is a conflict, and an invalid payload returns bounded
diagnostics the model can correct within a fixed budget. Acceptance is not
completion: the controller still owns turn settlement, worktree and package
checks, validation execution, pool application, stage changes, and PR
verification, and consumes an accepted result exactly once.

### Provider qualification

| Provider | Tool mode | Notes |
| --- | --- | --- |
| Claude | Qualified | Per-turn `agentMcp`; the restricted review policy admits `mcp__orkestrator-workflow-result__*` and nothing else new |
| Codex | Qualified | Per-turn `agentMcp` on the pinned bridge |
| OpenCode | Not qualified | No per-turn MCP attachment; stays on `structured-output-v1` |
| Cursor | Not qualified | No per-turn MCP attachment; stays on `structured-output-v1` |
| Grok (ACP) | Not qualified | No per-turn MCP attachment; stays on `structured-output-v1` |
| Pi | Not qualified | No per-turn MCP attachment; stays on `structured-output-v1` |

An unqualified provider is not a degraded path. It runs the legacy transport it
has always run, with the same validation and the same domain results.

### Rollout and rollback

Admission is a backend-owned setting, `global.workflowResultTools`, not a
user-facing transport choice. It carries a master switch plus per-provider and
per-result-kind lists, and is read through `get_workflow_result_tools_rollout`
and `set_workflow_result_tools_rollout`. The gate is evaluated once, when an
attempt is admitted, and the outcome is persisted on the attempt.

The setting can only narrow the qualified set, never widen it. Qualification is
a property of the code: naming an unqualified provider here has no effect,
because admitting one would dispatch a turn the model has no channel to submit
against.

To roll back, disable the combination. New attempts take the legacy transport
immediately. Attempts already admitted keep their tools and their receipts and
finish normally, so nothing in flight is stranded. Deploying a release that
cannot read `tool-v1` records is only safe once no such records are active:
drain them through the current version first.

### Operational metrics

`get_workflow_result_metrics` returns bounded, content-free counters: attempts,
submission outcomes by a fixed error-code set, distinct corrections, missing
submissions, acceptance and consumption latency, validation and storage
duration, and queue and retention gauges. Series names use only provider,
result kind, transport, schema version, outcome, and error code. Payloads,
prompts, diagnostics, evidence paths, digests, receipt ids, and result keys are
never recorded, and the series table is bounded with an explicit dropped-series
count.

## Where to look next

| Topic | Document |
| --- | --- |
| Agent-to-agent mail, inject, and provider flags | [`docs/architecture/agent-messaging.md`](./agent-messaging.md) |
| Bumping any agent SDK, CLI, or pinned binary | [`docs/development/upgrade-agents.md`](../development/upgrade-agents.md) |
| Background-reliability and transport invariants | [`AGENTS.md`](../../AGENTS.md) |
| Agent-driven real-stack QA | [`docs/development/agent-testing.md`](../development/agent-testing.md) |
| Known flakes and their root causes | [`docs/development/flaky-tests.md`](../development/flaky-tests.md) |

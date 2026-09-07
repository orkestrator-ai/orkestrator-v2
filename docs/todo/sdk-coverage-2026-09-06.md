# Agent SDK coverage review — 2026-09-06

Read-only review of how completely Orkestrator uses each of the six agent
interfaces it provisions, and where the unused surface would give users
something they do not have today. No code was changed. Line references are
against commit `9e86f008` (v2.12.11).

Method: for every platform, the installed SDK typings (or, for Codex, the
generated protocol; for Grok, the bridge's own hand-written ACP shapes) were
enumerated and compared against the bridge, the backend provider layer and the
renderer. "Not used" claims rest on exhaustive greps of non-test sources.

## 1. Executive summary

**Version drift is a non-issue.** Every pin is within one or two patch releases
of the latest published version and every mirror agrees, enforced by
`tests/unit/version-drift.test.ts`.

| Platform | Pinned | Latest on npm (2026-09-06) |
| --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` / Claude CLI | 0.3.261 / 2.1.261 | 0.3.263 / 2.1.263 |
| Codex CLI + generated protocol | 0.153.3 | 0.153.4 |
| `@opencode-ai/sdk` / OpenCode CLI | 1.18.28 | 1.18.29 |
| `@cursor/sdk` | 1.0.31 | 1.0.31 |
| `@earendil-works/pi-coding-agent` / Pi CLI | 0.85.0 | 0.85.1 |
| Grok Build | 1.0.13 | not verifiable (bucket listing denied) |

**The conversation-shaped surface is well covered everywhere.** Create, resume,
prompt, cancel, streaming text and thinking, tool cards, subagents, usage and
cost, and fail-closed approvals all work on every platform, and the platform
differences are documented honestly in the capability table
(`packages/protocol/src/native-agent.ts:394-534`).

**What is under-used, on every platform, is the control and configuration
surface**, plus the tail of the event vocabulary. The same five themes recur:

1. **Silent drops.** Each bridge drops unknown or unhandled events rather than
   degrading them to a visible card. The SDK-typed unions are not imported, so
   an upstream addition never produces a type error. Concrete casualties today:
   Claude `tool_progress`/`auth_status`/`conversation_reset`, Codex
   `imageGeneration`/`enteredReviewMode`, OpenCode `CompactionPart`/`RetryPart`/
   `SubtaskPart`, Cursor `user-message-appended`/`step-*`, Pi `auto_retry_end`,
   Grok non-text content blocks.
2. **No in-app authentication or provider configuration** for any platform
   except Cursor. OpenCode, Pi, Claude, Codex and Grok all have SDK or protocol
   surfaces for login, API keys, OAuth or MCP OAuth that are unused.
3. **MCP is read-only or absent.** No platform can add, toggle, reconnect or
   authenticate an MCP server from Orkestrator. Cursor cannot even see one.
4. **Mid-turn control is uneven.** Steering exists for Codex and Pi only.
   Claude and Cursor both have SDK steering that is unused; Claude aborts by
   killing the CLI process rather than interrupting the turn.
5. **Hand-rolled reimplementations** of things the SDKs now do: slash-command
   discovery (Claude), plan-mode instructions (Claude), fork (Pi), session-file
   parsing (Pi), MCP config parsing (Claude), status polling instead of SSE
   (OpenCode).

Section 2 is the cross-platform matrix, sections 3 to 8 cover each platform,
section 9 ranks the opportunities.

## 2. Cross-platform capability matrix

Legend: ✅ supported · 🟡 partial or conditional · ❌ not supported ·
⛔ not possible with the vendor interface.

| Capability | claude | codex | opencode | cursor | grok | pi |
| --- | --- | --- | --- | --- | --- | --- |
| Native chat mode | ✅ | ✅ | ✅ | ✅ (forced) | ✅ | ✅ |
| Terminal / PTY mode | ✅ | ✅ | ✅ | ⛔ | 🟡 bare argv | ✅ |
| Model picker | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reasoning / thinking picker | ✅ | ✅ | ✅ | ✅ effort only | ✅ | ✅ |
| Fast / speed toggle | ✅ | ✅ | ⛔ | 🟡 per model | 🟡 per model | ⛔ |
| Plan / Build mode | ✅ | ✅ | 🟡 agents instead | 🟡 agent/plan | 🟡 two ids only | ⛔ |
| Execution profile / subagent select | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| File attachments | ✅ | ❌ | ✅ | ⛔ | 🟡 images only | ✅ |
| Image attachments | ✅ | ✅ | ✅ lossy read-back | ✅ base64 only | ✅ | ✅ no steer images |
| Resume | ✅ | ✅ | ✅ | ✅ lossy replay | ✅ | ✅ lossy replay |
| Fork | ✅ | ✅ | ✅ | ❌ (SDK has checkpoints) | ❌ | ✅ non-SDK path |
| Session title | 🟡 vendor | ✅ generator | 🟡 vendor | ❌ | ❌ | ❌ never set |
| Compact | ✅ text prompt | ✅ | ✅ | ❌ | ❌ | ✅ no instructions |
| Steer mid-turn | ❌ (SDK has it) | ✅ | ❌ (v2 has it) | ❌ (SDK has it) | ❌ dormant ext. | ✅ |
| Rewind / checkpoints | ✅ | ❌ (protocol has rollback) | ✅ revert | ❌ (SDK has it) | ❌ | ❌ (SDK has tree) |
| Undo / Redo / Share | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ (export exists) |
| Native code review | ❌ | ✅ half-wired | ❌ | ❌ | ❌ | ❌ |
| Slash commands | ✅ fs scan | ✅ | ✅ | ⛔ | 🟡 count only | 🟡 templates only |
| Approvals / permissions UI | ✅ | ✅ | ✅ polled | ⛔ | ✅ | 🟡 opt-in flag |
| Question cards | ✅ | ✅ | ✅ | ⛔ | 🟡 | ❌ |
| MCP list (settings pane) | ✅ CLI | ✅ CLI | ✅ CLI | ❌ | ✅ CLI | ⛔ |
| MCP manage / OAuth | ❌ | ❌ | ❌ | ❌ | ❌ | ⛔ |
| In-app sign-in | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ by design |
| Background tasks | ✅ | ❌ | ❌ | 🟡 | ❌ | ❌ |
| Context usage | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 null after compact |
| Rate limits | ✅ | ✅ | 🟡 | ❌ | ❌ | ❌ |
| Live SSE (vs poll) | ✅ | ✅ | 🟡 4 of 89 events | ❌ | ❌ | ❌ |
| Coordinator | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Typed SDK union imported | ❌ | ✅ generated | 🟡 | 🟡 | ❌ hand-written | 🟡 |

Two caveats on reading the table. `composer.speed` and `composer.mode` are
`true` for Cursor and Grok in the protocol table but mean "may offer"; the live
composer state decides (`native-agent.ts:475-479`). And there is no capability
bit for approvals, so Cursor's always-empty approval lists are invisible to the
table (`bridges/cursor-bridge/src/http.ts:285-292`).

## 3. Claude (`bridges/claude-bridge`, Agent SDK 0.3.261)

### Where we are

The bridge uses `query()` with partial messages, resume by session id,
structured output, file checkpointing and rewind, prompt suggestions, subagent
discovery, background tasks, plugins, `settingSources`, `mcpServers`, fork,
list/rename/delete session helpers, and usage APIs. Of the SDK's 33 hook
events, one (`PreToolUse`) is used. Of the `Query` control methods, seven are
used and thirteen are not.

### Gaps, ranked

1. **`Query.streamInput()` and `interrupt()` unused**
   (`services/session-manager-prompt.ts:751`, `-lifecycle.ts:502,531`). Each
   turn spawns a fresh CLI process and re-resumes; abort kills the process
   instead of interrupting the turn. This is the root cause of the ~450 lines
   of continuation-timer and background-task-control machinery, and why Claude
   has no steering. `perTaskStopAffordance` is also never declared, so an
   interrupt kills background tasks.
2. **`result.is_error` ignored** (`-prompt.ts:1787-1904`). A `success` result
   with `is_error: true` (turn ended on an API error) is published as
   `session.idle { success: true }`.
3. **`mcpServerStatus()` unused.** Status is read from `system/init.mcp_servers`,
   which the SDK types as `{name, status}` only, so the `error` and `tools`
   fields the bridge reads (`-prompt.ts:1200-1203`) are always undefined, and
   `needs-auth`/`pending`/`disabled` are shown as `failed`. `reconnectMcpServer`,
   `toggleMcpServer` and `setMcpServers` would give a real MCP panel.
4. **Five top-level message types have no branch**: `tool_progress`,
   `tool_use_summary`, `auth_status`, `conversation_reset`, `active_goal`.
   About twenty `system` subtypes reach a generic `system.message` emit that
   has zero consumers in the renderer or backend (`claude-client.ts:610,1690`).
   Long-running tool heartbeats and auth-in-progress are invisible.
5. **No `onElicitation` / `onUserDialog`.** MCP OAuth and form elicitation
   requests park until the worker deadline.
6. **`supportedCommands()` and `initializationResult()` unused.**
   `services/slash-commands.ts` walks the filesystem and hard-codes a 15-entry
   builtin list that will drift from the CLI.
7. **`planModeInstructions` unused.** Plan mode is a hand-written
   system-reminder prepended to the user prompt (`-prompt.ts:415-430`).
8. **`canUseTool` discards most of its input** (`-prompt.ts:840-1084`):
   `suggestions`, `blockedPath`, `decisionReason`, `agentID` and friends, and
   never returns `updatedPermissions`. Only three tools are branched on.
9. **Permission modes**: the route accepts six, the backend sends two.
   `acceptEdits`, `default`, `dontAsk`, `auto` are dead
   (`apps/backend/src/core/http-bridge-provider.ts:406`).
10. **Session titles** spawn a separate `claude --print` subprocess
    (`-core.ts:1069-1108`) rather than using `Options.title` or the SDK's own
    `summary`.
11. Unused but plausibly valuable: `thinking` budgets (hard-coded adaptive),
    `maxBudgetUsd`, `betas` (1M context), `sandbox`, `additionalDirectories`,
    `skills`, `agents` (inline subagent definitions), `disallowedTools`,
    `accountInfo()`, `getSubagentMessages()` for resumed subagent detail,
    `WarmQuery` to skip cold spawn, `createSdkMcpServer()` for in-process
    Orkestrator tools.
12. **Type safety**: the bridge declares its own structural message types
    (`types/index.ts:25-99`) and casts through `any`; the SDK's `SDKMessage`
    union is never imported.

Doc drift: `docs/upgrade-agents.md:240` still names `session-manager.ts` as the
compatibility surface; it is now an 8-line barrel.

## 4. Codex (`bridges/codex-bridge`, app-server protocol 0.153.3)

### Where we are

The generated protocol has 102 client requests, 83 notifications and 10 server
requests. The bridge sends 18 requests, handles 21 notifications, explicitly
ignores 51, and answers all 10 server requests (the router is exhaustive). Ten
of nineteen thread item types render. Review mode, steer, compact, fork, model
list with efforts and service tiers, rate limits and token usage all work.

### Gaps, ranked

1. **`openaiForm` MCP elicitations auto-cancel**
   (`app-server/interactions.ts:185`). The protocol defines four modes; the
   bridge accepts three, while advertising `mcpServerOpenaiFormElicitation`
   in the handshake. One-line fix.
2. **Three `thread/realtime/item/*` notifications missing from the ignore
   list** (`app-server/event-reducer.ts:150-157`), so they inflate the
   `unknownNotifications` drift counter for a feature declared out of scope.
3. **Eight genuinely unhandled notifications**: `thread/reverted`,
   `thread/queue/changed`, `project/changed`, `thread/project/updated`,
   `autoApprovalReview/strictReviewRequired`,
   `mcpServer/event/stream/notification`,
   `modelProvider/authRecovery{Started,Completed}`.
4. **`item/permissions/requestApproval` with no tab attached cancels with a
   protocol error** (`server-request-router.ts:413-423`) instead of answering
   an empty grant, so unattended pipeline and coordinator turns hard-fail on
   permission escalation when they could continue sandboxed.
5. **Review mode is half-wired**: `review/start` works but
   `enteredReviewMode`/`exitedReviewMode` items are dropped
   (`item-adapter.ts:286-295`), so a review turn looks like an ordinary turn.
6. **Dropped item types**: `imageGeneration` (generated images vanish),
   `imageView`, `contextCompaction`, `hookPrompt`, `sleep`,
   `functionCallOutput`.
7. **Advisory notifications never reach the chat**: `deprecationNotice`,
   `configWarning`, `guardianWarning`, `warning`, `model/rerouted` are captured
   only on the authenticated `/runtime-health` route.
8. **Goals enabled but unwired**: `features.goals=true` and a `/goal` slash
   command, but no `thread/goal/*` RPCs and both goal notifications ignored.
9. **Richer approval decisions unreachable**: the protocol supports
   `acceptWithExecpolicyAmendment` and `applyNetworkPolicyAmendment`; the card
   offers accept / accept-for-session / decline.
10. **`isBlocking` ignored in favour of deprecated `autoResolutionMs`**
    (`interactions.ts:131-133`), so non-blocking questions are treated as
    blocking.
11. **Streaming gaps**: `item/plan/delta`, `item/mcpToolCall/progress`,
    `item/fileChange/outputDelta` are ignored, so plans and MCP calls do not
    stream.
12. Whole protocol families unused: `thread/rollback` and `thread/revert`
    (message-level rewind), `thread/archive`, thread sections, `config/*`
    (config is CLI overrides at spawn only), `account/*` and login,
    `permissionProfile/list`, MCP OAuth, plugins and marketplace, `command/exec`
    and `fs/*`, `feedback/upload`, `gitDiffToRemote`, dynamic tools
    (`item/tool/call` always fails).

## 5. OpenCode (backend-driven, SDK 1.18.28)

### Where we are

All imports are `/v2/client`, but the repo drives the **legacy v1 session
protocol** through it. Zero call sites use `client.v2.*`. Of ~150 methods in
45 namespaces, 34 in 10 namespaces are used. Fork, share, revert, summarize,
questions with multi-select and custom answers, permissions, agents, model
variants, slash commands and recursive child-session hydration all work.
`docs/todo/opencode-v2.md` already records the deferred v2 migration.

### Gaps, ranked

1. **4 of 89 SSE events handled** (`apps/backend/src/core/opencode-provider.ts:511-563`):
   `permission.asked`, `question.asked/replied/rejected`. Transcript, status,
   todos, diff, errors and compaction are all **polled**. Every transcript
   update is a full `session.messages` refetch with recursive child refetches.
   `message.part.delta` and all `session.next.*` deltas are unused, so nothing
   streams token by token.
2. **4 of 12 part types rendered**. Dropped with no fallback card:
   `SubtaskPart` (the first-class subagent part; subagents are reconstructed
   from `ToolPart` heuristics instead), `CompactionPart`, `RetryPart`,
   `SnapshotPart`, `PatchPart`, `AgentPart`, `StepStartPart`. `FilePart`
   read-back drops `mime` and `source`, so inbound images render as generic
   file rows. `ToolStateCompleted.attachments` is never read.
3. **Dead code in the renderer**: `openCodeStore.pendingPermissions`,
   `replyToPermission`, `subscribeToEvents` and `OpenCodeQuestionCard` have no
   production caller; the live path is the neutral interaction card. The
   `OpenCodeQuestionCard` / `openCodeStore` entries in AGENTS.md describe a
   path that is not the one in use.
4. **No provider auth or config**: `provider.auth`, `provider.oauth.*`,
   `auth.set/remove`, `config.get/update`, `v2.integration.*`, `v2.credential.*`
   all unused. There is no in-app way to sign in to a provider.
5. **MCP is status-only**: `mcp.add/connect/disconnect/auth.*` unused;
   `mcp.tools.changed` unhandled.
6. **Saved "always allow" rules cannot be viewed or revoked**
   (`v2.permission.saved.*` unused).
7. **Unattended mode auto-rejects every permission**
   (`opencode-provider.ts:551-562`); no per-project allow policy.
8. **Prompt payload is untyped** (`parts: any[]`, cast `as never`), so SDK
   changes to the prompt shape pass typecheck.
9. Unused v2 capabilities worth a look once the migration lands:
   `session.prompt({delivery: steer|queue})`, `switchAgent`, `switchModel`,
   `session.context`, `session.events` replay, staged revert, `reference.list`
   for `@` mentions, `find.*` for file search.

## 6. Cursor (`bridges/cursor-bridge`, `@cursor/sdk` 1.0.31)

### Where we are

Create/resume, model and mode per send, delta streaming, 15 of 16 typed tool
kinds rendered, subagent lifecycle, cancel, idempotency keys, usage and cost,
browser login with a relocated credential store, and history replay via
`Run.conversation()`. The SDK has no approval hook, no slash commands, no
"ask" mode and no file attachments, so those cells are vendor limits.

### Gaps, ranked

1. **Sandbox and auto-review are off on host runs.** `local.sandboxOptions`
   defaults off unless `CURSOR_BRIDGE_SANDBOX=1`, which nothing in the backend
   sets (`config.ts:85`), and `local.autoReview` is never passed. Combined with
   no approval surface and no `tools`/`disallowedTools`, a host worktree tab
   runs `shell`, `write`, `delete` and `task` unsandboxed and ungated. The
   container boundary covers container runs; host runs have no boundary.
2. **No MCP at all from Orkestrator's side.** `AgentOptions.mcpServers` is
   never set, and on host runs `settingSources` is `["user"]` only
   (`commands-servers.ts:1016`), so a repo's `.cursor/mcp.json` and rules are
   invisible on the host but active in a container. Same repo, different agent.
3. **`Run.steer()` unused** (`run.d.ts:61`); a prompt while running is a 409.
4. **`Run.stream()` is drained but only `usage` is read**
   (`prompt.ts:519-523`). The `system` message carrying the actual toolset and
   model, `status`, `request` and `task` messages are discarded.
5. **Five `InteractionUpdate` members dropped**: `user-message-appended`
   (a steered message would never show), `summary-started/completed`,
   `step-started/completed`. `thinking-completed` duration and `modelCallId`
   are discarded.
6. **Crash recovery unavailable.** `Agent.getRun`, `cancelRun` and
   `SendOptions.local.force` (the SDK's documented "wedged after a crashed
   process" path) are unused; resume failure silently creates a new agent
   (`agent-session.ts:144-152`).
7. **Checkpoints and revert** (`AgentCheckpointStore`, `CheckpointRef`) exist
   in the SDK and are unused; Cursor has no rewind.
8. **Custom tools and custom subagents** (`local.customTools`,
   `AgentOptions.agents`) unused, so Orkestrator cannot inject its tools the
   way it does for Claude.
9. **Model axes**: `thinking`, `context`, `cyber` parameters and variants are
   dropped (`models.ts:16-17`); only effort and fast are offered.
10. **Cloud agents** (`CloudAgentOptions`, auto-PR, `RunResult.git`) entirely
    unexposed; `runtime: "local"` is hard-coded.
11. **Degraded renderers**: `grep` and `readLints` results are JSON-stringified
    despite typed outputs; `createPlan` is a plain card; `recordScreen` falls
    to the generic card; `updateTodos` reaches the client as a count only.
12. **Local store**: `sqlite3` is not installed, so agent/run/checkpoint
    persistence lands in the SDK's JSONL store under its default root, not
    under `CURSOR_BRIDGE_STATE_DIR`.
13. **`askQuestion`** appears in `ToolName` but has no typed `ToolCall`
    variant; if it surfaces it renders as an inert JSON card with no way to
    answer, and `/interactions` always returns `[]`.

## 7. Grok Build (`bridges/acp-bridge`, ACP v1 over stdio)

### Where we are

Initialize, `session/new`, `session/load`, `session/list`, `session/prompt`,
`session/cancel`, `session/set_mode`, `session/set_model` (with effort in
`_meta`), `session/set_config_option`, and `session/request_permission` are
implemented. Resume is the strongest part: HMAC-signed session tokens, a
three-state history replay machine, and stale tool reconciliation. Usage merges
three carriers. A Grok interjection (steer) extension is implemented but
dormant because ACP v1 has no mid-turn input.

Note the bridge has **no vendored ACP schema**. Every wire shape is hand-written
`JsonObject` with guards; the negotiated `protocolVersion` in the initialize
response is never read. The `@agentclientprotocol/sdk` package (1.4.0) is not a
dependency.

### Gaps, ranked

1. **Client-side `fs/*` and `terminal/*` declined**
   (`acp-context.ts:704-706`). Terminal content blocks render as the literal
   placeholder `[Terminal <id>]` forever. This is the largest spec hole and
   the main blocker to hosting other ACP agents.
2. **Slash commands: count only.** `available_commands_update` stores
   `availableCommands.length` and discards names
   (`acp-session.ts:664-671`); the backend then hard-returns `[]`.
3. **Non-text content blocks dropped.** `contentText` returns `""` for
   `image`, `audio`, `resource`, `resource_link`, and the update is discarded
   (`acp-transcript.ts:523-528`, `acp-session.ts:727-728`). An agent replying
   with an image produces nothing.
4. **No `authenticate`.** `authMethods` from initialize is never inspected.
   An unauthenticated Grok surfaces as a spawn failure, not a sign-in state;
   there is no `/global/auth` route.
5. **No MCP passthrough.** Every `session/new` sends `mcpServers: []` with no
   code path to populate it. `--always-approve` is unconditional on host
   worktrees as well as containers.
6. **Modes capped at two ids** (`session-config.ts:628-643`); anything other
   than agent/code/build/plan/architect/ask is silently dropped.
7. **Cost withheld**: Grok's `costUsdTicks` is rejected as undocumented, so
   cost is always absent (`usage.ts:86-90`).
8. **Unknown `session/update` kinds vanish** with no log or counter
   (`acp-session.ts:708-715`); `stopReason` is never inspected.
9. **Generic hosting**: provider is pinned to `grok` in three places, argv is
   a hard-coded ternary, and ~1,400 lines of Cursor-era code ship in the
   bundle. Hosting Gemini CLI or Claude-over-ACP would need items 1, 2, 4, 6
   plus unpinning.

## 8. Pi (`bridges/pi-bridge`, `@earendil-works/pi-coding-agent` 0.85.0)

### Where we are

`createAgentSession` with the shared model runtime, resource loader, session
manager and settings; prompt with images and template expansion; steer with a
durable journal; abort; compact; model and thinking level with Pi's own
clamping and echo; fork via `createBranchedSession`; per-provider auth status;
one inline `tool_call` approval extension. Pi has no subagents and no MCP
client, so those cells are vendor limits. `pi-agent-core` and `pi-server` are
declared dependencies but never imported.

### Gaps, ranked

1. **`bindExtensions()` is never called.** Tool hooks work because the
   constructor installs them, but `session_start` never fires,
   `resources_discover` never runs (extension-contributed skills and prompts
   are silently absent), no UI context is bound, and extension errors are
   swallowed. The SDK's own RPC host (`dist/modes/rpc/rpc-mode.js`) shows the
   full binding sequence.
2. **`followUp()` unused and `/queue` route dead.** The bridge publishes Pi's
   queue at `GET /session/:id/queue` but nothing in the backend reads it; a
   prompt while running is a 409 and the backend queues it in its own store.
3. **Skills and extension commands never advertised.** `readSlashCommands`
   lists prompt templates only (`agent-session.ts:904-915`); `/skill:name`
   works if typed but is not in the picker. `getRegisteredCommands()` unused.
4. **Session titles never set.** The bridge reads `session_info_changed` but
   never calls `setSessionName()`, and nothing in the SDK core auto-titles, so
   a Pi tab has no title unless the user sets one.
5. **Fork bypasses `AgentSessionRuntime.fork()`** (`agent-session.ts:719`):
   semantics differ (`at` vs `before`, so the selected message is included
   rather than handed back for editing), `session_before_fork` never fires,
   and the start reason is `startup`.
6. **Historic replay renders only `message` entries** (`agent-session.ts:767`),
   so compaction summaries, branch summaries, model and thinking changes
   vanish from a resumed transcript. The SDK exports typed
   `parseSessionEntries` and friends.
7. **Context usage probes the wrong keys.** `readContextUsage` looks for
   `totalTokens ?? tokens ?? used` but `ContextUsage` is typed as
   `{tokens, contextWindow, percent}`, and `tokens` is `null` right after
   compaction, so occupancy silently degrades exactly when it matters.
8. **Session tree unused**: `getTree`, `navigateTree`, `branch`,
   `branchWithSummary`, labels, `entry_appended`. Users cannot revisit a
   branch.
9. **Settings never persisted**: `setModel`/`setThinkingLevel` are called
   without `{persist: true}`, so a tab's choice does not become the Pi default.
10. **Compaction and retry control**: no custom instructions, no
    `abortCompaction`, no auto-compaction toggle, `auto_retry_end` dropped so
    the "Retrying…" card goes stale.
11. **Images**: no steer images, no `resizeImage`/`convertToPng` (oversized
    images sent raw), tool-result images stringified to `[image]`.
12. **Discarded diagnostics**: `extensionsResult` and `modelFallbackMessage`
    from `createAgentSession` are dropped; `reload()` is called without
    `resolveProjectTrust`.
13. Provider login remains out of scope by design, but
    `getProviderAuthStatus`, `isUsingOAuth` and `isUsingSubscription` would
    enrich the read-only status without adding a login flow.

## 9. Opportunities, prioritized

### Tier 1: correctness or safety, small

| # | Platform | Change | Where |
| --- | --- | --- | --- |
| 1 | Claude | Honour `result.is_error`; publish failure instead of `success: true` | `session-manager-prompt.ts:1787-1904` |
| 2 | Codex | Accept `openaiForm` elicitation mode | `app-server/interactions.ts:185` |
| 3 | Codex | Add the three `thread/realtime/item/*` names to the ignore list | `event-reducer.ts:150-157` |
| 4 | Codex | Read `isBlocking` instead of deprecated `autoResolutionMs` | `interactions.ts:131-133` |
| 5 | Cursor | Decide a host-run policy: enable `sandboxOptions` and/or `autoReview`, or document that host tabs are ungated | `config.ts:85`, `agent-session.ts:135` |
| 6 | Pi | Fix `readContextUsage` to the typed `ContextUsage` shape | `prompt.ts:243-251` |
| 7 | Pi | Call `bindExtensions()` after session creation | `agent-session.ts:340` |
| 8 | Grok | Log or count unknown `session/update` kinds | `acp-session.ts:708-715` |

### Tier 2: visible feature gaps, medium

| # | Platform | Change |
| --- | --- | --- |
| 9 | Claude | Use `mcpServerStatus()` for the MCP panel; map `needs-auth`/`pending`/`disabled` distinctly |
| 10 | Claude | Handle `tool_progress`, `auth_status`, `conversation_reset`, `tool_use_summary`; give `system.message` a consumer or stop emitting it |
| 11 | Claude | Wire `onElicitation` and `onUserDialog` to the interaction card |
| 12 | Claude | Replace filesystem slash-command scan with `supportedCommands()` / `initializationResult()` |
| 13 | Codex | Render `enteredReviewMode`/`exitedReviewMode` and `imageGeneration` items |
| 14 | Codex | Surface `deprecationNotice`/`configWarning`/`guardianWarning` in chat, not only runtime-health |
| 15 | Codex | Handle the eight unhandled notifications (handle or ignore) |
| 16 | OpenCode | Render `SubtaskPart`, `CompactionPart`, `RetryPart`; keep `mime`/`source` on `FilePart` |
| 17 | OpenCode | Consume `session.status`, `session.idle`, `todo.updated`, `session.diff`, `session.error` SSE events to cut polling latency |
| 18 | OpenCode | Remove or wire the dead `openCodeStore` permission path and `OpenCodeQuestionCard`; update AGENTS.md |
| 19 | Cursor | Read the `system` message from `Run.stream()` for the real toolset; render `user-message-appended` |
| 20 | Cursor | Pass `mcpServers` and decide whether host runs load `project` settings |
| 21 | Grok | Carry `availableCommands` names through to the slash-command picker |
| 22 | Grok | Render non-text content blocks (at least images) |
| 23 | Pi | Advertise skills and extension commands in the picker; set session names |
| 24 | Pi | Replay all session entry kinds using the SDK's typed parser |

### Tier 3: larger architectural moves

| # | Platform | Change |
| --- | --- | --- |
| 25 | Claude | Move to one long-lived `query()` with `streamInput()` and `interrupt()`; unlocks steering, graceful stop, `setModel`/`setPermissionMode` mid-session, and retires the continuation-timer machinery |
| 26 | Cursor | Add steer via `Run.steer()`, checkpoints/revert, and crash recovery via `getRun`/`cancelRun`/`local.force` |
| 27 | OpenCode | Adopt the v2 session protocol (`session.next.*` streaming, `delivery: steer`, `switchAgent`/`switchModel`, saved permission rules) per `docs/todo/opencode-v2.md` |
| 28 | Codex | Add `thread/rollback`/`thread/revert` for message-level rewind; wire goals; expose exec-policy and network-policy amendments on approval cards |
| 29 | Grok | Implement client `fs/*`, `terminal/*` and `authenticate`, open the mode mapping, and vendor the ACP schema; this is also the path to hosting other ACP agents |
| 30 | Pi | Use `AgentSessionRuntime.fork()`, `followUp()`, and the session tree |
| 31 | All | Import each SDK's message union and make the dispatch exhaustive, so an upstream addition fails typecheck instead of vanishing |
| 32 | All | A shared "provider sign-in / MCP management" surface; today only Cursor can sign in from the app and no platform can manage MCP |

### Cross-cutting

- **Approvals capability bit.** The protocol table has no flag for "this
  platform can raise approvals", so Cursor's empty lists and Pi's opt-in gate
  are invisible to the renderer. Adding one would let the UI say so.
- **Host versus container parity.** Cursor loads project settings only in
  containers; Grok passes `--always-approve` everywhere; Pi loads project
  resources only in containers. These are deliberate trust boundaries, but the
  user sees the same repo behave differently and nothing tells them why.
- **`docs/todo/platform-inconsistencies.md`** (2026-08-16) predates Pi and the
  Cursor SDK bridge; this document supersedes its feature matrix.

# Native agent platform opportunities

**Reviewed:** 26 July 2026  
**Scope:** Claude Native, OpenCode, and Codex Native  
**Compatibility baseline:** Claude Agent SDK `0.3.219`, OpenCode SDK/server `1.18.4`, Codex app-server protocol `0.145.0`

## Implementation status

All opportunities identified in this review have now been addressed against the pinned platform versions.

| Area | Delivered |
| --- | --- |
| Shared information surface | A title-bar information button now owns context, token breakdowns, cost, duration, limits, credits, profiles, runtime health, and native session actions. On mobile it sits immediately left of the tools spanner. Provider estimates are labelled; provider-reported values are not presented as estimates. |
| Codex interactive input | Ordinary questions, secret/free-text/choice answers, MCP typed forms, and MCP URL completion are parked by generation and thread, rehydrated from a snapshot endpoint, emitted over replayable SSE, and cancelled fail-closed on expiry, close, or restart. |
| Claude continuity | SDK-backed session discovery, lazy transcript hydration, restart recovery, durable rename/delete/fork, deterministic SDK IDs, and continued sessions are supported. |
| OpenCode command fidelity | Exact known slash commands dispatch through the native v2 command endpoint; ordinary and unknown slash-prefixed text still uses normal prompting. |
| Usage and limits | Claude result/context/rate events, OpenCode assistant cost/token metadata, and Codex token/rate notifications feed a common authoritative snapshot. |
| Forking | Claude, OpenCode, and Codex can fork the latest session. Eligible user-message rows expose native “Fork from here”; Codex records the accepted turn boundary explicitly. |
| Profiles and settings | Claude supported agents and OpenCode primary/all agents are selectable. Claude local settings and provider prompt suggestions are explicit per-session opt-ins. |
| Runtime health | Claude MCP/plugins/commands, OpenCode MCP/skills/LSP/formatter/todos/diffs, and Codex engine/MCP/skills/hooks/notices are surfaced outside the transcript. |
| Compaction | All providers use their native compaction/summarization mechanisms from the session actions panel. |
| Codex steering and review | A running Codex turn can be explicitly steered with an expected-turn precondition. Native review of uncommitted changes is available from an idle materialized session. |
| Background and undo controls | Claude background tasks can be stopped and file checkpoints previewed/rewound. OpenCode exposes revert/unrevert plus privacy-confirmed share/unshare. Claude suggestions appear as one-click drafts only when opted in. |

The remainder of this document records the review findings and the rationale behind those implementations.

## Executive summary

The integrations already cover the difficult fundamentals well: streamed conversations, background execution, model and reasoning controls, attachments, tool rendering, structured output, plan/review flows, and rehydration of most pending interactions. Codex Native in particular has a careful supervisor, replayable event stream, fail-closed approvals, and reconciliation after ambiguous failures. OpenCode rehydrates status, messages, questions, permissions, and child sessions. Claude Native surfaces questions and plan approvals and resumes an SDK session while its bridge process remains alive.

The review found a small number of missing native capabilities that created visible product gaps:

1. **Add Codex interactive questions and MCP elicitation.** The app-server sends typed requests for these, but the bridge currently cancels them.
2. **Make Claude sessions recoverable after a bridge restart.** The SDK persists sessions and exposes session discovery/history APIs, while the bridge's Orkestrator session registry is currently memory-only.
3. **Dispatch OpenCode slash commands through `session.command`.** Commands are discovered for autocomplete, but submitted text always goes through `promptAsync`.
4. **Build one provider-neutral usage and limits surface.** All three platforms expose better token, cost, context, or rate-limit data than is currently retained.
5. **Offer “Fork from here” across all three platforms.** Each pinned platform supports a native branch/fork operation.

Those changes formed the first implementation tranche, followed by the remaining native lifecycle and runtime-health opportunities described below.

## Current strengths

Several platform capabilities are already being used effectively and should be preserved:

- **Background-safe state:** Codex keeps authoritative execution state in the bridge/app-server, and OpenCode rehydrates session status and pending interactions from server snapshots rather than relying only on mounted React state.
- **Reliable interactive approvals:** Claude questions/plan approvals, OpenCode questions/permissions, and Codex command/file approvals have explicit pending-state APIs and fail-safe cancellation behavior.
- **Native model controls:** Each integration discovers or uses provider model metadata and exposes relevant reasoning, effort, variant, or fast-mode controls.
- **Rich output normalization:** Tool calls, patches, task lists, thinking/reasoning, attachments, structured output, and child/subagent activity are translated into a shared chat experience without forcing the providers into an identical wire model.
- **Codex lifecycle safety:** The app-server supervisor avoids ambiguous redispatch, protects the stdout read loop from consumer stalls, reconciles via `thread/read`, detaches idle threads without deleting rollouts, and replays SSE from a cursor.
- **OpenCode v2 correctness:** The frontend uses `@opencode-ai/sdk/v2/client` and the v2 flat parameter shapes.

The recommendations below extend these strengths rather than replacing them.

## Prioritized opportunities

| Priority | Opportunity | Platform | Value | Estimated effort |
| --- | --- | --- | --- | --- |
| P0 | Interactive questions and MCP elicitation | Codex | Very high | Medium–large |
| P0 | Durable session discovery and restart recovery | Claude | Very high | Large |
| P1 | Native slash-command dispatch | OpenCode | High | Small |
| P1 | Exact usage, cost, context, and rate-limit telemetry | All | High | Medium |
| P1 | “Fork from here” | All | High | Medium–large |
| P2 | Agent/profile selection | Claude, OpenCode | Medium–high | Medium |
| P2 | Capability and runtime-health drawer | All | Medium–high | Medium |
| P2 | Native compaction controls | All | Medium | Medium |
| P2 | In-flight steering | Codex | Medium | Medium |
| P2 | Native review entry point | Codex | Medium | Medium |
| P3 | Background-task progress and controls | Claude, Codex | Medium | Medium |
| P3 | Provider-specific undo/rewind | Claude, OpenCode | Medium | Medium |
| P3 | Prompt suggestions | Claude | Low–medium | Small |

## Detailed recommendations

### 1. Codex: support interactive questions and MCP elicitation

**Finding**

The generated `0.145.0` protocol includes `item/tool/requestUserInput` and `mcpServer/elicitation/request`. The server-request router currently answers a user-input request with an empty answer map and cancels MCP elicitation. The initialize handshake also opts out of OpenAI form elicitation.

This is safe—turns do not hang—but it prevents Codex and connected MCP servers from collecting information they need. The result can be a cancelled turn or lower-quality behavior where the model has to guess instead of asking.

**Recommendation**

Implement the same authoritative pending-interaction pattern already used elsewhere:

- Park each live request in the bridge with its app-server generation, thread, turn, item, timeout, and typed question/form payload.
- Expose a per-session pending snapshot, emit replayable SSE changes, and reconcile it whenever the tab mounts or becomes active.
- Render ordinary Codex questions first. Support choice and free-text answers plus `autoResolutionMs`.
- Add MCP form elicitation second, then enable `mcpServerOpenaiFormElicitation`. Treat URL elicitation as an explicit link/open action and never submit it silently.
- Deny or cancel on timeout, disconnect, dead generation, malformed input, or session close. Never answer a request belonging to a dead app-server generation.

This should reuse a provider-neutral interaction card where possible, but preserve the provider's exact answer schema in the bridge.

**Evidence:** [`server-request-router.ts`](../bridges/codex-bridge/src/app-server/server-request-router.ts) and [`process-supervisor.ts`](../bridges/codex-bridge/src/app-server/process-supervisor.ts).

### 2. Claude: recover persisted sessions after a bridge restart

**Finding**

The Claude bridge creates its own session ID and stores sessions in a process-local `Map`. Listing sessions and reading messages use only that map. The SDK session ID is captured from the initialization message and passed to `resume`, but only as a field on that in-memory record.

The pinned Agent SDK already exposes persisted-session operations including `listSessions`, `getSessionInfo`, `getSessionMessages`, `renameSession`, `deleteSession`, and `forkSession`. A bridge restart therefore loses Orkestrator's discovery/mapping layer even though the underlying Claude transcript may still exist.

**Recommendation**

Make the SDK session store the durable source for Claude transcript identity:

- Persist the Orkestrator session ID ↔ SDK session ID mapping and local UI metadata as soon as the SDK init message arrives.
- On bridge startup and session-list requests, reconcile persisted mappings with `listSessions`/`getSessionInfo`.
- Rebuild a normalized transcript from `getSessionMessages` when a session is opened after restart. Cache the normalized form, but do not make the cache the only copy.
- Route rename and explicit deletion to both Orkestrator metadata and the SDK session APIs.
- Define behavior for the short pre-initialization window: a newly created session with no SDK session ID is local-only and may safely disappear unless Orkestrator persists its draft metadata.
- Test: start a turn, switch environments, restart the bridge after completion, return, reopen the session, continue it, and verify pending/status controls.

This aligns Claude Native with the project's background reliability rule and with the stronger recovery behavior already present in Codex and OpenCode.

**Evidence:** [`session-manager.ts`](../bridges/claude-bridge/src/services/session-manager.ts) and the pinned SDK declarations in `bridges/claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.

### 3. OpenCode: use the native slash-command endpoint

**Finding**

OpenCode command metadata is loaded with `client.command.list()` and used for autocomplete. Selecting a command inserts text into the compose bar. Submission ultimately always calls `client.session.promptAsync`, even though the pinned v2 SDK exposes the separate `client.session.command` operation.

This may cause command text to be treated as a normal model prompt rather than invoking the server's registered built-in, project, or plugin command semantics.

**Recommendation**

At send time, parse the first token and compare it with the discovered command list:

- For an exact known command, call `session.command` with the command name, arguments, session, directory/workspace, model, and agent fields required by the pinned SDK.
- Continue to use `promptAsync` for ordinary text and unknown `/text`.
- Do not dispatch a command natively while a turn is busy unless the endpoint explicitly supports it; retain the existing queue behavior otherwise.
- Add contract tests for a command with arguments, a project command, an unknown slash-prefixed prompt, queued input, and failure recovery.

This is a small change with a clear fidelity payoff.

**Evidence:** [`opencode-client.ts`](../apps/web/src/lib/opencode-client.ts) and [`OpenCodeComposeBar.tsx`](../apps/web/src/components/opencode/OpenCodeComposeBar.tsx).

### 4. All platforms: expose exact usage, context, cost, and limits

**Finding**

The integrations show some context usage, but discard or ignore richer provider data:

- Claude result messages include cost, duration, usage, per-model usage, and permission denials. The query also exposes context usage, and the pinned SDK has usage/rate-limit data and rate-limit events.
- OpenCode assistant messages include exact cost and token data in addition to model/provider details.
- Codex emits `thread/tokenUsage/updated` and `account/rateLimits/updated`; both are currently explicitly ignored by the event reducer. Read APIs also exist for rate limits and usage.

**Recommendation**

Create a provider-neutral `AgentUsageSnapshot` with:

- current context tokens and context-window size;
- last-turn and session totals where available;
- input/output/cache/reasoning breakdown where available;
- monetary cost only where the provider supplies it;
- rate-limit windows, reset times, and credits where available;
- source, timestamp, and an `estimated` flag so heuristic values are never presented as exact.

Keep the authoritative latest snapshot in the bridge/server/store, serve it on rehydrate, and use live events only as incremental updates. The UI can add a compact context meter plus an expandable usage/limits panel. Do not manufacture cross-provider cost comparisons when billing models differ.

### 5. All platforms: add “Fork from here”

**Finding**

All three pinned platforms expose native branching:

- Claude: `forkSession`, including a message boundary.
- OpenCode: `session.fork`, optionally at a message.
- Codex: `thread/fork`, optionally at the last turn.

Orkestrator does not currently turn this common capability into a consistent workflow.

**Recommendation**

Add “Fork from here” to eligible user/turn menus. The result should open as a distinct session, retain parent/branch metadata, receive a new editable title, and rehydrate independently. The provider adapters should translate the selected normalized message to the provider's native message or turn identifier.

Important edge cases are an in-progress parent, a compacted history, a provider message without a stable boundary ID, and a fork whose creation succeeds but whose response is lost. Reconcile through the provider's session/thread list rather than blindly retrying.

This is more useful than provider-specific “duplicate chat” because it preserves the platform's native context boundary.

### 6. Claude and OpenCode: expose custom agent/profile selection

**Finding**

The Claude query supports a named primary agent and can discover supported agents. OpenCode can list configured agents and already accepts an `agent` on prompts, but the UI effectively limits the selection to the built-in build/plan modes.

**Recommendation**

Add an optional agent/profile selector populated from Claude `supportedAgents()` and OpenCode `app.agents()`/the pinned equivalent. Keep Build and Plan prominent defaults, then show user/project agents with their description, model, and permission characteristics. Re-fetch when configuration changes and fall back gracefully when a saved agent is removed.

Do not flatten subagents and primary agents into one concept: this selector chooses the top-level execution profile; the existing child/subagent UI continues to describe work delegated during a turn.

### 7. All platforms: add a capability and runtime-health drawer

**Finding**

There is useful runtime metadata that is either only captured during initialization or not surfaced:

- Claude: commands, agents, MCP status, plugins, account information, and dynamic command/plugin changes.
- OpenCode: MCP, LSP, formatter, agents, and server configuration.
- Codex: MCP startup/status, skills, hooks, config warnings, model reroutes, and deprecation notices. Several notifications are deliberately ignored by the transcript reducer.

**Recommendation**

Add an environment-scoped “Agent runtime” drawer with authoritative snapshots for:

- active provider and version;
- model/agent;
- MCP servers and connection errors;
- loaded skills/plugins/hooks;
- LSP/formatter health where OpenCode supplies it;
- actionable warnings, deprecations, and model reroutes.

Operational events do not belong in the chat transcript, so keeping them out of normalized messages is correct. They should instead update a bounded backend health snapshot and a small visible warning badge.

### 8. All platforms: provide native compaction controls

**Finding**

Claude reports compact boundaries, OpenCode exposes session summarization, and Codex exposes `thread/compact/start` plus compaction notifications. The platforms can therefore compact using their own context semantics rather than receiving a generic “please summarize” prompt.

**Recommendation**

Add an explicit “Compact context” action and show the resulting boundary in the conversation. Optionally suggest compaction when exact context data crosses a threshold, but do not trigger it automatically without a product decision: compaction can affect reproducibility and what the agent remembers.

Rehydrate compacted state from the provider snapshot/history. This feature pairs naturally with the usage panel.

### 9. Codex: offer in-flight steering

**Finding**

The `turn/steer` method can add user input to an active turn, while Orkestrator currently queues messages until the running turn completes.

**Recommendation**

Keep queueing as the safe default, but add an explicit “Send to active turn” action when the current protocol/model supports steering. Include the active `expectedTurnId` and a stable client message ID. If the expected turn no longer matches, return the text to the draft/queue rather than silently starting another turn.

This is particularly useful for correcting a direction before a long-running implementation finishes.

### 10. Codex: evaluate the native review entry point

**Finding**

The protocol exposes `review/start` with typed targets such as uncommitted changes, a base branch, a commit, or custom review instructions, and supports inline or detached delivery. Orkestrator already has a cross-provider review workflow built around prompts and structured output.

**Recommendation**

Prototype native Codex review behind a feature flag for Codex-only review tabs. Compare its findings, target fidelity, streaming items, cancellation behavior, and structured-output compatibility with the current shared review pipeline. Adopt it where it improves target accuracy; do not replace the cross-provider pipeline until its output contract and review-history behavior are equivalent.

### 11. Provider-specific follow-ups

- **Claude background tasks:** Render task-started/progress/completed notifications and expose stop/background controls from the query. The bridge currently emits most non-init system events generically, leaving useful progress semantics unused.
- **Provider-native undo:** Claude supports file checkpointing and `rewindFiles` with dry-run behavior; OpenCode supports `revert`/`unrevert`. These can power an explicit “Undo changes through this message” flow. Codex's generated `thread/rollback` is deprecated and does not provide equivalent file rewind, so do not claim false three-provider parity.
- **Claude prompt suggestions:** Enable `promptSuggestions` as an opt-in experiment and render the post-turn suggestion as a one-click draft, never as an automatic send.
- **Claude local settings fidelity:** The bridge currently loads `user` and `project` setting sources but not `local`. Consider a clearly labelled native-settings option that includes `.claude/settings.local.json`; first audit the security and predictability implications rather than silently changing existing behavior.
- **OpenCode sharing:** `share`/`unshare` could support explicit collaboration links, but only as a user-initiated, privacy-labelled feature with clear information about what leaves the machine.

## Suggested delivery sequence

### Phase 1: correctness and continuity

1. OpenCode native command dispatch.
2. Claude persisted-session mapping and restart rehydration.
3. Codex ordinary interactive questions, with authoritative pending-state recovery.

### Phase 2: common native capabilities

4. Usage/context/limits snapshot and UI.
5. Cross-provider “Fork from here”.
6. Runtime capability/health drawer.
7. Codex MCP form elicitation.

### Phase 3: power-user workflows

8. Native compaction.
9. Agent/profile selection.
10. Codex steering and native review prototype.
11. Provider-specific rewind, background-task controls, prompt suggestions, and sharing.

## Validation requirements

Every background-facing enhancement should be tested with the originating tab/environment inactive:

1. Start the operation and switch to another environment.
2. Allow it to progress, request input, compact, or finish.
3. Return and verify the UI rehydrates from an authoritative snapshot.
4. Restart the relevant bridge/server where persistence is expected.
5. Verify stale requests from a dead process generation cannot be answered.
6. Verify events replay without duplicates and missed events are recovered by snapshot APIs.

For capability discovery, pin behavior to the installed SDK or generated protocol. Newer experimental documentation should be feature-detected and guarded rather than assumed available.

## Sources

Repository evidence:

- [`bridges/claude-bridge/src/services/session-manager.ts`](../bridges/claude-bridge/src/services/session-manager.ts)
- [`apps/web/src/lib/opencode-client.ts`](../apps/web/src/lib/opencode-client.ts)
- [`apps/web/src/components/opencode/OpenCodeComposeBar.tsx`](../apps/web/src/components/opencode/OpenCodeComposeBar.tsx)
- [`bridges/codex-bridge/src/app-server/server-request-router.ts`](../bridges/codex-bridge/src/app-server/server-request-router.ts)
- [`bridges/codex-bridge/src/app-server/event-reducer.ts`](../bridges/codex-bridge/src/app-server/event-reducer.ts)
- [`bridges/codex-bridge/src/app-server/generated/protocol-manifest.json`](../bridges/codex-bridge/src/app-server/generated/protocol-manifest.json)

Current platform documentation:

- [Claude Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Claude Agent SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- [Claude Agent SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks)
- [OpenCode server API](https://dev.opencode.ai/docs/server/)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [OpenCode tools](https://opencode.ai/docs/tools)
- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server.md)

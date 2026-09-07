# 02 — Typed engine boundaries and drift detection

**Status:** ✅ Done · 23/23 tasks · Depends on: nothing (01 recommended first)

## Goal

Make every bridge's engine boundary exhaustive over the vendor's own typed
union, so an upstream addition fails typecheck instead of vanishing, and give
the backend one generic way to learn that a bridge saw something it did not
understand. Today each bridge drops unknown variants silently, and only Codex
counts them. This plan does not add rendering for any specific event (that is
plan 03); it adds the safety net the later plans rely on.

## Normalized model

Extend `packages/protocol/src/native-agent.ts`:

- `NativeAgentRuntimeSummary` gains
  `drift?: { unknownEvents: number; unknownKinds: string[] }` (kind names
  only, bounded to 16, never payloads).
- `NativeAgentRuntimeNotice` gains `severity: "info" | "warning" | "error"`
  and `source: "provider" | "bridge"`. Existing notices default to
  `warning`/`bridge`.
- `NativeAgentNotice` gains `{ kind: "advisory"; message: string; severity }`
  for provider advisories that belong in the tab, not only the health panel.

Shared bridge route (already exists on Codex only):

- `GET /session/:id/runtime-health` → `{ summary: NativeAgentRuntimeSummary,
  notices: NativeAgentRuntimeNotice[] }` on every bridge. Answers an unknown
  session in band as `{ summary: {}, notices: [] }`, never 404.

Backend:

- `NativeAgentRuntimeProvider.runtimeHealth?(sessionId)` in
  `apps/backend/src/core/agent-provider-contract.ts`, implemented by
  `HttpBridgeProvider` for every bridge and by `OpenCodeProvider` from the SDK
  health calls it already makes.
- The projection carries `runtime` and `notices` generically; the renderer's
  `AgentInfoButton` runtime section reads them without a platform switch.

## Tasks

### Protocol and backend

- [x] Add the `drift`, `severity`/`source` and `advisory` fields above, with
  protocol tests for the parsers in `packages/protocol/src/native-agent.ts`.
- [x] Add `runtimeHealth?()` to `NativeAgentRuntimeProvider`; implement in
  `http-bridge-provider.ts` for all bridge platforms (today only Codex is
  read, at `:1499`-adjacent code) and in `opencode-provider.ts` from the
  existing `mcp.status`/`lsp.status`/`app.agents` reads.
- [x] Promote `severity: "warning" | "error"` provider notices into the
  session projection's `notices` as `advisory` so they appear in the tab.
  Bound to the most recent five per session; dedupe by message.
- [x] Renderer: `AgentInfoButton.tsx` runtime section renders `drift` and
  notices from the projection for every platform; delete the
  Codex-only `CodexRuntimePanel` branch at `:1703-1709` once the generic
  panel shows the same data. Presentation only.

### Claude bridge

- [x] Import `SDKMessage` from `@anthropic-ai/claude-agent-sdk` and replace
  the structural `SdkMessageBase`/`SdkSystemMessage`/`SdkResultMessage`
  declarations in `bridges/claude-bridge/src/types/index.ts:25-99`. Remove
  the `as any` casts at `session-manager-prompt.ts:1153,1175,1634`.
- [x] Make the message dispatch in `session-manager-prompt.ts:1172-1908`
  exhaustive over `SDKMessage["type"]` with an `assertNever`-style default
  that records a drift entry. The five types with no branch today
  (`tool_progress`, `tool_use_summary`, `auth_status`, `conversation_reset`,
  `active_goal`) get explicit no-op branches that record drift until plan 03
  and 08 render them.
- [x] Either give `system.message` (`session-manager-prompt.ts:1573-1582`) a
  consumer or stop emitting it. Recommended: map `status`, `api_retry`,
  `model_refusal_*`, `notification`, `informational` subtypes to
  `NativeAgentRuntimeNotice` with a severity, and drop the untyped emit.
  Read `system/init.capabilities` and keep it in bridge state for later
  feature detection.
- [x] Set `includeHookEvents: true` only when a hook is registered; otherwise
  leave off. Record `hook_response` failures as `error` notices.

### Codex bridge

- [x] Make the unhandled-notification decision for the eight remaining
  names (`thread/reverted`, `thread/queue/changed`, `project/changed`,
  `thread/project/updated`, `autoApprovalReview/strictReviewRequired`,
  `mcpServer/event/stream/notification`,
  `modelProvider/authRecoveryStarted`, `modelProvider/authRecoveryCompleted`)
  in `app-server/event-reducer.ts:99-155`: handle or ignore, never fall
  through. `thread/reverted` is consumed by plan 09; `authRecovery*` by plan
  08; the rest are ignore-list entries with a comment.
- [x] Surface `warning`, `guardianWarning`, `deprecationNotice`,
  `configWarning` and `model/rerouted` (currently runtime-health only,
  `engine/app-server-engine.ts:573-603`) as `advisory` notices with
  `severity: "warning"` so they reach the tab.
- [x] Expose `protocol.unknownNotifications` and the last kinds through the
  new `drift` field.

### OpenCode (backend)

- [x] Type the SSE consumer in `apps/backend/src/core/opencode-provider.ts:497-580`
  against the SDK `Event` union and make `handleRequest` exhaustive with a
  drift-recording default. This plan only records; plan 13 handles more.
- [x] Type `normalizeOpenCodePart` (`apps/web/src/lib/opencode-messages.ts:359`
  and `apps/backend/src/core/opencode-messages.ts:195-215`) against the SDK
  `Part` union with an exhaustive switch; unknown parts record drift.

### Cursor bridge

- [x] Make `translate.ts:54-100` exhaustive over the 16-member
  `InteractionUpdate` union and the 8-member `NestedTaskUpdate` union; the
  five dropped members get explicit branches (rendered in plan 03).
- [x] Make `tool-rendering.ts:59-108` exhaustive over the 16 typed `ToolCall`
  kinds; `recordScreen` and any untyped name (`webSearch`, `askQuestion`,
  `await`, `readTodos`, `applyAgentDiff`) fall to the generic card **and**
  record drift with the name.
- [x] Read the `system` message from `Run.stream()` (`prompt.ts:519-523`
  reads only `usage`) and keep the reported toolset and model in session
  state for the runtime summary.

### Pi bridge

- [x] Make `translate.ts:62-124` exhaustive over `AgentSessionEvent`; the
  events listed as dropped in the review (`turn_start`, `agent_*`,
  `auto_retry_end`, `summarization_retry_*`, `entry_appended`) get explicit
  branches, most as no-ops with drift recording until plans 03 and 09.
- [x] Surface `extensionsResult` diagnostics and `modelFallbackMessage`
  (kept in plan 01) as notices with the right severity.

### Grok bridge

- [x] Expose the counter added in plan 01 through the new `drift` field on
  the ACP bridge's runtime-health route. Vendoring a schema is plan 14; this
  task is the reporting hook only.

## Verification

- [x] Every bridge has a test that feeds an event with an invented type and
  asserts: no throw, drift counter incremented, kind name recorded, payload
  not recorded.
- [x] `bun run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`
- [x] `bun run test:logged -- --name backend-typecheck -- bun run --cwd apps/backend typecheck`
- [x] Browser check per `docs/development/agent-testing.md`: the runtime
  section shows a drift count and an advisory notice for a fixture session on
  at least two platforms; reload and confirm it rehydrates from the snapshot.

## Out of scope

Rendering any specific new event (plan 03), handling auth events (plan 08),
vendoring an ACP schema (plan 14).

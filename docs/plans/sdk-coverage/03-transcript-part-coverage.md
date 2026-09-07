# 03 — Transcript part coverage

**Status:** ✅ Done · 31/31 tasks · Depends on: 02

## Goal

No provider should drop an event that a user would want to see in the
transcript. Add a small number of generic part kinds to the shared message
model, then have each adapter populate them. A provider with no source for a
kind simply never emits it. The renderer gets one component per new kind and
no platform branches.

## Normalized model

Extend `NativeMessagePart` in `apps/web/src/lib/chat/native-message-types.ts`
(and its backend twin in the projection):

| New part `type` | Fields on `NativeBasePart` | Rendered as |
| --- | --- | --- |
| `compaction` | `content` (summary text, may be empty), `tokenCount` (before), `tokenCountText` | A boundary row: "Context compacted", expandable summary |
| `retry` | `content` (reason), `toolState` (`pending` while retrying, `success`/`failure` when settled), `retryAttempt?: number` | A transient notice row that settles |
| `image` | `fileUrl` or `detailRef`, `filename`, `content` (alt/caption), `imageSource: "attachment" \| "generated" \| "viewed"` | Inline image, lazy, bounded |
| `progress` | `toolUseId`, `content` (status text), `elapsedMs?: number` | Attached to the matching tool row as a live sub-line, never a separate row |
| `status` | `content`, `severity` | Small inline row for provider status that belongs in the flow (e.g. "model rerouted") |

Rules:

- Heavy fields (image bytes, long summaries) go behind `detailRef` as today.
- `progress` is a hint over the authoritative `toolState`; a missed progress
  event costs nothing.
- Existing kinds are not changed. `subagent` gains an optional
  `subagentModelId` and `subagentSource: "tool" | "part"` so OpenCode's
  first-class `SubtaskPart` and heuristic task tools converge.

Renderer: one new file per kind under
`apps/web/src/components/chat/parts/`, wired into
`NativeMessage.renderer.tsx:175-258`. Presentation only.

## Tasks

### Protocol, backend, renderer

- [x] Add the five part kinds and the two `subagent` fields to
  `native-message-types.ts` and the backend projection types; parser tests.
- [x] Projection: accept the new kinds through
  `native-agent-service-projection.ts` transcript merge without special
  casing; `progress` parts attach to their tool row by `toolUseId` at
  projection time, so the renderer receives a tool row with a `progress`
  sub-field rather than a loose part.
- [x] Renderer components for `compaction`, `retry`, `image`, `status`, and
  the `progress` sub-line on the tool row. Rendering tests with synthetic
  projections. No platform checks.

### Claude adapter (`bridges/claude-bridge/src/services/session-manager-prompt.ts`)

- [x] `tool_progress` → `progress` on the matching `toolUseId`, with
  `elapsed_time_seconds`. Includes subagent progress (`subagent_type`).
- [x] `tool_use_summary` → `status` row with the summary text.
- [x] `compact_boundary` and `status.compact_result` → `compaction` part
  (today `system.compact` is emitted and unrendered).
- [x] `api_retry` → `retry` part that settles on the next assistant message.
- [x] `conversation_reset` → clear the bridge transcript and emit a `status`
  row ("Conversation cleared") so the tab does not show stale history.
- [x] `user` messages: read `tool_use_result` for the Agent/Task tool's
  structured report instead of parsing result text (`messages.ts:698`), and
  keep `file_attachments` as `image`/`file` parts.

### Codex adapter (`bridges/codex-bridge/src/app-server/item-adapter.ts`, `messages/normalization.ts`)

- [x] `imageGeneration` and `imageView` items → `image` part
  (`imageSource: "generated"` / `"viewed"`), bytes behind `detailRef`.
- [x] `contextCompaction` item and `thread/compacted` → `compaction` part.
- [x] `hookPrompt` → `status` row; `sleep` → `status` row with duration;
  `functionCallOutput` → attach as `toolOutput` to its call when the id
  matches, else drop with drift.
- [x] `item/plan/delta` and `item/mcpToolCall/progress` (currently ignored,
  `event-reducer.ts:143-144`) → streaming plan text and `progress` on the
  MCP tool row. `item/fileChange/outputDelta` → `progress` on the file-change
  row.
- [x] Keep `webSearch` action/mode fields and `mcpToolCall.result._meta` on
  the tool row's `toolArgs`/`toolOutput` rather than discarding them.
- [x] Replace the bare `default: return []` in `normalization.ts:454` with a
  generic tool card plus drift, per plan 02.

### OpenCode adapter (`apps/backend/src/core/opencode-messages.ts`, `apps/web/src/lib/opencode-messages.ts`)

- [x] `SubtaskPart` → `subagent` part with `subagentSource: "part"`,
  `subagentPrompt`, `subagentModelId`; the existing `ToolPart` heuristic
  (`opencode-messages.ts:409-441`) becomes the fallback, and the two are
  deduplicated by child session id.
- [x] `CompactionPart` → `compaction`; `RetryPart` → `retry`;
  `StepFinishPart.cost/tokens` → per-step usage (consumed by plan 11).
- [x] `FilePart` keeps `mime` and `source`; image MIME → `image` part instead
  of a generic file row. Read `ToolStateCompleted.attachments` into `image`/
  `file` parts on the tool row.
- [x] `PatchPart`, `SnapshotPart`, `AgentPart`, `StepStartPart`: explicit
  drop-with-drift branches (no user value today), documented in the switch.

### Cursor adapter (`bridges/cursor-bridge/src/translate.ts`, `tool-rendering.ts`)

- [x] `user-message-appended` → a user message row (with its images), so a
  steered message (plan 05) appears in the transcript.
- [x] `summary-started`/`summary-completed`/`summary` → one `compaction` part
  with pending → settled state (today `summary` alone becomes a synthetic
  tool card). `step-started`/`step-completed` → drop with drift (no
  transcript value); `thinking-completed.thinkingDurationMs` → kept on the
  thinking part.
- [x] `shell-output-delta` → `progress` on the shell tool row instead of the
  heuristic scrape; keep stdout/stderr distinction in `toolOutput`.
- [x] `generateImage` → `image` part (`generated`), file read behind
  `detailRef`; `grep` and `readLints` use the typed outputs
  (`GrepContentOutput`, `fileDiagnostics`) instead of JSON stringification;
  `createPlan` → the same plan presentation Codex uses (`turn/plan`), not a
  plain card.

### Pi adapter (`bridges/pi-bridge/src/translate.ts`, `tool-rendering.ts`, `agent-session.ts`)

- [x] `compaction_start`/`compaction_end` → `compaction` part with
  `tokensBefore`/`estimatedTokensAfter` (today a synthetic tool card that
  drops both). `auto_retry_start`/`auto_retry_end` → `retry` part that
  settles (today the card goes stale).
- [x] Tool-result images → `image` part instead of the literal `"[image]"`
  (`tool-rendering.ts:185`).
- [x] Historic replay renders every `SessionEntry` kind, not only `message`
  (`agent-session.ts:767-768`): compaction summaries → `compaction`, branch
  summaries → `status`, model and thinking-level changes → `status`. Use the
  SDK's typed `parseSessionEntries` (plan 15 removes the hand parser).

### Grok adapter (`bridges/acp-bridge/src/acp-transcript.ts`, `acp-session.ts`)

- [x] Non-text content blocks: `image` → `image` part; `resource` and
  `resource_link` → `file` part; `audio` → `file` with the MIME. Today
  `contentText` returns `""` and the update is discarded
  (`acp-transcript.ts:523-528`, `acp-session.ts:727-728`).
- [x] ACP plan `priority` kept on the todo item; tool `kind` mapped to a
  `toolName` hint for the generic card's icon; `stopReason` from the prompt
  result → `status` row when it is not `end_turn` (`max_tokens`, `refusal`).

## Verification

- [x] Bridge tests per adapter with recorded or fake payloads for every new
  mapping; assert the emitted part shape.
- [x] Renderer tests for each new component with synthetic parts.
- [x] Browser: on a fixture environment, trigger a compaction (Claude or Pi),
  an image attachment round-trip, and a long-running tool; confirm the rows
  appear, then switch tabs, let the turn finish, return, and reload.

## Out of scope

Codex review-mode boundary items (Orkestrator owns review). OpenCode v2 parts.

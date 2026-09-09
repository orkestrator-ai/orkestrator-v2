# 15 — Adapter simplification

**Status:** 🟨 In progress · safe independent replacements implemented, dependency-bound work remains · Depends on: 05, 06, 09

## Goal

Several adapters reimplement something their SDK now provides. Each
reimplementation is a drift risk and a maintenance cost with no user-visible
upside. Replace them with the SDK primitive, one at a time, with a test that
proves the behaviour is unchanged. This plan is deliberately last: most items
become easy only once plans 05, 06 and 09 have moved the adapter onto the
SDK's session model.

## Tasks

### Claude bridge

- [ ] **Plan-mode instructions.** Replace the hand-written
  `<system-reminder>` prepended to the user prompt
  (`session-manager-prompt.ts:415-430`) with `Options.planModeInstructions`,
  so the user turn carries only the user's text and the CLI keeps its own
  read-only preamble.
- [ ] **Plan capture.** Replace the `PreToolUse` hook that re-implements
  `Edit` semantics to capture plan text (`updateObservedPlan`,
  `session-manager-prompt.ts:179-223`) with `ExitPlanMode.input.plan` (already
  read at `:964`) plus a `FileChanged` or `PostToolUse` hook for ordering.
- [ ] **Background-task reconciliation.** Replace the hand-rolled
  task edge/level machinery (`session-manager-prompt.ts:1370-1569`) with
  `TaskCreated`/`TaskCompleted`/`SubagentStart`/`SubagentStop` hooks and the
  `task_*` system messages the bridge already handles. Track the deleted
  line count.
- [ ] **Compaction.** Register `PreCompact`/`PostCompact` hooks and drop the
  `compact_boundary` sniffing once plan 03's `compaction` part is fed from
  the hooks. `/compact` as a text prompt is fine and stays.
- [ ] **MCP config parsing.** Remove the `~/.claude.json`/`.mcp.json`
  parsing and the locally re-declared `Mcp*ServerConfig` shapes in
  `services/mcp-config.ts:25-49`; `settingSources: ["user","project"]`
  already loads them. Keep only the Orkestrator control-server injection,
  and consider `createSdkMcpServer()` + `tool()` for it so the bearer-token
  loopback hop disappears (decide with the coordinator's scoped-credential
  requirement in mind; if other processes must reach the same server, keep
  HTTP and say why).
- [ ] **Warm query.** Use `startup()`/`WarmQuery` so the first turn in an
  environment does not pay the cold CLI spawn; measure and record.
- [ ] **Model catalogue.** Use `initializationResult().models` on the live
  query (plan 05) instead of spawning a throwaway query per
  `/config/models` call (`session-manager-interactions.ts:241-251`).

### Codex bridge

- [ ] **Goals decision.** `features.goals=true` and a `/goal` slash command
  exist but no `thread/goal/*` RPC is called and both notifications are
  ignored. Either wire `thread/goal/set|get|clear` into a generic
  "session goal" field on the projection (small, and Claude's `active_goal`
  message could feed the same field), or disable the feature flag and remove
  the command. Decide, then do it.
- [ ] **Session titles.** Delete `session-titles.ts` once plan 09's backend
  title service owns generation.

### Pi bridge

- [ ] **Typed session parsing.** Replace `hydrateHistory`/
  `appendHistoricEntry`/`applyHistoricToolResult`
  (`agent-session.ts:741-854`) with the SDK's `parseSessionEntries` and
  typed entry union. Verify the `toolName` assumption at `:841` against the
  JSONL types while doing it.
- [ ] **Thinking ladder.** Drop the duplicated `THINKING_LEVELS`/
  `THINKING_LABELS` (`models.ts:39-53`) in favour of
  `getAvailableThinkingLevels()` and the SDK's `ThinkingLevel`.
- [ ] **Images.** Use `detectSupportedImageMimeTypeFromFile`, `resizeImage`
  and `convertToPng` instead of the hand-rolled sniffer
  (`prompt-attachments.ts:180-205`), keeping the bridge's own path-trust
  reads. `getLastAssistantText()` and `getLastAssistantUsage()` replace the
  accumulators in `translate.ts:246-248,345-360`.
- [ ] **Unused dependencies.** Remove `@earendil-works/pi-agent-core` and
  `pi-server` from `package.json` if the vendoring script can tolerate the
  undeclared import, or document why they stay.

### Cursor bridge

- [ ] **Local store.** Decide whether to install `sqlite3` (so the SDK uses
  its SQLite store) or configure `Cursor.configure({ local: { store } })`
  with a `JsonlLocalAgentStore` rooted under `CURSOR_BRIDGE_STATE_DIR`, so
  agent, run and checkpoint persistence lives with the bridge's own state.
  Use `createAgentPlatform().prewarmLocalWorkspace` to avoid the first-turn
  workspace scan.

## Verification

- [ ] For each replacement, a before/after test on the same fixture showing
  identical projection output.
- [ ] Line-count delta per bridge recorded in the PR description.
- [ ] `mise run test` green; `mise run check` green.

## Out of scope

Anything that changes user-visible behaviour. If a replacement would, it
belongs in the plan that owns that behaviour.

## Implementation notes

- Plan-mode guidance now uses `Options.planModeInstructions`; plan approval
  takes its payload directly from `ExitPlanMode.input.plan`. Claude task and
  compaction hooks are registered, while the existing `task_*` messages remain
  as compatibility/reconciliation input until plan 05 owns a long-lived query.
- Claude's warm query and live initialization model catalogue remain blocked on
  plan 05's long-lived session model. The filesystem MCP inventory remains
  until plan 07 provides an authoritative SDK-backed inventory. Removing it now
  would make `/mcp/servers` return an empty list.
- Codex goals are disabled because the pinned app-server exposes no stable goal
  RPC. `session-titles.ts` remains the documented hermetic exception until plan
  09's backend title service owns generation.
- Pi replay consumes `SessionManager.getBranch()` as the SDK's typed
  `SessionEntry` union (the manager owns JSONL parsing and active-branch
  selection), including the required `ToolResultMessage.toolName`. Image
  signature detection, resizing and portable PNG conversion use Pi's helpers;
  structured output and usage read `getLastAssistantText()` and
  `getLastAssistantUsage()` instead of duplicate accumulators.
- `@earendil-works/pi-agent-core` remains because the public coding-agent type
  declarations import it. `@earendil-works/pi-server` remains because
  pi-coding-agent 0.85.0 imports it without declaring it; `scripts/vendor.ts`
  stages both explicit roots so the packaged bridge has a complete runtime
  closure.
- Cursor configures the SDK's `JsonlLocalAgentStore` under
  `CURSOR_BRIDGE_STATE_DIR/cursor-sdk` and holds a
  `prewarmLocalWorkspace()` lease for each attached agent. Rewind uses the same
  configured store, so agent, run and checkpoint persistence share one root.

# 01 — Quick correctness fixes

**Status:** ✅ Done · 11/11 tasks · Depends on: nothing

## Goal

Land the eight fixes from the review that are wrong today, small, and
independent of any new model. Each is one bridge file plus a test. None
changes the shared protocol or the renderer. Do them as separate commits so
each can be reviewed and reverted on its own.

## Tasks

### Claude

- [x] **Honour `result.is_error`.**
  `bridges/claude-bridge/src/services/session-manager-prompt.ts:1787-1904`
  treats `subtype: "success"` as success without reading `is_error`. The SDK
  documents `is_error: true` on a success subtype as "turn ended on an API
  error". Publish that as a failed turn (`session.idle { success: false }`
  with the error text from `errors`), not success. Test: replay a result
  message with `subtype: "success", is_error: true` and assert the projection
  reports an error notice.

### Codex

- [x] **Accept the `openaiForm` elicitation mode.**
  `bridges/codex-bridge/src/app-server/interactions.ts:185` accepts `form`,
  `openai/form` and `url`; the generated protocol
  (`v2/McpServerElicitationRequestParams.ts`) also defines `openaiForm`. The
  bridge advertises `mcpServerOpenaiFormElicitation: true` in the handshake
  (`process-supervisor.ts:610`), so this variant is reachable and is currently
  auto-cancelled. Treat it identically to `openai/form`. Test: a fixture
  request with `mode: "openaiForm"` parks as an `mcp-form` interaction.
- [x] **Add the three `thread/realtime/item/*` names to the ignore list.**
  `bridges/codex-bridge/src/app-server/event-reducer.ts:150-157` lists eight
  realtime methods; `thread/realtime/item/started`,
  `thread/realtime/item/completed` and `thread/realtime/item/transcript/delta`
  are missing and currently inflate `protocol.unknownNotifications`. Test:
  the reducer's unknown counter stays at zero across a fixture containing all
  eleven realtime notifications.
- [x] **Read `isBlocking` instead of the deprecated `autoResolutionMs`.**
  `bridges/codex-bridge/src/app-server/interactions.ts:131-133,176-179`.
  `v2/ToolRequestUserInputParams.ts` marks `autoResolutionMs` deprecated in
  favour of `isBlocking`. Read `isBlocking` first and fall back to the old
  field only when the new one is absent, so a non-blocking question no longer
  blocks the turn. Test: both shapes produce the expected `blocking` flag.

### Pi

- [x] **Fix `readContextUsage` to the typed `ContextUsage` shape.**
  `bridges/pi-bridge/src/prompt.ts:243-251` probes `totalTokens ?? tokens ??
  used` and `contextWindow ?? maxTokens`. The SDK exports `ContextUsage` as
  `{ tokens: number | null; contextWindow: number; percent: number | null }`
  (`dist/index.d.ts:7`). Import the type, read `tokens`/`contextWindow`/
  `percent` directly, and when `tokens` is `null` (immediately after
  compaction) report `estimated: true` with the per-turn sum rather than
  silently switching sources. Test: a post-compaction `{tokens: null}` result
  yields an `estimated` usage, not a wrong absolute.
- [x] **Call `bindExtensions()` after session creation.**
  `bridges/pi-bridge/src/agent-session.ts:340` discards the SDK result and
  never binds. Without it `session_start` never fires, `resources_discover`
  never runs (extension-contributed skills and prompt templates are absent),
  and extension errors are swallowed. Bind with a no-op UI context and an
  `onError` listener that records a bounded, redacted runtime notice. Also
  keep `extensionsResult` and `modelFallbackMessage` from the create result
  so plan 02 can surface them. Test: an inline test extension that registers
  a prompt template is visible in `readSlashCommands` after bind.

### Grok

- [x] **Count and log unknown `session/update` kinds.**
  `bridges/acp-bridge/src/acp-session.ts:708-715` returns silently. Increment
  a per-session `unknownUpdates` counter, keep the last few kind names
  (names only, never payloads), and expose them on the existing activity or
  status route so plan 02 can promote them to a runtime notice. Test: an
  unrecognised kind increments the counter and does not throw.

### Cursor

- [x] **Decide and record the host-run sandbox policy.**
  `bridges/cursor-bridge/src/config.ts:85` enables the SDK sandbox only under
  `CURSOR_BRIDGE_SANDBOX=1`, which no backend launcher sets, and
  `local.autoReview` is never passed. On a host worktree the SDK's `shell`,
  `write` and `delete` run ungated with no approval surface. This task is a
  decision, not a feature: either the host launcher sets
  `CURSOR_BRIDGE_SANDBOX=1` (and the bridge passes `autoReview: true`), or
  `docs/technical-architecture/agent-engines.md` states that Cursor host tabs
  are ungated and why. Plan 12 builds the generic policy; this task closes the
  immediate gap. Test: whichever way it goes, `config.test.ts` asserts the
  chosen default.

  **Decided: ungated, documented.** Sandboxing Cursor alone would give one
  platform a different answer to the same question — Grok launches
  `--always-approve`, Pi's gate is off by default, Claude's local default
  allows unbranched tools — without making the product safer, since a user
  who wants isolation uses a container environment. Recorded under "Cursor
  host tabs are ungated" in `agent-engines.md`, with
  `config.test.ts` pinning `sandboxEnabled` false and pinning that only the
  exact `CURSOR_BRIDGE_SANDBOX=1` opts in. `local.autoReview` is not passed,
  because there is nothing to review against without the sandbox.

## Verification

- [x] Each fix has a focused bridge test that fails before and passes after.
- [x] `bun run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures` passes.
- [x] `bun run check` passes.

## Out of scope

Anything that needs a new protocol type, route or renderer change. Those are
plans 02 onward.

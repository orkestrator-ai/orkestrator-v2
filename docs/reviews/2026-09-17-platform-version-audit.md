# Platform version audit — 2026-09-17

Status: Historical snapshot of the 2026-09-17 platform refresh.

## Updated versions

| Platform | Previous | Current | Result |
| --- | --- | --- | --- |
| Claude | Agent SDK `0.3.263`, Anthropic SDK `0.124.0`, CLI `2.1.263` | Agent SDK `0.3.274`, Anthropic SDK `0.126.0`, CLI `2.1.274` | Updated |
| Codex | CLI/protocol `0.153.4` | CLI/protocol `0.154.0` | Updated and regenerated |
| OpenCode | SDK/CLI `1.18.29` | SDK/CLI `1.18.31` | Updated; SSE patch rebased |
| Grok | CLI `1.0.13` | CLI `1.0.34` | Updated |
| Cursor | SDK `1.0.31` | SDK `1.0.31` | Already current |
| Pi | SDK/CLI `0.85.1` | SDK/CLI `0.85.1` | Already current |
| ACP | SDK `1.4.0` | SDK `1.4.0` | Already current |

Every changed desktop binary has fresh size and SHA-256 records for macOS and
Linux on arm64 and x64. Docker pins and Linux hashes were updated in parallel.

## Compatibility result

No release-blocking integration change was found. The existing launch vectors,
SDK entry points, OpenCode v2 API calls, Codex at-most-once correlation fields,
and Grok ACP configuration methods remain available. Provider bridge suites,
the Codex live app-server contract, and the OpenCode live SDK/CLI round trip all
pass against the new versions.

The OpenCode 1.18.31 generated v2 SDK surface is compatible with 1.18.29 for the
APIs Orkestrator uses. The patched generated SSE clients still contain the
unhandled `reader.cancel()` rejection upstream, so the patch remains required
and was rebased rather than removed.

## Implemented support follow-ups

- **Claude structured status and usage.** Structured `usage_report` messages
  now enrich the existing usage snapshot with session cost, duration, changed
  lines, quota windows, and extra-usage balance. Every structured startup
  failure reason maps to actionable UI text. Question and plan requests reuse
  the SDK request identity so re-delivery does not create a new public id.
- **Codex configuration changes.** `configuration_update` response items now
  update the session's reasoning selection. A dispatch-time revision guard
  prevents a late provider event from overwriting a newer user configuration.
- **Codex account, MCP, and thread diagnostics.** Normal model slugs label quota
  buckets, ordinary-usage ineligibility becomes a runtime warning, MCP
  `toolsError` reaches the MCP panel, and thread originators appear in resume
  details.
- **Grok plan review and questions.** The Grok adapter now handles the official
  `x.ai/exit_plan_mode` and `x.ai/ask_user_question` reverse requests (including
  the underscore-prefixed compatibility aliases), stores them in backend-owned
  session state, and maps them into the shared interaction contract. Approval,
  revision feedback, abandonment, selected options, free text, cancellation,
  and timeout all map back to Grok's provider-specific outcomes.

## Deferred intentionally

- Claude pending-permission reinitialization and MCP permission provenance are
  not enabled in this change. Both touch authorization lifecycle semantics; the
  current full-permission path remains unchanged as requested.
- Codex managed application/network requirements are retained in the generated
  protocol but are not projected into the common UI until Orkestrator has a
  provider-neutral requirements surface.
- Grok private post-turn `plan_kept`/`plan_cleared`/`plan_executing` updates are
  not needed for the supported reverse-request workflow and remain private.

### No immediate implementation work

- Codex async inline questions are already handled by the bridge's blocking and
  asynchronous question paths.
- Grok image prompt blocks, model/reasoning configuration, plan updates, usage,
  and subagent lifecycle updates are already supported.
- Grok MCP 2026-07-28 elicitation is deliberately not advertised by Grok's
  zero-IPC ACP client. Orkestrator should add a UI only after Grok exposes a
  supported ACP reverse-request contract; inventing one now would not activate
  the feature.
- Codex managed worktrees and the Windows shared daemon do not replace
  Orkestrator's own worktree and process lifecycle architecture.
- Cursor and Pi published no newer stable version, so their adapters required
  no source changes.

## Upstream sources reviewed

- Claude Code changelog and Claude Agent SDK TypeScript declarations
- Codex 0.154.0 release notes and generated app-server schema
- OpenCode 1.18.30–1.18.31 release notes and generated v2 SDK package
- Grok Build release/source history and ACP extension definitions
- Current Cursor, Pi, and Agent Client Protocol package registries

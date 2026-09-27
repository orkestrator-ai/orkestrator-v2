# Slash-command qualification record (plan step 01)

Recorded 2026-09-23 on branch `slash-commands-support-3b13a4bc3b08-r1`
(baseline `88c2f9cc`). Contract: [`native-agent-commands.md`](../../architecture/native-agent-commands.md).

## What this record is, and is not

Every entry below was qualified from the **installed** SDK declarations and
source at the repository pins, then exercised through each integration's real
execution path with transport-level fakes (bridge route tests, SDK client
fakes, spawned fake ACP agent). **No live provider session, billable prompt or
isolated `dev:test` profile was run.** Rows whose correctness depends on
provider runtime behaviour that fakes cannot prove are marked *not tested
live*. Per the plan, mocks do not confer support: where a behaviour could not
be qualified the command is disabled with a reason instead of enabled.

## Pins

| Integration | Pin | Evidence read |
| --- | --- | --- |
| Claude | Agent SDK `0.3.276` | `@anthropic-ai/claude-agent-sdk/sdk.d.ts`: `SlashCommand {name, description, argumentHint, aliases?}` (no source/scope); `Query.supportedCommands()`; `SDKCommandsChangedMessage` ("REPLACE their cached command list"); init `slash_commands`, `skills`, `terminal_slash_commands`, `plugins`; `SDKConversationResetMessage` (emitted by `/clear`); `SDKLocalCommandOutputMessage`; `SDKResultSuccess.result`; `reloadPlugins().error_count` |
| Codex | app-server `0.155.0`, committed generated protocol | `generated/typescript/v2`: `SkillsListParams {cwds?, forceReload?}`, `SkillsListResponse.errors`, `SkillMetadata {path, enabled, pluginId, interface}`, `SkillScope = user|repo|system|admin`, `UserInput` `skill {name, path}` / `text {text, text_elements}` / `localImage`, `SkillsChangedNotification` |
| OpenCode | SDK and CLI `1.18.31` (`/v2/client`) | SDK `dist/v2/gen`: `Command {name, description, agent, model, template, subtask, hints, source: command|mcp|skill}` (no aliases, no owner); `session.command` flat params; minified server source in the installed binary for lookup, precedence and response timing |
| Pi | SDK and CLI `0.85.1` | `core/agent-session.d.ts` `PromptOptions.expandPromptTemplates`; `core/agent-session.js` dispatch order and `reload()`; `core/extensions/runner.js` command lookup and headless UI stubs; `modes/interactive/interactive-mode.js` refusing `/reload` while streaming |
| Grok | Build `1.0.34`, ACP SDK `1.4.0` | `AvailableCommand {name, description, input?: {hint}}`, `AvailableCommandsUpdate`; no `commands/list` method |
| Cursor | SDK `1.0.31` | `SDKAgent` exposes `send`, `close`, `reload`, `listArtifacts`, `downloadArtifact`, `getUsage`; no command discovery or invocation API |

## Support table

| Provider | Discovery source | Canonical name / aliases | Execution route | Known-empty vs failure | Status |
| --- | --- | --- | --- | --- | --- |
| Claude | Live query `supportedCommands()`, `commands_changed` replacement, init names as cold fallback, config-parity probe (reported `stale`) | SDK spelling, SDK aliases; skills annotated, no `/skill:` rows | `provider-prompt`: canonical name + verbatim arguments through the query | `ready` only from the session's own query or a push; probe/init lists are `stale` | Route and validation tested; **not tested live** |
| Codex skills | `skills/list` for the effective cwd | `$name`, alias `/skill:name` | `structured-skill`: `{type:"skill", name, path}` + text item | `SkillsListResponse.errors` → partial/stale | Serialization tested byte-exact; **not tested live** |
| Codex templates | Bounded scan of `.codex/prompts` and `~/.codex/prompts` | Relative path; reserved names renamed `/prompts:<name>` and disabled | `bridge-template`: `$ARGUMENTS` expansion only; shell spans disabled | Scan errors reported as truncation | Tested |
| Codex built-ins | Bridge | `/help`, `/models` | `bridge-local` | — | Tested |
| OpenCode | One `command.list({directory})` | Exact server key (case-sensitive), no aliases | `provider-command` via `session.command`, reserved `messageID` | List errors throw; empty stays empty | Request shape tested; **not tested live** |
| Pi | One builder over templates, skills, extensions (`sourceInfo` origin) | Template `/name`, skill `/skill:name`, extension invocation name | `provider-prompt` via `session.prompt({source:"rpc"})` | Persisted list returns `stale` after restart | Tested with SDK fakes; **not tested live** |
| Grok | ACP `available_commands_update` (push) | Name as sent; `input.hint` first | `provider-prompt` via `session/prompt` | `ready` once this process received a list (even empty); restored rows `stale` and not executable | Spawned fake agent tested; **not tested live** |
| Cursor | None | — | — | `unsupported` | Tested |
| Orkestrator | Backend | `/steer` (reserved), `/compact` (defers to a provider `/compact`) | `session-action` | — | Tested |

## Commands deliberately disabled (listed with a reason, never executed)

| Provider | Commands | Reason |
| --- | --- | --- |
| Claude | `/clear`, `/model`, `/permissions`, `/resume` | `session-changing`: the bridge does not adopt the new conversation id, and each turn re-applies model and permission mode |
| Claude | `terminal_slash_commands` from init, `/login`, `/logout` | `requires-interactive-ui` |
| Claude | `/config`, `/doctor`, `/exit`, `/ide`, `/quit`, `/statusline`, `/terminal-setup`, `/theme`, `/vim` | `unqualified` |
| Codex | Duplicate skill names | `ambiguous` |
| Codex | Disabled skills | `disabled` |
| Codex | Templates named after a reserved command | `reserved-name` |
| Codex | Templates containing `` !`…` `` | `requires-shell-execution` (inline shell is disabled by default) |
| Codex | Templates with malformed frontmatter | `unsupported` |
| OpenCode | TUI controls (`/exit`, `/themes`, `/editor`, …) | Not in the catalogue; typed spellings get an explanation |

The Claude bridge also refuses typed text naming any of its disabled commands,
so a failed backend catalogue read cannot let `/clear` reach the CLI.

## Literal (workflow) suppression

| Provider | Mechanism | Limitation |
| --- | --- | --- |
| Claude | None in the SDK | Backend refuses a literal prompt whose leading token names a known command |
| Grok | None in ACP | Same backend refusal |
| Codex | Bridge resolver bypassed | app-server does not interpret `/` text |
| OpenCode | `promptAsync` instead of `session.command` | — |
| Pi | `expandPromptTemplates: false` (covers extension commands, skills, templates) | Extension `input` handlers still run on every prompt; `followUp()` always expands, so a literal follow-up Pi would read as a command gets 409 instead of queueing |
| Cursor | No commands | — |

## Findings that changed the design

- **OpenCode `session.command` answers only after the whole command turn**,
  and maps every failure to HTTP 400. The provider no longer aborts it on the
  prompt timeout; the reserved `messageID` in the transcript decides
  acceptance, and a missing answer is ambiguous, never a fallback prompt.
- **OpenCode substitutes `$ARGUMENTS` before running a template's
  `` !`cmd` `` spans.** That is OpenCode's own template semantics on its own
  server; Orkestrator does not add a shell surface, but a user's arguments to
  such a command can reach a shell there. Recorded, not changed.
- **Pi `reload()` is unsafe during a turn** (replaces the extension runner,
  including the approval gate). Refresh answers `deferred` while busy and
  reloads when idle.
- **Pi extension commands precede skill and template expansion**; only the
  effective winner is listed.
- **Grok may push its command list before the session exists on the bridge**;
  the bridge now buffers the latest list and applies it on attach. Whether Grok
  re-sends the list after `session/load` is unverified.
- **Claude probe results lack the live query's MCP servers**, so they are
  reported `stale`, not authoritative.

## Blocked live probes

All probes that need a credentialed provider session (plan step 01, items
4–7, and the mandatory inactive-environment scenario in step 12) were not run
in this change. They require an isolated `dev:test` profile with provider
credentials; see [`agent-testing.md`](../../development/agent-testing.md). The
affected rows keep their executors, which revalidate every selection before
dispatch, but their provider-side behaviour is qualified from source and
fakes only.

Isolated browser QA was attempted with
`mise run dev:test --profile slash-commands-qa --fixture --agent-platforms codex,claude`
and failed before readiness: Electron exited with "Missing X server or
$DISPLAY" because the implementing session had no display, and `dev:test`
has no headless mode. The profile was stopped and reset. The composer's
behaviour is covered by component tests (`SlashCommandMenu`,
`useSlashCommandMenu`, `AgentNativeTab.commands`, `useNativeAgentSession.commands`),
not by a real-browser run; the step 12 inactive-environment scenario remains
to be run on a machine with a display.

## Validation run on this branch

- `mise run check` (format, lint, all typechecks): pass.
- `mise run test`: first run exposed two real regressions (menu markup in
  `ClaudeTmuxChatTab.parts.test.tsx`, DOM absence assertions) — fixed — plus
  an aggregate timeout cluster recorded as flake 0152. Second run: every group
  passed except one backend case unrelated to commands, recorded as flake 0151
  (passes 5/5 in isolation).

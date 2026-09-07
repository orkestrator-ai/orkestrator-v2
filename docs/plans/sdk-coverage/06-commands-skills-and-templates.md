# 06 — Commands, skills and prompt templates

**Status:** ⬜ Not started · 0/15 tasks · Depends on: 02

## Goal

One normalized slash-command catalogue per session, populated from each SDK's
own discovery API, with a source tag so the picker can group entries without
knowing the platform. Replaces the Claude filesystem scan with a hard-coded
builtin list, the Grok count-only handling, and Pi's templates-only list.
Cursor has no command surface and keeps `slashCommands: false`.

## Normalized model

Extend `NativeAgentSlashCommand` in `packages/protocol/src/agent-slash-commands.ts`:

```
source: "builtin" | "project" | "user" | "plugin" | "skill" | "template" | "extension" | "orkestrator"
argumentHint?: string
aliases?: string[]
scope?: "global" | "session"
```

Bridge route: `GET /session/:id/commands` on every bridge (session-scoped;
`/global/slash-commands` and `/plugins/commands` remain for one release as
aliases, then go). Answers an empty list, never 404.

Backend: `NativeAgentRuntimeProvider.slashCommands(sessionId?)` gains the
session argument; the projection carries the catalogue; the picker renders
groups by `source`. Orkestrator's own runtime commands (`/steer`, `/compact`)
keep `source: "orkestrator"` and are still gated by `actions`.

## Tasks

### Protocol, backend, renderer

- [ ] Add the fields above; protocol tests for parsing and for the
  `source` grouping order.
- [ ] `HttpBridgeProvider.slashCommands` reads `/session/:id/commands`, falls
  back to the two legacy routes, and drops the `cursor|grok → []` hard-code
  at `http-bridge-provider.ts:1214`.
- [ ] `OpenCodeProvider.slashCommands` tags `command.list` entries as
  `project`/`user` by directory and marks `subtask` commands (fetched, unused
  today at `opencode-sessions.ts:298`) with a hint.
- [ ] Picker groups by `source` and shows `argumentHint`; no platform
  branches.

### Claude bridge

- [ ] Replace `services/slash-commands.ts` (filesystem scan, hard-coded
  `BUILTIN_COMMANDS` at `:140-156`) with `Query.supportedCommands()` and, for
  the pre-first-query case, `initializationResult().commands`. Tag builtins,
  project, user and plugin sources from the SDK's `SlashCommand` metadata.
- [ ] Read `system/init.skills` and list skills with `source: "skill"`;
  call `reloadSkills()`/`reloadPlugins()` on the refresh-catalog route.
- [ ] Retire `routes/plugins.ts:33-45` once the session route serves the
  same data.

### Codex bridge

- [ ] Merge `skills/list` (diagnostics-only today,
  `engine/app-server-engine.ts:866`) into the catalogue as `skill` entries
  alongside the filesystem-scanned prompts in `prompts/slash-commands.ts:202`.
  Keep `/goal` only if plan 15 wires goals; otherwise remove it.

### Pi bridge

- [ ] `readSlashCommands` (`agent-session.ts:904-915`) lists prompt
  templates (`template`), skills from `resourceLoader.getSkills()`
  (`skill`), and extension commands from
  `extensionRunner.getRegisteredCommands()` (`extension`). `/skill:name`
  already executes; this makes it visible.
- [ ] `reload()` on refresh-catalog so edited templates and skills appear
  without a new session.

### Grok bridge

- [ ] Keep the `availableCommands` entries (name, description, input hint)
  from `available_commands_update` (`acp-session.ts:664-671` keeps the count
  only) and serve them on `/session/:id/commands` with `source: "builtin"`.
  Persist alongside the session so a re-attach does not lose them.
- [ ] Lift the backend `slashCommands: false` for Grok in
  `packages/protocol/src/native-agent.ts:472` once the route exists.

### Cursor bridge

- [ ] Serve an empty list on the new route; capability stays `false`.

## Verification

- [ ] Bridge tests per platform: catalogue contents and `source` tags from
  a fixture.
- [ ] Browser: on Claude, Pi and Grok fixtures, open the picker, confirm
  groups; edit a prompt template on disk, refresh catalogue, confirm it
  appears; reload and confirm it persists.

## Out of scope

Executing a command differently from today. Cursor commands (no SDK surface).

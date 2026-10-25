# Claude bridge loads plugins Claude Code's settings turned off

Found on 2026-10-25 while qualifying
[0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md) against
the pinned Claude CLI (2.1.309). Orkestrator's Claude sessions load plugins,
and their MCP servers, hooks, skills, commands and agents, that the user
turned off in Claude Code.

## Current state

- The Claude bridge passes every plugin directory it finds to the SDK's
  `plugins` option (`getPluginsForSdk` in
  `bridges/claude-bridge/src/services/plugin-config.ts`), including every
  install recorded in `~/.claude/plugins/installed_plugins.json`, whether or
  not Claude Code has it enabled.
- The CLI treats each of those as a `--plugin-dir` plugin with id
  `<name>@inline`. Its enable rule looks only at `enabledPlugins["<name>@inline"]`
  (and the manifest's `defaultEnabled`); the `<name>@<marketplace>` key that
  `/plugin` and Claude Code's settings toggle never applies to it. Proven by
  `apps/backend/tests/claude-plugin-mcp-live.test.ts` (`gamma@market: false`
  in user settings, and the plugin still loads).
- So a plugin installed and then turned off in Claude Code still runs in
  every Orkestrator Claude session. The MCP editor shows this truthfully: the
  plugin's source says the marketplace id does not apply and names the
  `@inline` key that does.

## Outstanding work

### Code

1. Decide whether the bridge should honour Claude Code's own enablement for
   installed plugins: pass an `installed_plugins.json` install only when the
   first loaded settings layer whose `enabledPlugins` names its exact id sets
   it to `true` (the CLI's rule for its own installed copies), or stop passing
   installed plugins and let the CLI load its own installed copies from the
   same settings. Keep `~/.claude.json` and project plugin lists as they are.
   Update `claude-plugin-set.ts`, the editor's notes, the parity test and the
   live test together.

### Qualification

- Rerun `mise run verify:claude:plugin-mcp-live` with a fixture whose
  marketplace id is turned off and confirm the session no longer loads it, and
  that the editor's row says so.

## Constraints and rationale

- Containers copy `~/.claude/plugins` and the user settings, so the same rule
  must hold there.
- Changing which plugins load changes users' sessions (hooks and commands as
  well as MCP servers); say so in the release notes.

## Open questions

- Does the CLI load its own installed copies when the bridge stops passing
  them, with the paths it recorded on another machine (containers remap them
  today)?

## Related

- [0121-claude-plugin-mcp-servers.md](0121-claude-plugin-mcp-servers.md).
- [`mcp-management.md`](../../architecture/mcp-management.md) ("Claude
  plugins").

## Replaces

- Nothing.

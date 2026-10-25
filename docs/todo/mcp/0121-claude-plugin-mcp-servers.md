# Claude plugin MCP servers in the editor

Split from item 7 of [0039-mcp-management.md](0039-mcp-management.md) on
2026-10-25 (`ba7cc8d4`). The MCP editor
([`mcp-management.md`](../../architecture/mcp-management.md)) shows the files
each provider reads, but not the servers Claude Code plugins add. Of the
layers item 7 listed, only Claude plugins have a passive reader, so only they
can be modelled; the others (Cursor plugins and team settings, OpenCode
remote and organisation configuration, Codex profiles) stay unmodelled for the
reasons recorded there.

## Current state

- Plugin MCP servers appear only in a session's live panel. The Claude
  bridge passes plugin paths to the SDK
  (`bridges/claude-bridge/src/services/plugin-config.ts`: project
  `.claude/plugins.json`, then `~/.claude/plugins/installed_plugins.json`
  remapped to the local home, else a scan of the plugins folder), and the CLI
  loads each plugin's MCP servers under `plugin:<plugin>:<server>`.
- The live row's scope is `plugin`; the settings view's live join
  (`apps/web/src/components/settings/mcp-servers/mcp-live-join.ts`) says such
  a server comes from a plugin and is managed by the provider's plugin
  settings.
- Plugin server names are namespaced, so they never shadow or are shadowed by
  a file entry: the editor's effective rows are not wrong because of them,
  only incomplete.
- The backend already reads `installed_plugins.json` for skills
  (`apps/backend/src/core/environment-agent-skills.ts`), not for MCP servers.

## Outstanding work

### Code

1. **Read-only plugin source.** For the Claude backend-user and environment
   targets, list one read-only source per loaded plugin that declares MCP
   servers (its `.mcp.json`, and `mcpServers` in `plugin.json` if the pinned
   CLI reads that), named as the CLI names them, with the reason "Managed by
   Claude Code's plugin settings". Use the bridge's own plugin set, not a
   second resolver, so the two cannot drift.
2. **Enablement.** Show a plugin the CLI will not load (disabled through
   `enabledPlugins` in user, project or local settings) as disabled, with the
   setting that disables it. Mirror the pinned CLI's rule, with a parity test
   against the bridge in the style of `pi-mcp-parity.test.ts`.
3. **Variable expansion.** `${CLAUDE_PLUGIN_ROOT}` and environment references
   in plugin entries are shown as written, never resolved values.

### Qualification

- Install a fixture plugin with one stdio server in a disposable profile and
  confirm the editor's row, the live row and the join agree, including a
  plugin disabled in project settings.

## Constraints and rationale

- Read-only: plugin files belong to the plugin and are replaced on update.
- No path from a client: sources stay opaque ids, like every other source.
- Plugins can be large; reads are bounded like other sources (1 MiB).

## Open questions

- Does the pinned CLI read inline `mcpServers` from `plugin.json` as well as
  `.mcp.json`, and in which order?

## Related

- [0039-mcp-management.md](0039-mcp-management.md), item 7.
- [`mcp-management.md`](../../architecture/mcp-management.md) ("Plugin, team
  and remote layers are not modelled").

## Replaces

- Item 7 of [0039-mcp-management.md](0039-mcp-management.md), for Claude
  plugins only.

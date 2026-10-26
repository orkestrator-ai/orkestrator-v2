# Skills settings list skills of Claude plugins Claude Code turned off

Found on 2026-10-26 while fixing
[0151](../mcp/0151-claude-bridge-plugin-settings.md). Settings → Skills lists
the skills of every Claude plugin install, including ones Claude Code's own
settings turn off, which no Claude session loads any more.

## Current state

- `claudePluginRoots` in `apps/backend/src/core/agent-skills.ts` reads every
  key of `~/.claude/plugins/installed_plugins.json` and adds its
  `<installPath>/skills` as a plugin skill root, with no enablement check.
- Since 0151 the Claude bridge passes an install only when the first loaded
  settings layer whose `enabledPlugins` names its exact `<name>@<marketplace>`
  id sets it to `true` (`enabledInstalledPlugins` in
  `packages/protocol/src/node/claude-plugin-set.ts`), so a turned-off plugin's
  skills no longer reach a session but still appear in the list.
- Codex's plugin roots already follow its enablement (`codexEnabledPlugins`).
- The roots also widen the skill-file read allowlist, so narrowing them stops
  the page opening those files too.

## Outstanding work

### Code

1. Filter `claudePluginRoots` through `claudeInstalledPluginIdEnablement`
   over the user settings the CLI reads (`$CLAUDE_CONFIG_DIR/settings.json`,
   else `~/.claude/settings.json`); the backend-user list has no project, so
   say in the UI that a project's settings can still change it. Cover a
   turned-off, an enabled and a never-enabled install in
   `agent-skills.test.ts`.

## Constraints and rationale

- The list is display only; sessions already follow the bridge's rule.

## Open questions

- None.

## Related

- [0151-claude-bridge-plugin-settings.md](../mcp/0151-claude-bridge-plugin-settings.md).

## Replaces

- Nothing.

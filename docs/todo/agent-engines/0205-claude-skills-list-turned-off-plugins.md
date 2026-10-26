# Claude plugin skill enablement

Completed on 2026-10-26 while addressing the review of
[0151](../mcp/0151-claude-bridge-plugin-settings.md).

The host Settings → Skills catalogue and its file-read allowlist now include
only installs explicitly enabled by the shared Claude plugin rule. User
settings come from `$CLAUDE_CONFIG_DIR/settings.json`, falling back to
`~/.claude/settings.json`. This catalogue has no project context; project
settings can still change which plugin skills an individual session loads.

The environment scanner applies the same rule to user and project settings,
matching ordinary sessions. Local settings are an opt-in per prompt and do not
change the environment catalogue's default. Disabled and never-enabled installs
are excluded from both discovery and skill-file reads.

Regression fixtures cover enabled, disabled, never-enabled, project overrides,
local-only enablement and an alternate Claude configuration directory.

## Outstanding work

None.

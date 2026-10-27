# Claude plugin skill enablement

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Retire the finished file**: every item is done (Finished: Yes in the folder index); what is left is deciding what happens to this file. Status: done (the work); the file's disposal is open.

### 1. Retire the finished file

**Problem.** The work is complete, but the file is still in `todo/`. The README rules say a finished file is deleted once its durable behaviour is moved into `architecture/` or `development/`.

**Context.** The work was split from 0151 and shipped in `35081a81` (#1289, "honor plugin enablement across runtimes").

**Investigation.** The behaviour is in the code as described:
- The host catalogue reads only user settings, from `$CLAUDE_CONFIG_DIR` or `~/.claude` (`apps/backend/src/core/agent-skills.ts:137-145`), and skips installs not enabled under `["user"]` (`:236-249`).
- The environment scanner applies the same rule to `["user", "project"]` (`apps/backend/src/core/environment-agent-skills.ts:110-117`), using the same shared `claudeInstalledPluginIdEnablement` (`packages/protocol/src/node/claude-plugin-set.ts`).
- Regression coverage is in `apps/backend/src/core/agent-skills.test.ts:849` ("Claude plugin discovery") and `environment-agent-skills.test.ts`.

`docs/architecture/mcp-management.md` (around lines 196-227) documents the `enabledPlugins` rule for MCP servers. No architecture doc names the Skills catalogue or its file-read allowlist: a search for "Skills catalogue", `scanAgentSkills` or `agent-skills` under `docs/architecture` finds nothing.

**Decisions.**

- **What happens to this file?**
  - **Add a short paragraph to `docs/architecture/mcp-management.md` beside the `enabledPlugins` rule, then delete this file and its index row (recommended).** The paragraph says that the host and environment skill catalogues and their read allowlists follow the same rule, and which settings layers each reads.
    - Pros: follows the README rule; the one durable fact (which layers each catalogue consults) is not documented anywhere else.
    - Cons: a small doc change in a file that belongs to the MCP area.
  - **Delete it now without moving anything.**
    - Pros: the quickest; the code comments and tests describe the behaviour.
    - Cons: the layer difference (host: user only; environment: user and project; local opt-in per prompt) is easy to break and is then documented nowhere.
  - **Keep it as a record.**
    - Pros: no work.
    - Cons: against the README rules; it stays in the index with nothing to pick up.

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

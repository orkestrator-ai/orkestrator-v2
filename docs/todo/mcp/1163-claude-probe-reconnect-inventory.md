# A Claude MCP action without a running CLI replaces the session's live inventory with a probe's

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`, on branch
`todo-0039-mcp-management-d5f657bb2ee5`, while the Claude bridge's MCP
configuration code (`mcp-config.ts`, `session-manager-prompt-mcp-sync.ts`) had
uncommitted agent-account changes in the same worktree. Re-check the line
references once those land.

### Tasks

1. **Keep the session's inventory after a probe action**: a reconnect, enable or disable run through a probe updates only the row it acted on, not the whole list. Status: open.
2. **Report the layer a session actually loaded a server from**: a project server should not read as `user` in the live panel. Status: open.
3. **Real-browser regression**: extend `e2e/agent-testing/mcp-ui-matrix.spec.ts` to assert the injected `orkestrator` row and the layers survive a reconnect. Status: open; depends on 1 and 2.

### 1. Keep the session's inventory after a probe action

**Problem.** When a Claude session's CLI is not running (it exited after a refused turn, was evicted past the warm cap, or the bridge restarted), a live-panel action on one MCP server replaces the whole panel with what a throwaway probe CLI sees. The probe has none of the servers the bridge injects at launch, so Orkestrator's own `orkestrator` server (22 tools) disappears from the panel until the next turn.

**Context.** `performSessionMcpAction` (`bridges/claude-bridge/src/services/session-manager-catalog.ts:308`) uses the live control when there is one, otherwise `createProbe()` (`:223`), a `controlOnlyQuery` with only the working directory and environment. After the action it assigns `session.mcpInventory = control.mcpServerStatus()` (`:336`) from whichever control ran. `readSessionMcpServers` (`:274`) then serves that list, and the backend projection (`native-agent-transcript-projection.ts`, `runtime.mcp`) shows it, including after a reload.

**Investigation.** Observed in a real browser on a `--no-agent-credentials` profile (`mcp-ui-matrix.spec.ts`, live-panel case, 2026-10-31). The environment's `.mcp.json` held `mcpui-ok` (the probe fixture) and `mcpui-late` (a script that did not exist yet). One turn started the CLI, which reported the servers and ended "Not logged in". The projection then read:

- after the turn: `mcpui-ok:connected:user, mcpui-late:failed:user, orkestrator:connected:orkestrator` (panel: "Tools 23 · 3 servers · 1 down");
- after creating the script and clicking the failed row (reconnect): `mcpui-ok:connected:project, mcpui-late:connected:project` (panel: "Tools 2 · 2 servers"), and the same after a hard reload.

The reconnect went through the probe, since the refused turn's CLI had exited; the vanished `orkestrator` row is the probe's view. With a warm CLI the live control would answer and keep the row; that path was not exercised (it needs a turn that the provider accepts).

**Decisions.**

- **What should a probe action write back?**
  - **Merge: update only the acted-on row from the probe's status, keep the rest of the session's list (recommended).**
    - Pros: the panel keeps describing the session, not the probe; small change in one function.
    - Cons: the other rows stay as old as the session's last report.
  - **Do not write back from a probe at all; show the action's result as a one-off notice.**
    - Pros: the list only ever comes from the session.
    - Cons: the failed row stays "failed" after a successful reconnect until the next turn, which reads as the action not working.

### 2. Report the layer a session actually loaded a server from

**Problem.** After a turn, servers from the project `.mcp.json` read as `scope: "user"`; after a probe action the same servers read as `project`.

**Context.** The bridge passes the configured servers to the SDK inline, so the session's CLI reports them without their file layer. `mcpScope` (`bridges/claude-bridge/src/services/mcp-runtime-status.ts:15`) maps any unrecognized scope to `user` (`:23`). The probe reads the files itself and reports `project`. The live row's scope drives the "Config" link: `joinLiveMcpServer` (`apps/web/src/components/settings/mcp-servers/mcp-live-join.ts:150-154`) prefers saved rows in the live scope's sources, so a server named in both the user file and `.mcp.json` would open the user row although the project row is the one loaded.

**Investigation.** Only the unambiguous case was seen (each name in one layer, so the join fell back to the single named row). The two-layer case is inferred from the join code, not observed.

**Decisions.**

- **Where should the layer come from?**
  - **Tag each server with its source layer when the bridge builds the SDK `mcpServers` record, and use that tag over the CLI's report (recommended).**
    - Pros: the bridge already knows which file each entry came from; no dependence on CLI scope strings.
    - Cons: a second map to keep in step with the launch record.
  - **Leave the scope unset when the CLI reports an inline (dynamic) server.**
    - Pros: honest; the join then falls back to effective-row precedence, which is correct for Claude.
    - Cons: loses the layer for display and for any future use.

### 3. Real-browser regression

**Problem.** Nothing guards the panel's contents across a probe action.

**Context.** `e2e/agent-testing/mcp-ui-matrix.spec.ts` (opt-in `ORKESTRATOR_AGENT_TEST_MCP_UI=1`, `--no-agent-credentials` profile) already drives this exact flow and records the inventories as annotations.

**Decisions.** Assert, after the reconnect and after the reload, that `orkestrator` is still listed and both fixture rows read `project`.

## Assumptions and decisions

- The loss is assumed to last only until the session's CLI runs again: a read while a live control exists replaces the list from that CLI (`session-manager-catalog.ts:280`). Not observed (the next turn needs a working login). It still misleads a user who reconnects a failed server and then sees Orkestrator's own tools vanish.

## Current state

- Reconnect, enable and disable work without a running CLI through a probe, and the acted-on server's status is correct afterwards.
- The list the probe writes back drops launch-injected servers and reports different layers from the session's own report.

## Outstanding work

### Code

1. Merge a probe action's result into the session's inventory instead of replacing it.
2. Carry each server's source layer from the bridge's launch record into the live inventory.

### Qualification

- `mcp-ui-matrix.spec.ts` live-panel case passes with the added assertions on a `--no-agent-credentials` profile.

## Constraints and rationale

- The probe must stay: without it, a server cannot be reconnected or enabled while the session's CLI is down.

## Open questions

- Should the panel say when its list came from a probe rather than the session (for example "as of the last action")?

## Related

- [0039-mcp-management.md](0039-mcp-management.md) task 8 (real-browser UI matrix), where this was found
- `e2e/agent-testing/mcp-ui-matrix.spec.ts`

## Replaces

Nothing; new observation.

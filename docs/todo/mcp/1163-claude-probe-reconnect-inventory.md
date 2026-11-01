# A Claude MCP action without a running CLI replaces the session's live inventory with a probe's

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`, on branch
`todo-0039-mcp-management-d5f657bb2ee5`. Re-checked 2026-11-01 against `main` at
`0658de646`: both problems were still there, reproduced in a real browser. Line
references in the sections below describe the code before the fix.

### Tasks

1. **Keep the session's inventory after a probe action**: a reconnect, enable or disable run through a probe updates only the row it acted on, not the whole list. Status: done (2026-11-01).
2. **Report the layer a session actually loaded a server from**: a project server should not read as `user` in the live panel. Status: done (2026-11-01).
3. **Real-browser regression**: extend `e2e/agent-testing/mcp-ui-matrix.spec.ts` to assert the injected `orkestrator` row and the layers survive a reconnect. Status: done (2026-11-01); the same flow on a running CLI is still unobserved (see Outstanding work).

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

**Outcome (2026-11-01).** Merge, as recommended (`applyProbeMcpStatus` in `session-manager-catalog.ts`). Also decided: the row keeps the layer the session loaded it from; a name the session never listed is not added, because the list describes the session; a list not yet read is seeded from the init rows first; a live control's answer still replaces the whole list. Reconnecting `orkestrator` itself through a probe fails on the real CLI with `Server not found: orkestrator`, and the list stays as it was.

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

**Outcome (2026-11-01).** The launch tag, as recommended (`layers` from `getMcpRuntimeConfig`, kept as `session.mcpServerLayers`). A name takes the layer that won it in the bridge's merge. Servers the bridge injects are tagged `orkestrator`, which also stops `orkestrator-design` reading as `user`. The tag does not apply to a server whose source is `plugin`, `sdk` or `claudeai`. A server with no tag (an added account's own, a coordinator's research server) keeps the CLI's report. The two-layer case the investigation inferred is now observed: on the unfixed bridge the row read `user`, and with the fix the Config link opens the project row.

### 3. Real-browser regression

**Problem.** Nothing guards the panel's contents across a probe action.

**Context.** `e2e/agent-testing/mcp-ui-matrix.spec.ts` (opt-in `ORKESTRATOR_AGENT_TEST_MCP_UI=1`, `--no-agent-credentials` profile) already drives this exact flow and records the inventories as annotations.

**Decisions.** Assert, after the reconnect and after the reload, that `orkestrator` is still listed and both fixture rows read `project`.

**Outcome (2026-11-01).** Asserted after the turn, the reconnect and the reload, along with every row but the reconnected one being unchanged, the list surviving a reconnect of `orkestrator` itself, and a third fixture server, saved in both the user and the project file, opening its project row from Config.

The spec on `main` no longer passed on an unloaded host. A refused CLI stops its MCP servers about 100 ms after starting them, so `mcpui-ok` stayed `connecting` for the full 60 s at load 4 (the 2026-10-31 run was at load 25–53). The case now writes a `UserPromptSubmit` hook to its own worktree that holds the CLI open for 8 s; the login check still ends the turn, with "Not logged in" and no model call. List checks retry through the panel's collapse on a projection refresh, which failed some runs under load before that. The frozen `connecting` state itself is [1240](1240-claude-frozen-connecting-mcp-rows.md).

Results, all on a `dev:test --fixture --no-agent-credentials --agent-platforms claude` profile:

| Bridge | Result |
| --- | --- |
| Unfixed (`0658de646`) | Fails at `after-turn`: `mcpui-*` read `user`. With that check made soft, `after-reconnect` also fails: `orkestrator` is gone. |
| Fixed, old probe write-back put back | Fails at `after-reconnect`: `orkestrator` is gone. |
| Fixed | Both cases pass, 3 of 3 at load 36–43: `mcpui-ok:connected:project, mcpui-late:connected:project, mcpui-both:connected:project, orkestrator:connected:orkestrator` after the reconnect and after the reload. |

## Assumptions and decisions

- A read while a live control exists replaces the list from that CLI, so a merged row lasts only until the session's CLI runs again. Not observed: the next turn needs a working login. With the merge nothing is lost in the meantime, so this no longer misleads.
- Accepted from the merge: rows other than the acted-on one stay as old as the session's last report, which can be `connecting` ([1240](1240-claude-frozen-connecting-mcp-rows.md)).
- A probe reads the files by the CLI's own rules, so for a name in several layers it can reconnect a different entry from the one the session loaded. Inferred from the code, not observed. The row's result is then the probe's entry's, under the session's layer.
- The bridge's inline merge puts `.mcp.json` above the private `projects[cwd]` entry, so the tag says `project` when both name a server. The tag follows what the bridge passes, not the CLI's own file precedence.

## Current state

- Reconnect, enable and disable work without a running CLI through a probe, and only the acted-on row changes.
- The live panel reports the layer each server was loaded from, on a running CLI's report and on the init rows alike.
- Reconnect or disable on `orkestrator` with no CLI running is offered but fails with `Server not found: orkestrator`, which reads as if the server were missing. The list is unaffected.

## Outstanding work

### Qualification

- Reconnect on a running CLI, and the next turn replacing a merged list, need a turn the provider accepts, so a working login. Unit tests cover the live path; a real CLI has not exercised it. This keeps the file open ([0039](0039-mcp-management.md) task 8 points here for it).

## Constraints and rationale

- The probe must stay: without it, a server cannot be reconnected or enabled while the session's CLI is down.

## Open questions

- Should the panel say when its list came from a probe rather than the session (for example "as of the last action")?
- Should `orkestrator`'s reconnect and disable be withheld, or refused in clearer words, while no CLI is running?

## Related

- [0039-mcp-management.md](0039-mcp-management.md) task 8 (real-browser UI matrix), where this was found
- `e2e/agent-testing/mcp-ui-matrix.spec.ts`
- [1240-claude-frozen-connecting-mcp-rows.md](1240-claude-frozen-connecting-mcp-rows.md), found while qualifying this

## Replaces

Nothing; new observation.

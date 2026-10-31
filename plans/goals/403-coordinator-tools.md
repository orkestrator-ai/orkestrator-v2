---
id: 403
title: "Coordinator tools"
phase: 4
plan: "P4.3"
status: not-started
depends_on: [402]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 403 · Coordinator tools

- **Plan:** [P4.3 Coordinator tools](../goals.md#p43-coordinator-tools)
- **Decisions:** D4
- **Depends on:** [402](402-public-cli-and-api.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A coordinator can give a worker a goal and be woken when it ends.

## Work

- [x] Tools to set, read, pause and clear a goal on a worker the coordinator owns.
- [x] One wake when the goal ends or pauses (shared with 204).
- [x] Update `docs/architecture/coordinator.md` and `coordinator-providers.ts` qualification as its rules require.

## Tests

- [x] Control MCP tests, including a refused call for a tab the coordinator does not own.

## Done when

- [ ] A live coordinator run delegates a goal and reacts to its end.

## Notes

- 2026-10-31: **Live run not done.** A live coordinator run is opt-in and costs money, so
  it was not run, and "Done when" stays unticked. Everything below is proved with a
  scripted provider. `set_worker_goal` should be added as a scenario in
  `mise run test:agent:coordinator`, which has none for goals yet.
- 2026-10-31: Tools are `set_worker_goal`, `get_worker_goal`, `pause_worker_goal` and
  `clear_worker_goal` (`control-mcp-coordinator-goals.ts`), over
  `*_coordinator_worker_goal` commands (`coordinator-goal-actions.ts`). `maxIterations` is
  required, in the schema and the command, and a test pins the schema's maximum to
  `NATIVE_AGENT_GOAL_LIMITS.maxIterationsLimit`. "Owns" means a delegation record of this
  coordinator names the tab. There is deliberately no resume tool, since resuming can
  raise a limit.
- 2026-10-31: Found and fixed: `reconcileWorkerDelegations` closed a delegation when the
  tab read idle, which it does between iterations and during a check. So a sweep woke the
  coordinator early, and the goal's real end woke nobody. `CoordinatorService` now takes
  `workerGoal` and leaves a running goal's delegation open. A test shows the early wake
  without it.
- 2026-10-31: Model-facing reads frame worker text: `goalForModel` puts the report, status
  detail, verdict summary and check output in an `<orkestrator-goal-evidence>` frame.
  `get_tab_state` uses it for a coordinator, where the raw projection used to pass through.
  `list_agents` gained a content-free `goal`.
- 2026-10-31: `coordinator-providers.ts` needs no change: its rules cover read-only tiers
  and delegation, and these tools alter neither. The doc says so.
- 2026-10-31: Workers on another node are not covered (no `nodeId`): a remote delegation
  settles from its node's turn state, which does not know about goals.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude (worktree c4666baa82d9) · Added the tools, the wake fix, framing, docs and tests. · Live coordinator run still open, and remote workers need a follow-up.

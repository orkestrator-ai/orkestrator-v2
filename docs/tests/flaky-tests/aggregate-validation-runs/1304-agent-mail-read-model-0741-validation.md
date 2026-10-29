# Agent mail read model (todo 0741) branch validation

- **ID:** 1304
- **Status:** open
- **Date observed:** 2026-10-29
- **Branch:** `todo-0741-backend-responsiveness-bdd17f8d7880`, base
  `79f3bc97e`. The branch changes the agent mail store
  (`storage-agent-mail*.ts`), `storage-context.ts`, `storage-database.ts`, a
  comment in `agent-tools.ts`, two bench scripts and docs. No owner below
  changed or depends on those files.

## Run: `mise run test`

- **Host admission:** other worktrees ran `mise run test`, `test:full` and
  `test:browser` at the same time. Load average 31 to 36. The groups
  finished in 826 s. The codex protocol lockfile and root groups passed; the
  workspace and bridges groups failed.
- **Evidence:** `orkestrator-test-run.3I87UR/` and
  `orkestrator-test-run.3GcyRZ/` under the host temporary directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | `a cold app-server child > two pre-plugin answers stay stale until late plugins are observed and confirmed`: expected `stale`, received `ready` (52.9 ms). Recurrence of [0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md). | Passed alone (30 pass, 0 fail). |
| `apps/backend/tests/codex-subagent-cards.test.ts` | `each child keeps one card, its transcript and status across a fresh backend and a cold restart` timed out after 20,000 ms. Earlier: [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md), [1290](1290-idle-spec-sidebar-probe-0199-validation.md). | Passed alone (1 pass, 0 fail). |
| `apps/backend/src/core/preview-terminal-roots.test.ts` | `the spawned local setup terminal is a managed root until it exits` timed out after 20,004 ms. | Timed out the same way on the first solo run (load average 24 to 32), then passed on the second solo run (2 pass, 0 fail, 2.8 s). |

An earlier accidental run of the whole backend package
(`bun --cwd apps/backend test`, which runs the package `test` script) also
failed `control-mcp-leaf-nodes.test.ts > aggregate MCP regressions > legacy
and voice lists drain over 200 leaf projects and environments` on its 5 s
deadline, which passed alone (11 pass), as in
[1200](1200-coordinator-worker-surfaces-0142-validation.md). The same run
failed `apps/backend/tests/standalone.test.ts`, because `apps/backend/dist/main.js`
was not built. That file is not in the default tier.

No implementation, assertion, wait, timeout or skip in these owners changed.
The branch's own owners passed: all agent mail, coordinator, agent tools,
storage context and storage database suites.

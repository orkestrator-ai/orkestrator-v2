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

## Review repair validation, 2026-10-29

Review preparation reran `mise run test` at `b750ce439`. The workspace group
failed only `preview-terminal-roots.test.ts > the spawned local setup terminal
is a managed root until it exits` on its 20,000 ms deadline (20,000.79 ms).
The root, bridges and Codex protocol groups passed. The recorded preparation
artifacts are under
`.orkestrator/review-artifacts/review-validation-f6c7a656-e2bc-4c01-8979-a0e009bdcdb5/`.

The review repair's first isolated rerun also timed out (20,002.57 ms):

```bash
mise run test:logged -- --name review-preview-terminal-root -- bun test --cwd apps/backend ./src/core/preview-terminal-roots.test.ts --parallel=1 --only-failures
```

Result: 1 pass, 1 fail, 5 assertions, 2 tests in one file (20.20 s).
Failure artifact: `orkestrator-test-run.IyM5IM` under the host temporary
directory. This observation does not establish a new cause; the earlier
pass-after-retry evidence above remains the basis for tracking it as flaky.
The review repair changes only storage code and tests; the terminal owner
and its timeout are unchanged.

The exact default command was rerun after the storage repair at `9e82e514b`:

```bash
mise run test:logged -- --name review-default-tests -- mise run test
```

The scheduler reserved workspace/root/bridges/protocol worker slots of
6/1/2/1, waiting 323.6 s for another worktree's exclusive resource. The full
run finished in 529.1 s including that wait (outer wrapper: 530.3 s).
Root (3,249 pass), bridges and protocol lockfile passed. Workspace retained
two failures in unchanged owners:

- Backend: 10,184 pass, 87 skip, 1 fail; the same setup-terminal timeout
  recurred (20,001.22 ms).
- Web: 10,398 pass, 10 skip, 1 fail; the sibling ledger had length 0 instead
  of 1 in `rich-conversation-revocation.test.tsx` (211.25 ms), a recurrence
  of [0626](../native-agents-and-transcripts/0626-rich-content-sibling-ledger-aggregate.md).
  Its complete isolated owner passed (exit 0, 1.5 s).

Evidence: `orkestrator-test-run.2mai8S` (group logs and summary) and
`orkestrator-test-run.LbkZa8` (outer wrapper) under the host temporary directory.
All targeted storage regressions and backend typechecking passed; changed
TypeScript files passed formatting and lint. The two unrelated owners were
not changed or weakened by this repair.

The post-aggregate isolated terminal-owner rerun used the same
`review-preview-terminal-root` command above and timed out again
(20,002.33 ms; 1 pass, 1 fail, 5 assertions; 20.27 s for the file, 20.3 s
logged). Evidence: `orkestrator-test-run.yg7qQY` under the host temporary
directory. This owner remains non-green in this repair; no new cause or
resolution is claimed.

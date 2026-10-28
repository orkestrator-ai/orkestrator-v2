# Structured tickets (todo 0742) branch validation

- **ID:** 1250
- **Status:** open
- **Date observed:** 2026-10-28
- **Command:** `mise run test`, on the ticket kinds, tiled view and checkable
  criteria branch (three commits on `68c84506c`).
- **Host admission:** the run waited for another worktree's exclusive test
  lease before starting. Codex protocol lockfile, bridges and root passed; the
  workspace group failed after 1,318 seconds.
- **Evidence:** `orkestrator-test-run.qjOxTa` under the host temporary
  directory.

| Owner | Aggregate failure | Complete unchanged owner rerun |
| --- | --- | --- |
| `apps/backend/src/core/agent-tools.test.ts` | `agent Kanban tools > bounds large ticket responses and does not duplicate full content` timed out at 5,210 ms. | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-tools.test.ts` passed (6.0 s for the file). The one test runs in 1.9–2.0 s alone on this branch and 1.5–2.2 s on a clean `origin/main` checkout. |
| `apps/backend/tests/codex-subagent-cards.test.ts` | `each child keeps one card, its transcript and status across a fresh backend and a cold restart` failed at 1,809 ms. Recurrence of [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md). | Passed alone (2.5 s). |
| `apps/desktop/electron/application-logging.test.ts` | `application logging shutdown > closes the log only after pending output settles` failed at 28 ms. Same fixed-sleep shutdown family as [0712](../electron-and-desktop/0712-application-logging-flush-deadline-under-load.md). | Failed once more on the first isolated rerun, then passed four isolated reruns in a row. The branch does not touch `apps/desktop`. |
| `packages/cli/tests/command-surface.test.ts` | `native shell completion execution > zsh bashcompinit parses option values and offers short flags` timed out at 5,026 ms. The zsh sibling of [0955](../backend-services-and-tooling/0955-cli-fish-completion-aggregate-timeout.md). | Passed alone (5.6 s for the file). |

No implementation, assertion, wait, timeout or skip in these four owners
changed. The branch changes the agent ticket tools, but the bounded-output test
times the same as on `main` when run alone.

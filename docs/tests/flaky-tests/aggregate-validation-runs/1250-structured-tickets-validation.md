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


## Criterion verification review — 2026-10-28

The review repair run used `mise run test:logged -- --name review-repair-default -- mise run test` and waited 559 seconds for another worktree's lease. Its protocol check passed. The first run also exposed an inconsistent Kanban card fixture: it supplied checked sections with empty text mirrors and no sections basis. The new stale-mirror projection correctly discarded that fixture's criteria. The fixture now uses `ticketContentFromSections`; its complete owning file and root typecheck pass.

The unrelated failures observed before stopping that superseded run are retained as validation limitations:

| Owner | Aggregate failure | Complete owning-file rerun |
| --- | --- | --- |
| `bridges/codex-bridge/src/testing/fake-codex-app-server.test.ts` | Five-second version-probe timeout. | Passed unchanged in 1.4 s; recurrence recorded in [0210](../agent-bridges/0210-fake-codex-process-timeout.md). |
| `tests/unit/components/GitHubCloneIntegration.test.tsx` | Empty-destination alert did not appear within the assertion window. | Passed unchanged in 10.5 s; recurrence recorded in [0352](../web-ui/0352-github-picker-non-git-destination-alert.md). |
| `tests/unit/efficiency/harness.test.ts` | Unchanged pipeline session case timed out at 5024 ms. | Passed unchanged in 8.9 s; recurrence recorded in [0788](../backend-services-and-tooling/0788-efficiency-checkpoint-aggregate-timeout.md). |
| `tests/unit/test-tiers.test.ts` | SIGINT cleanup expected exit 0 but received 130. | Passed unchanged in 7.2 s. |
| `tests/unit/disk-report.test.ts` | Five-second process deadline. | Still failed in a three-owner rerun (23.5 s combined); no new isolated pass established. |
| `packages/cli/tests/command-surface.test.ts` | zsh completion timed out after five seconds. | Still failed alone (13.9 s); no new isolated pass established. |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | Projection read count was two instead of one. | Still failed alone (12.9 s), matching [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). |

Additional root-change approval and transcript-artifact cleanup failures in the workspace group have not been isolated. No assertions, timeouts or skips in these unrelated owners were changed. The superseded run was stopped after 1,139 seconds, preserving its failure artifacts. The exact aggregate command was started again after repairing the Kanban card fixture; it then queued behind another worktree's exclusive lease. No passing aggregate result was established in this repair turn.

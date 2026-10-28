# Todo number guard review validation

- **ID:** 1223
- **Status:** open
- **Date observed:** 2026-10-28
- **Command:** `mise run test:logged -- --name review-fixes-default-tests -- mise run test`
- **Snapshot:** `7eabcbab3` plus the todo 0732 review fixes. The measurement-retention fixture repair was made after its file had already failed in this run and requires a separate aggregate rerun.
- **Workers:** workspace 6 slots (backend 4 isolated Bun workers), root 1, bridges 2 (one per package), protocol 1. Groups waited about 19 minutes behind earlier worktrees in the shared host queue before executing.
- **Outcome:** exit 1 after 1744.7 s including queue time. Backend: 9902 pass, 87 skip, 4 fail, 2 errors; web: 10150 pass, 10 skip, 3 fail; root: 3240 pass, 1 fail; Codex: 2221 pass, 51 skip, 1 fail. Protocol passed.
- **Evidence:** host temporary directory `orkestrator-test-run.7b6xLR/` (group logs compressed on completion), with the enclosing log in `orkestrator-test-run.8LpizX/`.

## Failures and complete owning-file reruns

| File | Aggregate failure | Isolated result |
| --- | --- | --- |
| `apps/backend/src/core/change-tracking/measurement-retention.test.ts` | Backlog timeout at 13577.71 ms; following large-measurement case hit a closed database at 283.35 ms. | Passed unchanged in 3.4 s before the run; fixture now uses a transaction, then all five tests passed in 3.7 s. See [1222](../coordinator-and-multi-review/1222-measurement-retention-backlog-aggregate-timeout.md). |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | Two-pre-plugin-answer case expected stale, received ready (76.95 ms). Codex package: 2221 pass, 51 skip, 1 fail. | 29 pass, 1 fail in 3.8 s: original mismatch passed, but the in-flight-read settling wait at line 241 timed out (2081.42 ms). Known real-timer issue [0791](../agent-bridges/0791-codex-command-catalogue-stale-race.md); this observation does not establish an aggregate-only failure for the owner. |
| `tests/unit/disk-report.test.ts` | Isolated-checkout case timed out at 5046.05 ms and the child status was null. | Complete unchanged file passed in 5.3 s, consistent with [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). |
| `apps/backend/tests/codex-subagent-cards.test.ts` | Cold-restart projection expected idle, received recovering (1311.42 ms). | Complete unchanged file passed in 3.8 s, consistent with [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md). |
| `apps/backend/src/core/commands-agent-tools.test.ts` | Background configuration count remained 1 after the fixed 150 ms wait (216.52 ms). | Complete unchanged file passed in 4.9 s, consistent with [0280](../native-agents-and-transcripts/0280-agent-tools-background-configuration-timing.md) and [0320](../native-agents-and-transcripts/0320-opencode-agent-tools-background-reconcile.md). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | Root-change approval over-limit/rejection case exceeded 5000 ms (5605.61 ms). | Retained the same timeout alone (5483.42 ms): 10 pass, 1 fail in 9.2 s. Not newly classified as a flake; the failure remains unresolved and this branch changes no federation code. |
| `apps/web/src/components/chat/NativeMessage.test.tsx` | Icon-only assistant-metadata copy button lookup failed (308.30 ms). | Complete unchanged file passed in 17.0 s. Cause unknown; aggregate-only observation. |
| `apps/web/src/components/settings/machine-sign-in-routing.test.tsx` | Sign-in routing expected only open_in_browser but also observed get_node_status and get_node_summaries calls (59.30 ms). | Complete unchanged file passed in 2.6 s. Cause unknown; aggregate-only observation. |

Each rerun used `mise run test:logged -- --name <label> -- bun test` with
one explicit owning-file path, `--parallel=1 --only-failures`, and the
owning package's working directory. Exact commands:

```sh
mise run test:logged -- --name codex-command-catalogue-isolated -- bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
mise run test:logged -- --name disk-report-isolated -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures
mise run test:logged -- --name codex-subagent-cards-isolated -- bun test --cwd apps/backend ./tests/codex-subagent-cards.test.ts --parallel=1 --only-failures
mise run test:logged -- --name agent-tools-isolated -- bun test --cwd apps/backend ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures
mise run test:logged -- --name node-action-requests-isolated -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name native-message-isolated -- bun test --cwd apps/web ./src/components/chat/NativeMessage.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name machine-sign-in-isolated -- bun test --cwd apps/web ./src/components/settings/machine-sign-in-routing.test.tsx --parallel=1 --only-failures
```

Passing output was removed by `test:logged`. Failing isolated evidence remains
in `orkestrator-test-run.bstBOq/` (Codex catalogue) and
`orkestrator-test-run.5YOOsh/` (node action requests). No unrelated source,
assertion, timeout, or skip was changed. The first aggregate remains non-green;
post-repair validation is recorded below.

## Post-repair aggregate rerun

The exact aggregate command above was rerun after batching the retention
fixture setup. Workspace (including the full four-worker backend), root,
and protocol groups passed. Workspace finished at 981.7 s including about
632 s queued. Bridges never gained host admission. The enclosing
`test:logged` runner hit its 1800000 ms group deadline, terminated the
aggregate with SIGTERM, and exited 1. No group was executing at termination
(`terminating 0 group process tree(s)`). The post-repair aggregate therefore
remains incomplete due to queue admission, rather than a failing backend or
root test. This does not establish a green full-suite result. Evidence:
`orkestrator-test-run.YF9rzI/review-fixes-default-tests.log.gz` under the host
temporary directory. Slow, browser, Electron, Docker, CLI scenario, and iOS
suites were not selected for these documentation and unit-test changes.
The original measurement-retention failure is resolved in [1222](../coordinator-and-multi-review/1222-measurement-retention-backlog-aggregate-timeout.md).

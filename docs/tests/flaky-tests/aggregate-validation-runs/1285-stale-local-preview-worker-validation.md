# Stale local preview worker (todo 0385) branch validation

- **ID:** 1285
- **Status:** open
- **Date observed:** 2026-10-28
- **Command:** `mise run test`, on the todo 0385 branch (one commit on
  `6a6009a09`, which was also `origin/main` at the time).
- **Host:** shared, with other worktrees' runs active; load average 34 just
  after the run. Codex protocol lockfile and root passed. Bridges failed after
  71.6 s and the workspace group after 576.7 s.
- **Evidence:** `orkestrator-test-run.PgXP84` under the host temporary
  directory. Isolated reruns: `orkestrator-test-run.fKFGVL` and
  `orkestrator-test-run.3UKcQo`.

| Owner | Aggregate failure | Complete unchanged owner rerun |
| --- | --- | --- |
| `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts` | `concurrent cancels for one claim > repeat cancels of an accepted run share one abort`: the second cancel's body was `{ cancelled: false }` (13 ms). Recurrence of [1002](../agent-bridges/1002-pi-repeat-cancels-share-one-abort.md). | `mise run test:logged -- --name pi-prompt-cancel-preflight -- bun test --cwd bridges/pi-bridge ./src/prompt-cancel-preflight.test.ts` passed (5.3 s). |
| `apps/backend/tests/claude-state-signal-integration.test.ts` | `hook writers serialize counters and retain a completed turn without any config` failed at 1,181 ms. Recurrence of [1102](../native-agents-and-transcripts/1102-claude-hook-concurrent-counter-snapshot.md). | `bun test --cwd apps/backend ./tests/claude-state-signal-integration.test.ts` through `test:logged` passed (3.4 s). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | `AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning`: expected one projection read, received two (2,070 ms). Recurrence of [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). | Failed alone on the branch (25 passed, one failed; 12.0 s) and on a clean `origin/main` worktree at `6a6009a09` (25 passed, one failed; the test took 2,540 ms). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | `root-change approval handles over-limit and still permits rejection` failed at 5,805 ms. Same owner as the root-change approval failures in [1223](1223-todo-number-guards-review-validation.md) and [1248](1248-project-landing-tab-review-validation.md). | Failed alone on the branch (10 passed, one failed; 9.2 s) and on the clean `origin/main` worktree (10 passed, one failed; the test took 5,782 ms). |

The branch changes only the transcript-artifact preview worker runtime, its
protocol status field, the preview worker prepare card and `build.sh`. None of
these owners import them, and no assertion, wait, timeout or skip in them was
changed. The two web owners fail the same way on clean `main` under this load,
so they are not attributed to the branch.

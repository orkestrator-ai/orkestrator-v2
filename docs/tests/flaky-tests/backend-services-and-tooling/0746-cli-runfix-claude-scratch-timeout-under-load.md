# runFix > starts Claude Code in a scratch directory with the prompt and only the logs directory (packages/cli/tests/fix-command.test.ts)

- **ID:** 0746
- **Status:** open
- **Date observed:** 2026-10-24
- **Original command:** `mise run test` (non-iOS aggregate) on the `todo-0011-runtime-state-ownership` branch, node mbp3 (macOS, Apple Silicon), while `mise run test:agent:browser:isolated` was running on the same host.
- **Worker configuration:** default aggregate groups in parallel; CLI package `test:workspace` script.
- **Failure:** `this test timed out after 5000ms` (5,020.88 ms); the paired between-test error was `expect(exitCode).toBe(7)` at `fix-command.test.ts:262` receiving `143` (the child was terminated at the timeout).
- **Suite counts:** CLI package 227 tests across 18 files: 226 passed, 1 failed.
- **Isolated rerun:** `mise run test:logged -- --name cli-fix -- bun test --cwd packages/cli ./tests/fix-command.test.ts --parallel=1` → passed (2.7 s).
- **Hypothesis:** the fake Claude Code child did not finish inside Bun's 5 s per-test budget on a saturated host; exit 143 is SIGTERM from the timeout, not a wrong exit path. The branch does not touch `packages/cli`.

## Triage 2026-10-25

- **Disposition:** open. This case now also covers [0765](0765-cli-fix-claude-scratch-aggregate-timeout.md) (duplicate, same test).
- **Folded from 0765:** 2026-10-24, 0034 mixed-version branch, full suite on mbp3 with the CLI on two workers beside the backend suite. Timed out at 5001.06 ms; the fake `claude` was killed, so exit 143 instead of 7 at line 262. The owner passed alone (3.4 s) and in three plain runs.
- **Related:** [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md) saw `runFix > passes OpenCode its prompt flag and pinned environment` time out at 5003.35 ms in the same file (passed alone in 5.2 s).
- **Rerun today:** the owner alone (Bun 1.4.4, load average about 37): this case passed. A different case, `packaged launcher dispatches fix without importing a backend or creating data`, failed with ENOENT on `packages/cli/dist/client.js` because the CLI is not built in this worktree. That is a missing build, not a flake; the aggregate builds first.
- **Next step:** give the `runFix` cases that spawn a fake agent an explicit budget (they use Bun's default five seconds), as 0159 did.

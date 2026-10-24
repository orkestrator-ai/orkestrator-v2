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

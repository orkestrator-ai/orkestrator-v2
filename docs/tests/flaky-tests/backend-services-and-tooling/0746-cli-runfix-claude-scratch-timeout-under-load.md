# runFix > starts Claude Code in a scratch directory with the prompt and only the logs directory (packages/cli/tests/fix-command.test.ts)

- **ID:** 0746
- **Status:** resolved
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
- **Related:** [9884](../aggregate-validation-runs/9884-coordinator-adapters-main-merge-validation.md) saw `runFix > passes OpenCode its prompt flag and pinned environment` time out at 5003.35 ms in the same file (passed alone in 5.2 s).
- **Rerun today:** the owner alone (Bun 1.4.4, load average about 37): this case passed. A different case, `packaged launcher dispatches fix without importing a backend or creating data`, failed with ENOENT on `packages/cli/dist/client.js` because the CLI is not built in this worktree. That is a missing build, not a flake; the aggregate builds first.
- **Next step:** give the `runFix` cases that spawn a fake agent an explicit budget (they use Bun's default five seconds), as 0159 did.

## Resolution (2026-11-15)

- **Root cause:** the fake agent child did not finish within Bun's 5 s default budget on a saturated host; exit 143 was the runner's kill at the timeout. The file also had a 5 s `waitForFile` deadline and a 10 s child kill timer.
- **Fix:** `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup.ts`, `tests/setup-node.ts`), raises Bun's default per-test and hook budget from 5 s to 60 s (a hang watchdog only). `packages/cli/tests/fix-command.test.ts` sets no smaller test budget; `waitForFile` is now a 50 s hang watchdog on a file the child writes, and the launcher child's kill timer is a 50 s watchdog. Also covers folded case 0765.
- **Reproduced:** no — the 5 s default budget was not exhausted before the change under the contention runner; the post-change run below shows only the current state. Base `a8b89f1541e7abb6af36d45121593ae14640a3ca`.
- **Stress:** `mise run test:logged -- --name f3-a-batch -- bun scripts/test-under-contention.ts --core 10 --burners 6 -- bun test --cwd=packages/cli --preload ../../tests/setup-node.ts ./tests/command-surface.test.ts ./tests/fix-command.test.ts --rerun-each=3` passed.

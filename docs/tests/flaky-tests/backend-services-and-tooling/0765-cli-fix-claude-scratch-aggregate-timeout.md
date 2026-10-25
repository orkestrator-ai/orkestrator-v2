# CLI `--fix claude` scratch-directory case times out under aggregate load

- **ID:** 0765
- **Status:** resolved
- **Date observed:** 2026-10-24
- **Test:** `runFix > starts Claude Code in a scratch directory with the prompt and only the logs directory`
- **File:** `packages/cli/tests/fix-command.test.ts`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` on node mbp3 (default workspace/root/bridge/protocol reservations; the CLI package ran with two parallel Bun workers beside the backend workspace suite), validating the 0034 mixed-version branch.
- **Failure:** hit the five-second test timeout (5001.06 ms). The fake `claude` agent was killed (`killed 1 dangling process`), so `runFix` returned 143 (SIGTERM) instead of the fake's exit code 7, reported as an unhandled error between tests at `fix-command.test.ts:262`.
- **Suite counts:** CLI package 226 passed, 1 failed across 227 tests in 18 files (33.10 s).
- **Owning-file rerun:** `mise run test:logged -- --name cli-fix-owner -- bun test --cwd packages/cli --preload ../../tests/setup-node.ts ./tests/fix-command.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 3.4 s); three plain `bun test tests/fix-command.test.ts` runs from `packages/cli` also passed.
- **Evidence:** `orkestrator-test-run.TGSPX0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; outer run `orkestrator-test-run.WmfcOl`.
- **Hypothesis:** spawning the fake agent script under heavy concurrent load (the backend workspace suite ran at the same time) took most of the five-second budget, so the test timed out and the runner killed the child; unconfirmed. The branch does not touch `packages/cli`. No test, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** resolved as a duplicate of [0746](0746-cli-runfix-claude-scratch-timeout-under-load.md): the same test, the same 5 s timeout and exit 143. Its facts are folded into 0746's triage section, which is the case to follow.

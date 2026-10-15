# Tmux orphan reconciliation intermittently leaves the installed hook

- **ID:** 0245
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `Electron tmux environment teardown > orphan reconciliation retains failed managed stops and cleans hooks when tmux has no server`
- **File:** `apps/backend/tests/tmux-commands-teardown.test.ts:359`
- **Original command:** `mise run test:logged -- --name root-tests -- mise run test`.
- **Failure:** the restored `settings.local.json` at line 445 still contained the installed hook rather than the original settings (248 ms).
- **Context:** backend ran with two isolated workers; browser component and isolated-browser validation were also running on the host.
- **Isolated rerun:** `mise run test:logged -- --name tmux-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures` passed unchanged in 2.4 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.aDyLLJ/root-tests.log.gz`.
- **Hypothesis:** fake process completion or orphan cleanup timing under load; cause unconfirmed. No assertion, implementation, timeout or skip was changed.

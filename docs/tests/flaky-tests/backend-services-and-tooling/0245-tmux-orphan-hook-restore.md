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


## Migration timeout coverage review recurrence — 2026-10-26

- Command: `mise run test:logged -- --name repository-tests -- mise run test`,
  Linux x64, workspace/root/bridge/protocol reservations 4/1/2/1, two backend
  workers, migration test-only commit `006b1000`.
- The orphan-reconciliation case retained installed hooks at 95.34 ms.
- Backend: 11,793 passed, 143 skipped, eight failed in 707 files (547.71 s).
  Full suite evidence and the other failures are recorded in
  [1003](../aggregate-validation-runs/1003-legacy-migration-0058-validation.md#timeout-coverage-review-validation--2026-10-26).
- Complete unchanged owner:
  `mise run test:logged -- --name tmux-teardown-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/tmux-commands-teardown.test.ts --parallel=1 --only-failures`
  passed, exit 0, 1.2 s.
- Artifact: `/tmp/orkestrator-test-run.1QvzPF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  Cause remains unconfirmed; no implementation, assertion, timeout or skip changed.

# E8 recorded backend failures

- **ID:** 4843
- **Status:** open
- **Observed:** 2026-11-05

Preparation's `mise run test` at cd5b0142 reported:

- `runCommand > preserves timeout and termination signal as structured failure metadata` (`apps/backend/tests/shell.test.ts`): expected SIGTERM, got null, 142.60 ms.
- `Electron backend command registry > gives an image without the helper the token-bearing rewrite, idempotently` (`apps/backend/tests/commands-container-exec.test.ts`): exceeded 5000 ms, 5005.07 ms.
- `LoopbackListenerOwnership on this host > attributes a real 127.0.0.1 listener and refuses another environment` (`apps/backend/src/core/preview-listener-ownership.test.ts`): expected true, got false, 5496.98 ms.

The complete owners passed with one worker (each file isolated by Bun):

```sh
mise run test:logged -- --name recorded-backend-failures -- bun --cwd=apps/backend test tests/shell.test.ts tests/claude-state-signal-integration.test.ts tests/commands-container-exec.test.ts src/core/preview-listener-ownership.test.ts --parallel=1 --only-failures
```

Result: pass, 6.1 seconds. The fourth file's recurrence is recorded in case 1102. Passing output was removed by the logged runner; it reported 1379 output bytes without test totals. The original aggregate has ten named failures plus between-test errors, with no reliable combined total. Original diagnostics are preserved at `.orkestrator/review-artifacts/review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt`. Worker counts were selected by the aggregate scheduler. No assertions, deadlines or skips changed. Load sensitivity is plausible, but no root cause is established.

## 2026-11-06 recurrence: credential helper after setup

Preparation at c8d754a1941b0e9162020adbadd370f03165462a ran
`mise run test:logged -- --name review-default-tests -- mise run test` with
scheduler-selected workers. `Electron backend command registry > GitHub
credential helper > keeps working after setup clears credential.helper, on
either order` exceeded 5000 ms (5021.72 ms); its synchronous Bash child returned
null status. Diagnostics are preserved in
`.orkestrator/review-artifacts/review-validation-c3a6efad-888c-4081-b04f-447d7bee2f9c/validation-04.stderr.txt`,
lines 136–158. The aggregate has no reliable complete summary and reports
between-test errors.

The complete owner passed in isolation:
`mise run test:logged -- --name recorded-container-exec -- bun test --cwd apps/backend ./tests/commands-container-exec.test.ts --parallel=1 --only-failures`
(exit 0, 3.0 s, 807 output bytes; passing output removed by the logged runner).
The credential helper and owning test have no branch diff against origin/main;
the triage's related classification comes through the command registry's import
of environment-cleanup-reconciler.ts, not the helper exercised by this test.
No assertion or deadline changed. The cause remains unestablished; this is
recorded as a recurrence, not an implementation fix or a green aggregate.

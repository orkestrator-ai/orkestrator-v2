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

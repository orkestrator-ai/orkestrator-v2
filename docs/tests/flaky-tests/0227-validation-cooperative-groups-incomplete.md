# Review validation: cooperative parallel groups finished "incomplete" under load (`apps/backend/src/core/review-validation-worker.test.ts`)

- **ID:** 0227
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `cooperative parallel groups do not multiply queue or execution deadlines`
- **Owning file:** `apps/backend/src/core/review-validation-worker.test.ts:1162`
- **Original command:** `mise run test:logged -- --name full-suite-4 -- mise run test`
  on the default PATH, with the standard group slots and other workers' suites
  on the host.
- **Failure:** `expect(done.results[0]!.status).toBe("passed")` received
  `"incomplete"` after 3,650.15 ms. The earlier `queued` and "worker slots"
  assertions passed.
- **Suite counts:** backend 7,704 passed, 39 skipped, 2 failed (7,745 tests,
  308.64 s). The other failure is a recurrence of 0187.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1`
  from `apps/backend` passed unchanged (46 tests, 41.08 s).
- **Evidence:** `/tmp/orkestrator-test-run.9os4UH/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the case's execution deadline expired while the host was
  contended, so the run ended `incomplete` rather than `passed`. Not confirmed.

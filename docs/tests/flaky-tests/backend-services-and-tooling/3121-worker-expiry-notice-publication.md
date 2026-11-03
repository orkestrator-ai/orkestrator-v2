# Pipeline worker expiry notice asserted before publication finished

- **ID:** 3121
- **Status:** resolved
- **Date observed:** 2026-11-03
- **Test:** `a claim settling returned after terminal synchronization keeps its outcome`
- **Owning file:** `apps/backend/src/core/pipeline-worker-mail.test.ts`
- **Original command:** `mise run test:logged -- --name worker-mail-surrounding -- bun test --cwd apps/backend ./src/core/agent-mail-service.test.ts ./src/core/agent-mail-service-steer.test.ts ./src/core/agent-mail-service-presence.test.ts ./src/core/agent-mail-service-upstream.test.ts ./src/core/storage-agent-mail.test.ts ./src/core/storage-agent-mail-routes.test.ts ./src/core/storage-agent-mail-read-model.test.ts ./src/core/build-pipeline-service-base.test.ts ./src/core/build-pipeline-review-fanout.test.ts ./src/core/build-pipeline-validation-history.test.ts ./src/core/build-pipeline-worker-mail.test.ts ./src/core/build-pipeline-review-fanout-worker-mail.test.ts ./src/core/pipeline-worker-mail.test.ts --parallel=4 --only-failures`
- **Worker configuration:** four isolated backend workers.
- **Failure:** expected one expiry notice, received zero after 69.06 ms; the message itself had already expired.
- **Suite counts:** 307 passed, one failed, 308 tests across 13 files in 4.03 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.kVp9MU/worker-mail-surrounding.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name worker-mail-owner -- bun test --cwd apps/backend ./src/core/pipeline-worker-mail.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 2.0 seconds).
- **Root cause:** the mail service's scheduled directory sync could expire the message while the test's explicit sync found nothing left to expire. Notices are sent after the store lock is released, so the test could read between expiry and notice publication.
- **Fix:** the explicit-sync test shuts down and drains the mail service's timers before claiming and terminating the worker. It retains the placement and notice assertions. The separate live steer race tests keep the service running.
- **Verification:** the original four-worker surrounding command passes after the fixture barrier; focused owner and backend type checks also pass.


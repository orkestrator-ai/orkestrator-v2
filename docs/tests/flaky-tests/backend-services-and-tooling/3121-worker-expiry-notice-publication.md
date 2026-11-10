# Pipeline worker expiry notice asserted before publication finished

- **ID:** 3121
- **Status:** open
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


## Sibling expiry-notice assertion — 2026-11-10 (reopened)

Observing branch base: `04639b12b71d4326a3b8941485367aca197f4966`;
reviewed head: `c6b3ce9792c064bcac5e9eb7a287675fcbe73118`.
The repaired default rerun (`mise run test:logged -- --name address-default-repaired -- mise run test`)
failed the sibling test `mail queued for a worker that ends expires, and the sender is told`
at line 379 (165.09 ms): expected notice sender `system`, received undefined.
The backend used two isolated workers. The message had passed its expired-placement
assertions before the notice lookup. This is the same publication symptom in
another test; the earlier root cause is not established for this observation.

The complete unchanged owner passed alone in 6.3 s:
`NODE_ENV=test mise run test:logged -- --name address-worker-mail-owner -- bun test --cwd apps/backend ./src/core/pipeline-worker-mail.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.
Counts are unavailable because the passing output was deleted. No mailbox
implementation, assertion or timeout changed. The recurrence checker reported
this case resolved before this observation; it is reopened for investigation.
Final aggregate counts and evidence are recorded in the Address Findings result.

Final rerun evidence: `/tmp/orkestrator-test-run.GX1alI/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
backend 17,922 pass, 145 skip, one fail. The root group passed (4,309 pass,
one skip); other workspace packages, bridges and protocol lockfile passed.

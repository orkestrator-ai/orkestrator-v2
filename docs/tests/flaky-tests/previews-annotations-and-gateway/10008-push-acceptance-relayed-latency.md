# The relayed push acceptance test can exceed its virtual latency budget

- **ID:** 10008
- **Status:** open
- **Observed:** 2026-11-20 on the push-layer review fixes, based on
  `5e9835d0a6981a8d2c217d8941e2e065abbe3008`, after reviewed commit `f255a06da`.
- **Test:** `push acceptance budgets > two relayed nodes share bridge reads across windows and meet the latency budget`
- **File:** `apps/backend/tests/push-acceptance.test.ts`
- **Original command:** `mise run test:logged -- --name findings-backend -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/http-bridge/state-revision.test.ts src/core/push/native-session-push-topic.test.ts src/core/push/review-transcript-push-topic.test.ts src/core/native-agent-tool-output-reads.test.ts src/core/nodes/node-push-subscriptions.test.ts src/core/multi-review-transcript-push.test.ts src/core/multi-review-service-part-4.test.ts tests/push-acceptance.test.ts --parallel=4 --only-failures`.
- **Failure:** observed p95 of 300 ms against the 250 ms virtual-time limit.
  The case ran for 1.66 seconds. The run reported 136 passed and 3 failed
  across eight files. The two other failures were fixture setup mistakes in new
  reviewer count tests. Evidence: `/tmp/orkestrator-test-run.qvEDlP/findings-backend.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name findings-acceptance-only -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts tests/push-acceptance.test.ts --parallel=1`
  passed the owning file in 23.8 seconds.
- **Open question:** the manual clock advances in 25 ms increments while the
  relay reads real SSE sockets outside the fixture's quiescence check. It is
  unclear whether delayed socket delivery or a product scheduling race explains
  the extra virtual ticks. The latency limit and scenario remain unchanged.

## Recurrence on 2026-11-20

- **Observed:** while merging `origin/main` at `0b778d995` into `03261be68`,
  whose merge base was `5e9835d0a6981a8d2c217d8941e2e065abbe3008`.
  The case was branch-local before renumbering, so the recurrence check used
  its old number 10003 against the pre-merge branch and reported it open.
- **Aggregate command:** `mise run test:logged -- --name merge-default-suite -- mise run test`.
  The backend ran with four Bun workers. The case measured virtual p95 of
  275 ms against its 250 ms budget and failed after 1105.76 ms. The backend
  suite reported 19,956 passed, 152 skipped, and two failed across 1,415 files.
  Evidence: `/tmp/orkestrator-test-run.oFfodQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-push-acceptance-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/push-acceptance.test.ts --parallel=1 --only-failures`
  passed the owning file in 11.6 seconds. The relay still reads real SSE
  sockets outside the fixture's quiescence check, and the source of the
  extra virtual tick remains unverified.

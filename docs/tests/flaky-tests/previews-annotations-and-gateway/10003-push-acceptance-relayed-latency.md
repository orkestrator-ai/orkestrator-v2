# The relayed push acceptance test can exceed its virtual latency budget

- **ID:** 10003
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

# ACP dispatch probe already reports the turn completed during a cold load

- **ID:** 0249
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `ACP bridge > does not confirm a request while a cold session load is still preparing it`
- **Owning file:** `bridges/acp-bridge/src/acp-context.test.ts:1331` (assertion at `:1382`)
- **Original command:** `mise run test` on `multi-review-flow-graph-followups`
  (Multi Review flow graph follow-ups; the ACP bridge change only adds a
  permission answer for `report_finding` in `onPermission`, which this test
  does not exercise). Other worktrees were working on the host.
- **Failure:** `GET /session/:id/dispatch?requestId=preparing-1` answered
  `{ dispatch: "dispatched", turn: { state: "completed" } }` where the test
  expected exactly `{ dispatch: "dispatched" }` (946.97 ms): the turn had
  already settled by the time the probe ran.
- **Suite counts:** acp-bridge 555 passed, 3 skipped, 1 failed across 36 files
  (70.26 s); the other bridge packages passed.
- **Isolated owning-file rerun:** `bun test src/acp-context.test.ts` from
  `bridges/acp-bridge` passed (44 pass, 0 fail).
- **Evidence:** `/tmp/orkestrator-test-run.zlamOL/bridges.log.gz`.
- **Hypothesis:** under load the fake agent finishes the prompt before the
  test's dispatch probe, so the answer gains the settled `turn` block; the
  exact-equality assertion is timing-sensitive. Not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Additional observation during coordinator research fixes (2026-10-16)

- **Date observed:** 2026-10-16
- **Test:** `ACP bridge > does not confirm a request while a cold session load is still preparing it`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:1332`
- **Original command:** `mise run test:logged -- --name review-tests -- mise run test`. The aggregate used four workspace worker slots, one root worker, two bridge slots (one worker per package), and one protocol slot.
- **Failure:** At line 1382 the final dispatch response contained `{ dispatch: "dispatched", turn: { state: "completed" } }`, while the assertion expected exactly `{ dispatch: "dispatched" }`. The case took 980.50 ms; the ACP package reported 555 pass, 3 skip, 1 fail, and 2,227 assertions in 72.42 seconds.
- **Isolated rerun:** `mise run test:logged -- --name acp-isolated -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (exit 0, 13.8 seconds).

## Current assessment

The owning file passes alone. The last response is read after prompt acceptance and can already include an authoritative turn outcome when the fixture finishes quickly. Aggregate scheduling appears to change whether completion wins that race. The earlier assertion still observed `unknown` while loading. No assertion, timeout, or production ACP behavior was changed for this observation.

The subsequent `mise run test:logged -- --name final-tests -- mise run test` aggregate passed the complete bridge group (90.1 seconds).

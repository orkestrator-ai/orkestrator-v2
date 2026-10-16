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

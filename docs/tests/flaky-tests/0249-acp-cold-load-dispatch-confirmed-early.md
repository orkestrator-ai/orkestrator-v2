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

## Recurrence — 2026-10-16 (temporary host port merge)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`,
  with workspace/root/bridge/protocol reservations of 4/1/2/1 worker slots;
  component browser validation ran alongside it.
- **Failure:** the final dispatch probe again included `turn: { state: "completed" }`
  at `acp-context.test.ts:1382`, failing the exact-equality assertion after
  1253.75 ms.
- **Suite counts:** ACP reported 578 passed, three skipped and one failed across
  37 files in 99.96 seconds. The other four bridge packages passed.
- **Isolated rerun:** `mise run test:logged -- --name merge-acp-preloaded -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`
  passed unchanged (exit 0, 13.6 seconds).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.CYmzDD/bridges.log.gz`.
- **Assessment:** consistent with the recorded completion/probe race; no
  production behavior, assertion, timeout or skip changed.

## Execution-policy conformance main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64). Workspace/root/bridge/protocol reservations were 4/1/2/1 slots; browser validation ran alongside it.
- **Failure:** The final dispatch probe also returned `turn: { state: "completed" }`, failing exact equality at line 1382 (1497.71 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-acp-context-isolated -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 17.1 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IG0vGk/bridges.log.gz`.
- **Assessment:** the isolated pass confirms intermittence; root cause remains unconfirmed. No assertion, timeout or skip changed.

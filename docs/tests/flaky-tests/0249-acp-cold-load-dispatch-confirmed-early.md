# ACP dispatch probe already reports the turn completed during a cold load

- **ID:** 0249
- **Status:** resolved
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

## Execution-policy conformance main merge recurrence — 2026-10-17 (before this branch's fix)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` (Bun 1.4.3, macOS arm64). Workspace/root/bridge/protocol reservations were 4/1/2/1 slots; browser validation ran alongside it.
- **Failure:** The final dispatch probe also returned `turn: { state: "completed" }`, failing exact equality at line 1382 (1497.71 ms).
- **Owning-file rerun:** `mise run test:logged -- --name merge-acp-context-isolated -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 17.1 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IG0vGk/bridges.log.gz`.
- **Assessment:** the isolated pass confirms intermittence; root cause remains unconfirmed. No assertion, timeout or skip changed.

## Recurrences on GitHub Actions (2026-10-16)

- **Runs:** 38901701138 and 38904039434, `Unit and integration tests` job of
  `lint.yml` (`mise run test`, ubuntu-latest).
- **Failure:** the same `turn: { state: "completed" }` at
  `acp-context.test.ts:1382`, in 1064.93 ms and 1110.55 ms. Run 38904039434
  also failed 0232 in the same ACP package run.

## Root cause

A test race, not a production defect. The prompt used `DIRECT:prepared`, which
the fake agent (`src/testing/fake-agent-prompt-start.ts`) answers with one
message chunk and `stopReason: "end_turn"` immediately. The prompt route
answers `202` once the prompt is handed to the agent, and the completion
handler in `src/acp-http.ts` moves the journal entry to `completed`
independently. `GET /session/:id/dispatch` deliberately reports the turn
outcome once the entry is `completed` or `failed`, so whenever the agent's
reply was processed before the test's follow-up probe, the answer correctly
gained `turn: { state: "completed" }` and the exact-equality assertion failed.

Reproduced before the fix: `bun test src/acp-context.test.ts --preload
../../tests/setup-node.ts -t "cold session load is still preparing"
--rerun-each 30` from `bridges/acp-bridge` failed 1 of 30 on a loaded macOS
host (load average about 27 on 18 cores). Widening the window with a temporary
`Bun.sleep(300)` after the `202` made the unchanged test fail 5 of 5.

## Fix (this branch)

`bridges/acp-bridge/src/acp-context.test.ts`: the bridge is spawned with
`FAKE_ACP_HOLD_TURN_FILE`, and the prompt is `CURSORTASKHELD: prepared`, which
the fake agent keeps open until the test creates the hold file (the same
primitive `acp-prompt.test.ts` uses for `held-1`). The post-acceptance probe
therefore always sees an accepted, unfinished turn and still asserts exactly
`{ dispatch: "dispatched" }`. The test then releases the turn and waits for the
probe to report the outcome, asserting exactly
`{ dispatch: "dispatched", turn: { state: "completed" } }`, which covers the
completed branch the race used to hit by accident. No production code,
timeout, skip or assertion strictness changed.

## Verification

From `bridges/acp-bridge`, on macOS arm64 with other worktrees' suites running
(load average 27-52 on 18 cores):

- `bun test src/acp-context.test.ts --preload ../../tests/setup-node.ts -t "cold session load is still preparing" --rerun-each 50`:
  50 pass, 0 fail (was 1 fail in 30 before the fix).
- The same filter with a temporary `Bun.sleep(300)` after the `202`, five
  reruns: 5 of 5 failed before the fix, 5 of 5 passed after it (the sleep was
  removed again).
- `bun run test:bridge` (package suite, `--parallel=1`) three times in a row
  at load averages 52, 48 and 36: each 579 pass, 3 skip, 0 fail across 37
  files (76.6 s, 72.3 s, 67.9 s).
- `bun run typecheck`: exit 0. `bunx oxfmt` and `bunx oxlint` on the file: clean.

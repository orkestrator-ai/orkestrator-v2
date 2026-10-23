# `ACP bridge > drops malformed persisted tool parts on load` (`bridges/acp-bridge/src/acp-persistence.test.ts:419`)

- **ID:** 0039
- **Status:** open
- **Date observed:** 2026-08-28
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran the workspace,
  root/agent-support, bridges, and protocol-lockfile groups concurrently; the
  bridge group used two Bun workers.
- **Failure:** bridge startup timed out after 15 seconds in
  `acp-test-harness.ts:200` with `Timed out waiting for ACP state: false` while
  the case restarted the bridge at `acp-persistence.test.ts:474` (duration:
  15,004 ms).
- **Suite counts:** bridge group — 3,151 passed, 11 skipped, and 1 failed across
  118 files in 66.64 seconds. The workspace, root/agent-support, and
  protocol-lockfile groups passed.
- **Isolated rerun:** `bun test src/acp-persistence.test.ts` from
  `bridges/acp-bridge` passed all 12 tests with 61 assertions in 1.02 seconds;
  the target passed in 28.94 ms.
- **Hypothesis:** This has the same aggregate-only bridge-startup signature as
  the existing ACP readiness family: the persisted-state assertion did not
  fail, because the replacement bridge never became healthy within the harness
  deadline. A recurrence should capture child startup and shutdown timing before
  changing either the malformed-part expectations or the readiness budget.

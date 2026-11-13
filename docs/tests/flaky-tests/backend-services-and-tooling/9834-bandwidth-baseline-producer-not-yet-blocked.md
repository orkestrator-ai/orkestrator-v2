# Bandwidth baseline's blocked producer still writing 500 ms in, under load (`apps/backend/src/remote-bandwidth-baseline.test.ts`)

- **ID:** 9834
- **Status:** open
- **Date observed:** 2026-11-13
- **Base:** `263eea27df362cf541cb9bde9adf7ec4fec1f5fd`.
- **Observed head:** branch `test-core-count-2ea1f7178998-r1` at `ee178dafc`
  (test wall-time work: test splits, injected test intervals, scheduler CPU
  learning). It does not touch `apps/backend/src/remote-bandwidth-baseline.test.ts`
  or the throttle it exercises.
- **Test:** `raw socket and link > blocked downstream stays bounded and backpressures the producer`
  (`apps/backend/src/remote-bandwidth-baseline.test.ts:435`).
- **Failure:** `expect(produced).toBe(before)` expected 123207680, received
  132857856 (715.29 ms): the producer was still writing 200 ms after a fixed
  500 ms sleep that assumes backpressure has fully engaged by then.
- **Original command:** Multi Review preparation's `mise run test:full`
  (default worker plan, exit 1 after 1369.4 s) on a Linux host shared with
  other worktrees' validation. The same run also failed the WebKit engine
  parts (missing host libraries), `tmux-session.test.ts` (case
  [9933](9933-claude-mcp-parser-untrusted-mise-config.md)) and two cases that
  fail on the target branch's CI.
- **Isolated rerun:** `mise run test:logged -- --name remote-bandwidth-alone -- bun test --cwd apps/backend ./src/remote-bandwidth-baseline.test.ts --parallel=1`
  passed unchanged in 4.4 s.
- **Evidence:** `validation-10.stdout.txt` in that review's validation
  artifacts (`.orkestrator/review-artifacts/review-validation-44c03bff-…`).

## Hypothesis

Not established. The assertion is a fixed sleep followed by a negative check
(nothing more was produced), which only proves backpressure engaged within
500 ms. On a loaded host the throttle's queue and the paused client's socket
buffers may take longer to fill, so the producer is legitimately still
filling them when `before` is read. A fix would wait for the producer to stop
(for example `produced` unchanged across consecutive drain checks, or the
throttle reporting its queue full) before taking `before`, rather than
raising the sleep. No test, assertion, timeout or skip was changed.

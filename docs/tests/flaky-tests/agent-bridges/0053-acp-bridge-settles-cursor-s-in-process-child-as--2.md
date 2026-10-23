# `ACP bridge > settles Cursor's in-process child as failed` (`bridges/acp-bridge/src/index.test.ts`)

- **ID:** 0053
- **Status:** resolved
- **Date observed:** 2026-08-16
- **Original command:** `bun run test`
- **Worker configuration:** bridges group used two workers while the workspace,
  root, and protocol-lockfile groups ran concurrently.
- **Failure:** the second `waitFor` in the case — the one polling `/session/:id`
  for the sub-agent part to reach `agentState: "failed"` — exhausted its own
  5,000 ms deadline (`5095.93 ms`) and threw the bounded diagnostic
  `Timed out waiting for ACP state: {…"status":"idle"…}` from
  `index.test.ts:113`, raised at `index.test.ts:1721`. The snapshot in the
  diagnostic shows the session already idle with the sub-agent part still
  `agentState: "active"`.
- **Suite counts:** bridges group: 2,540 passed, 11 skipped, 1 failed. The root
  and agent-support group failed the same run for two unrelated reasons
  (`test-diagnostic-bounds` and `CreateEnvironmentFlowDialog`), both of which
  reproduce on `main`.
- **Isolated rerun:** `bun test bridges/acp-bridge/src/index.test.ts` → passed in
  31.8 s, and again in 31.9 s after the usage changes in the same commit.
- **Relationship to the resolved entry above:** this is the sibling case of
  `…as finished` in the same `for` loop, and the earlier fix held — Bun's 20 s
  per-test budget was not exceeded and the retry policy produced a useful
  diagnostic instead of an unhandled `ConnectionRefused`. What expired this time
  is `waitFor`'s own 5 s default, so the previous root cause (the health wait
  eating the whole test budget) is not sufficient to explain it.
- **Hypothesis:** contention, not a product regression. The case starts a
  background sub-agent, then a second prompt whose terminal notification must
  land within 5 s; under aggregate load the spawned bridge and its fake agent
  share CPU with three other groups. Nothing in the failing path touches usage
  accounting, which is the only bridge behaviour the commit that observed this
  changed. A recurrence should capture whether the background child had settled
  in the agent (the fake agent's own write ordering) or only the bridge's
  observation of it was late, before raising the wait deadline — a longer
  deadline would hide an ordering bug as easily as it would absorb contention.
- **Recurrence (2026-08-16):** The same aggregate command reproduced the sibling
  `FINISHCURSORTASK` case: 2,558 passed, 11 skipped, and 1 failed in the bridges
  group. The diagnostic snapshot had `revision: 4`, only the initial
  `BACKGROUNDSUBAGENT` turn, `status: "idle"`, and an active child; no second
  user message or terminal frame had been recorded. The owning file passed in
  38.5 s.
- **Root cause:** The test waited for `/activity` to become `working`, but that
  endpoint intentionally reports active background children as working even
  after their parent turn is complete. Under aggregate scheduling the first
  prompt was still running when the test sent the follow-up, so the bridge
  correctly returned `409 Session is already running`; the test ignored that
  response and later misdiagnosed the still-active child as a missed terminal
  notification. The same race affected every sibling case in the loop.
- **Fix:** Wait for the authoritative session snapshot to be `idle` while the
  child part remains `active` before sending each follow-up, and assert that
  every follow-up returns `202`. This preserves the intended cross-turn child
  lifecycle without extending a deadline or weakening the settlement checks.
- **Verification:** `bun run test:logged -- --name acp-index-sync-fixed -- bun test
  ./bridges/acp-bridge/src/index.test.ts` passed the owning file in 38.5 s, and
  the bridge group passed in 38.9 s after the synchronization fix. The final
  `bun run test:logged -- --name full-suite-final -- bun run test` passed all
  four concurrent groups in 99.2 s.

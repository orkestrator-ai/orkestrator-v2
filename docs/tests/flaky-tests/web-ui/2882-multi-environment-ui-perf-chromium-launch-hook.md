# Multi-environment UI perf: Chromium launch hook times out in the aggregate run

- **ID:** 2882
- **Status:** open
- **Date observed:** 2026-11-02
- **Test:** `in-page deadlines > (unnamed)`, the `beforeAll` hook in
  `tests/unit/multi-environment-ui-perf.integration.test.ts` that calls
  `chromium.launch`.
- **Original command:** `mise run test`, on the renderer logger migration branch
  (`353f208b5`), with other worktrees' work on the same host.
- **Failure:** the hook failed at 5004.71 ms, which is Bun's default 5 s test timeout,
  while the group ran in parallel. The root group reported 3423 pass, 4 fail; the other
  3 failures are the deterministic terminal link tests, which also fail on `main`.
- **Isolated rerun:** `bun test tests/unit/multi-environment-ui-perf.integration.test.ts`,
  three times: 6 pass, 0 fail each, in about 4 s.
- **Hypothesis:** launching Chromium takes over 5 s while the aggregate run loads the
  host. Not reproduced under controlled load, and the changes on that branch do not
  touch this file or anything it loads, so this is unproven. If so, an explicit hook
  timeout would be the fix.

## CI recurrence and fix applied, 2026-11-03

GitHub Actions CI ("Unit and integration tests", `ubuntu-latest`, 4 cores) hit
this in four of six runs checked between `d6040915c` and `b0dcf1660` (for
example run 41549578197). There the first case's `browser.newPage()` ran past
Bun's 5 s test timeout (5000.39 ms), and the next two cases then failed at once
with "Target page, context or browser has been closed".

Branch `debug-ci-failures-a629816c8619-r1` gives the
`beforeAll` hook a 60 s budget and opens and closes a warm-up page inside it,
so Chromium's start-up cost is paid there, and gives each case a 30 s budget.
No assertion was changed. The timeout could not be reproduced locally: with
32 busy-loop processes on a 16-core host, both the old and new file passed
3 of 3 runs. Mark this resolved once CI on that change shows the file green.

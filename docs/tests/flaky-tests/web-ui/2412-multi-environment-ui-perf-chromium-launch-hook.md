# Multi-environment UI perf: Chromium launch hook times out in the aggregate run

- **ID:** 2412
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

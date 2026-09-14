# `Electron backend command registry > rejects malformed container status framing and invalid encoded sections` (`tests/unit/electron/commands-registry-terminal.test.ts:1571`)

- **ID:** 0036
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name root-tests -- bun test ./tests --parallel=4 --only-failures`
- **Worker configuration:** four Bun workers over `tests/`, run concurrently with three typechecks and two other Bun test groups on the same host. A separate observation used the root group only, four Bun workers.
- **Failure:** `expect(received).toThrow(expected)` with `Expected substring: "Malformed"`; the received message was `Command failed: docker exec container-1 bash -lc ...`, and the log also recorded `this test timed out after 5000ms` (duration: 5,013.59 ms). A paired observation reported duration 5,002.30 ms with the fake `docker exec` echoing the whole git-status script back as a failure and `killed 1 dangling process`.
- **Suite counts:** 3,726 passed, 1 skipped, 2 failed; 16,602 expect() calls, 238.8 s. A second observation of the same pair recorded 3,726 passed, 1 skipped, 2 failed, 2 errors, 16,592 `expect()` calls; 3,729 tests across 178 files in 359.91 s.
- **Isolated rerun:** `bun test tests/unit/electron/commands-registry-terminal.test.ts` → passed in 23.0 s. A logged rerun `bun run test:logged -- --name rerun-terminal -- bun test tests/unit/electron/commands-registry-terminal.test.ts` → passed in 25.6 s.
- **Follow-up:** A later `--parallel=4` run of the same command on a quieter host passed in 79.2 s without this failure.
- **Recurrence (2026-08-26):** `bun run test` failed this case after the generic
  5,000 ms deadline while `scripts/test-all.ts` ran its four validation groups
  concurrently. The root/agent-support group reported 3,841 passed, 1 skipped,
  1 failed, and 1 trailing error across 3,843 tests; the complete run reported
  15,234 passed and 13 skipped. The expected `"Malformed"` rejection was again
  replaced by a `CommandFailedError` echoing the fake Docker command after the
  fixture crossed the deadline. The isolated rerun
  `bun test tests/unit/electron/commands-registry-terminal.test.ts` passed all 64
  runnable tests with 1 skipped in 18.43 s; the target case completed in
  365.72 ms. The change under validation touched only two DOM absence
  assertions in `tests/unit/components/GlobalSettings.test.tsx`.
- **Hypothesis:** The case drives a real fake-`docker` child process against the generic 5-second outer budget. Under host contention the fake process did not return before the outer timeout, so the timeout message replaced the expected `Malformed` rejection. This matches the 2026-08-16 sweep's command-registry row, which gave sibling cases explicit budgets; this case appears not to have received one. A recurrence should give the case an explicit budget and capture the fixture's process timing rather than loosening the `Malformed` assertion, which is the actual product behaviour under test.
- **Root cause:** The test launches four sequential fake-Docker subprocess
  fixtures but used Bun's generic 5-second per-test deadline. Under aggregate
  process contention, the outer deadline interrupted the test and tore down the
  active shim before the expected malformed-framing rejection completed.
- **Fix:** This change gives the case the existing shared
  `ASYNC_TEST_BUDGET_MS` budget used by neighboring subprocess-backed tests; the
  product assertion and malformed inputs are unchanged.
- **Verification:** The target passed three consecutive focused runs via
  `bun test tests/unit/electron/commands-registry-terminal.test.ts --test-name-pattern
  "rejects malformed container status framing" --rerun-each 3` (737.98 ms,
  349.62 ms, and 362.42 ms). The subsequent `bun run test` passed all four
  groups with 15,235 passed, 13 skipped, and 0 failed; typecheck, build,
  formatting, and lint also passed.

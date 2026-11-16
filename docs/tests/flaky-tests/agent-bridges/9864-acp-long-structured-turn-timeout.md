# ACP long structured turn aggregate timeout

- **ID:** 9864
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `ACP transcript rows > does not fail a long structured turn that spans many responses`
- **File:** `bridges/acp-bridge/src/acp-rows.test.ts`
- **Original command:** `mise run test:logged -- --name review-full-latest -- mise run test`.
- **Worker configuration:** default complete non-iOS suite planning, alongside browser validation on the same host.
- **Failure:** the test exceeded the five-second deadline (reported 5438 ms); the ACP group reported 646 passed, 1 failed, 650 tests across 43 files.
- **Isolated rerun:** the unchanged owning file passed in `review-acp-isolated` (0.4 s), through `test:logged` and a focused Bun invocation with `--parallel`.
- **Evidence:** compressed component logs under the host temporary directory `orkestrator-test-run.RjYXiy`; outer logged artifact `orkestrator-test-run.U7DSRP`.
- **Hypothesis:** scheduling contention in the aggregate exhausted the generic test deadline. The change does not modify the ACP bridge. No implementation, assertion, deadline, or skip was changed.

## Resolution (2026-11-15)

- **Root cause:** Bun's 5 s default test budget. The test is in-process CPU
  work with nothing to await (it feeds `MAX_MESSAGES + 50` responses through
  the row builder); it failed at 5,438 ms in an aggregate and runs in well
  under a second alone.
- **Fix:** none in the file: it sets no budget of its own, and
  `tests/default-test-timeout.ts` (preloaded by `tests/setup-node.ts`) now
  gives every test 60 s.
- **Reproduced:** partly. Under 6 burners on its core with the old
  harness budgets, this test took 68,472 ms and failed at the new 60 s
  default (`repro-acp-before-p1`); in the next identical run it passed
  (`repro-acp-after-p1b`, all 124 tests). Pinning six busy loops to the
  test's core is far harsher than the recorded aggregate (5.4 s), so the 60 s
  default covers the recorded failure but not that synthetic extreme. A
  CPU-only test has no signal to wait on; its budget was not raised further.
- **Stress:** `repro-acp-after-p1b` (see 0015) passed.

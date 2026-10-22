# ACP long structured turn aggregate timeout

- **ID:** 0516
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `ACP transcript rows > does not fail a long structured turn that spans many responses`
- **File:** `bridges/acp-bridge/src/acp-rows.test.ts`
- **Original command:** `mise run test:logged -- --name review-full-latest -- mise run test`.
- **Worker configuration:** default complete non-iOS suite planning, alongside browser validation on the same host.
- **Failure:** the test exceeded the five-second deadline (reported 5438 ms); the ACP group reported 646 passed, 1 failed, 650 tests across 43 files.
- **Isolated rerun:** the unchanged owning file passed in `review-acp-isolated` (0.4 s), through `test:logged` and a focused Bun invocation with `--parallel`.
- **Evidence:** compressed component logs under the host temporary directory `orkestrator-test-run.RjYXiy`; outer logged artifact `orkestrator-test-run.U7DSRP`.
- **Hypothesis:** scheduling contention in the aggregate exhausted the generic test deadline. The change does not modify the ACP bridge. No implementation, assertion, deadline, or skip was changed.

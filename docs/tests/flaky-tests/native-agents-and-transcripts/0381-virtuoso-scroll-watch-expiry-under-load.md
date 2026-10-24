# Virtuoso post-scroll watch expiry under load

- **ID:** 0381
- **Status:** resolved
- **Date observed:** 2026-10-18
- **Test:** `useVirtuosoScrollState > scrollToBottom post-scroll watch window > stops watching scrollHeight after the watch window expires` (`tests/unit/hooks/useVirtuosoScrollState.test.ts:2266`).
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix.
- **Workers:** aggregate workspace/root/bridges/protocol groups used 4/1/2/1 slots alongside browser suites and other worktrees.
- **Failure:** expected one scroll call, received two after the watch window; duration 602.98 ms. Root group reported 3053 passed, 1 skipped and 2 failed across 3056 tests in 966.29 seconds. The other failure was the missing README installer example, subsequently restored and verified separately.
- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-scroll-owner -- bun test ./tests/unit/hooks/useVirtuosoScrollState.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 3.3 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Assessment:** intermittent timing observation. Host contention is a hypothesis; no scroll implementation, timeout, assertion or skip changed.

## Image-preview layout validation recurrence — 2026-10-21

- `mise run test:logged -- --name root-tests -- mise run test` repeated the
  watch-window assertion (expected one call, received two; 584.16 ms). The
  root/support group used one worker and reported 3171 passed, one skipped and
  two failed across 3174 tests in 330.47 seconds; Pi runtime vendoring was the
  other failure. The aggregate also reported 12 backend failures outside the
  image-preview change, which are not classified as flakes by this observation.
- The unchanged owning file passed alone:
  `mise run test:logged -- --name virtuoso-owner -- bun test ./tests/unit/hooks/useVirtuosoScrollState.test.ts --parallel=1 --only-failures`
  (exit 0, 2.4 seconds).
- Evidence: the host temporary directory
  `orkestrator-test-run.awrt02/root-and-agent-support-tests.log.gz`, with outer
  summary in `orkestrator-test-run.T8dkv2/root-tests.log.gz`.
- Host contention remains a hypothesis. No scroll code, assertions, deadlines
  or skips changed.

## Resolution — 2026-10-24

- **Root cause:** the post-scroll watch window was a fixed 400 ms
  `requestAnimationFrame` loop started by every `scrollToBottom`; under load
  its expiry raced the test's growth step, so a second re-issued scroll could
  land inside or outside the window depending on scheduling.
- **Fix:** the mechanism is gone. `scrollToBottom` is now one bounded journey
  of the transcript scroll controller that converges on measured geometry and
  ends at a frame/time budget; following then pins growth directly
  (`docs/architecture/transcript-scroll.md`). The watch-window tests were
  replaced by `scrollToBottom > pins the journey into the footer from measured
  geometry, within its budget` and `scrollToBottom after the journey >
  following pins later growth directly instead of re-issuing smooth scrolls`,
  which drive the end deterministically instead of racing wall time.
- **Verification:** `bun test ./tests/unit/hooks/useVirtuosoScrollState.test.ts
  --parallel=1` passes (88 tests), and the suite runs inside the aggregate
  `mise run test` recorded with this change.

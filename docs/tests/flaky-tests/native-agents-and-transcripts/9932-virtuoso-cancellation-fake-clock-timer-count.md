# Virtuoso cancellation: fake-clock timer count after the deadline window

- **ID:** 9932
- **Status:** resolved
- **Date observed:** 2026-11-10
- **File:** `apps/web/src/lib/transcript-scroll/virtuoso-cancellation.test.tsx:95`

## Observation

Observed 2026-11-10 on `speed-up-tests-13519821d63c-r1`, based on
`2aad83a37696d93b6df47420faecf647cf916c8e`, in the review-preparation run of
the default suite (`mise run test`; the web package used its default worker
count). The cases were introduced by this branch's commit `f2787ec8e`, which
moved them onto Bun's fake clock.

Three cases failed with `expect(jest.getTimerCount()).toBe(0)`, Expected 0,
Received 1, at line 95 (`elapsePastEveryDeadline`), called from lines 328 and
423:

- `patched Virtuoso navigation cancellation > restored snapshot transitions from hidden to visible (cancel=%s)`
- `patched Virtuoso navigation cancellation > controller %s reveals a snapshot whose initial navigation is still pending`

The aggregate runner's automatic rerun reported `PASSED ALONE (1.2s): likely
a load flake` for the owning file. Suite counts for that run were not
preserved in the review evidence.

## Isolated rerun

The unchanged owning file passed alone in the aggregate runner's rerun
(1.2 s). Before the fix, 16 concurrent copies of the unchanged file
(`git show HEAD:<file>` copied beside it, 16 parallel `bun test` processes)
also passed, so the failure was not reproduced locally.

## Resolution (2026-11-10)

- **Root cause:** the helper asserted a global zero timer count straight
  after a fixed amount of fake time. `elapseFakeTime` interleaves Happy DOM
  animation frames, which run on real immediates outside the fake clock, with
  fake-timer advances and ends with one more real frame. Under load,
  frame-driven Virtuoso work can arm another fake timer after the last advance
  and before the count is read, so the count is 1 although nothing is late.
  This is an evidence-backed hypothesis; it was not reproduced.
- **Fix:** `elapsePastEveryDeadline` in the owning file now grants up to three
  further windows of the same length, advancing the fake clock again only
  while a timer is still pending, and then asserts the global count is zero.
  A timer that keeps re-arming itself still fails the assertion, and every
  caller's no-further-write and visibility assertions still see any write a
  late timer makes.
- **Reproduced:** no — the failure did not occur locally before the fix, even
  with 16 concurrent runs of the unchanged file; the fix is supported only by
  stress runs, which is weaker evidence.
- **Stress:** `mise run test:logged -- --name stress-virtuoso-cancel -- bun scripts/test-under-contention.ts -- bun --cwd=apps/web test src/lib/transcript-scroll/virtuoso-cancellation.test.tsx --parallel=1 --rerun-each=20`
  passed (280 of 280 tests, 6 unpinned burners on macOS), and 12 concurrent
  runs of the fixed file passed 14 of 14 each.

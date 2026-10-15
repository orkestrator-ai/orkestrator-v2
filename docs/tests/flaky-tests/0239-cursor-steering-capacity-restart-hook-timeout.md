# Cursor steering-at-capacity restart case hits a hook timeout

- **ID:** 0239
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `steering at capacity across a restart > a lost refusal and a
  recovered run never produce a duplicate or a fabricated absent`
- **File:** `bridges/cursor-bridge/src/conformance-interactions.test.ts:115`
- **Original command:** `mise run test` in the `Unit and integration tests` job
  of `lint.yml` on `ubuntu-latest` (four vCPUs), run 38719540712 at `1369ea7b`
  on `main`.
- **Worker configuration:** bridges group two slots, one Bun worker per bridge
  task, running alongside the root group (one worker) and the workspace group
  (one package task with one worker).
- **Failure:** `a beforeEach/afterEach hook timed out for this test` at
  10,007.06 ms. The bridge had just logged `state file at its size limit; saved
  1 session(s) with a shortened transcript copy`.
- **Suite counts:** Cursor 716 pass, 4 skip, 1 fail of 721 tests across 39
  files (39.31 s). Turbo then stopped the other bridge tasks.
- **Isolated rerun (macOS arm64):** `mise run test:logged -- --name
  rerun-cursor-conformance-interactions -- bun --cwd=bridges/cursor-bridge test
  src/conformance-interactions.test.ts --preload ../../tests/setup-node.ts
  --parallel=1 --only-failures` passed all 4 tests, wrapper duration 0.7 s.
- **Hypothesis:** none yet. Other Cursor hook timeouts under aggregate load are
  0182 and 0216. It has not recurred in the other 14 completed `main` runs on
  2026-10-14 and 2026-10-15. No test or production code was changed.

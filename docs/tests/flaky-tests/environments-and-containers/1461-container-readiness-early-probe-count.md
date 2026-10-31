# Early-return boot probe count under aggregate load

- **ID:** 1461
- **Status:** open
- **Date observed:** 2026-10-31 (review preparation and isolated confirmation)
- **File:** `apps/backend/tests/container-readiness.test.ts`
- **Test:** `bounded in-container boot wait > a probe that comes back early without a final state is spaced, not repeated at once`
- **Original command:** `cd '.' && mise run test`.
- **Worker configuration:** backend output reports `bun test` with four parallel workers.
- **Failure:** `expect(execs).toBeGreaterThanOrEqual(2)` received `1`, duration
  579.48 ms. The fixture uses a 450 ms deadline and 100 ms polling interval.
- **Suite counts:** backend 11,696 passed, 103 skipped, 2 failed across 803
  files (11,801 tests). The other failure was the missing pinned Codex parser
  prerequisite, fixed by making that optional probe skip without the binary.
- **Isolated rerun:**
  `mise run test:logged -- --name review-previous-readiness-failure -- sh -c 'cd apps/backend && bun test ./tests/container-readiness.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures'`
  passed unchanged, exit 0, in 6.9 seconds. The logged runner deletes passing
  output, so the owner test counts were not retained.
- **Evidence:**
  `.orkestrator/review-artifacts/review-validation-6e09221e-792f-4d79-ad92-16d27db696e8/validation-01.stdout.txt`.
- **Hypothesis:** subprocess scheduling can consume the short polling deadline
  before the second probe starts. The unchanged owner's passing rerun supports
  timing sensitivity; no production readiness behavior or assertions were changed.

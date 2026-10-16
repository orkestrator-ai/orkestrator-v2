# Design service, design history and annotation bench: aggregate-load failures (`apps/backend`)

- **ID:** 0225
- **Status:** open
- **Date observed:** 2026-10-15
- **Tests and files:**
  - `design service (legacy adapters over prepare/execute) > missed events, expired replay and generation changes reset through changes()`
    (`apps/backend/src/core/design-service.test.ts`): failed at 7,968.31 ms.
  - `design history: per-actor undo/redo, checkpoints and budgets > the per-canvas entry budget prunes the oldest entries and their checkpoint files`
    (`apps/backend/src/core/design-history.test.ts`): failed at 5,058.19 ms, past
    Bun's five-second default.
  - `large collections > creation cost stays flat as the collection grows (no whole-history rewrite)`
    (`apps/backend/src/core/web-annotation-payloads.bench.test.ts:448`):
    `expect(batchMs[2]!).toBeLessThan(Math.max(batchMs[0]! * 4, 2_000))`
    received 2,171.66 against a 2,000 bound.
- **Original command:** `mise run test:logged -- --name full-suite-2 -- mise run test`
  on the default PATH, with the standard group slots. Other workers' suites
  were running on the same host; the backend package took 318 s here against
  237 s in a run earlier the same day.
- **Suite counts:** backend 7,703 passed, 39 skipped, 3 failed (7,745 tests,
  423 files). The root group's one failure was a contract violation in a new
  test, fixed in the same change; bridges and protocol passed.
- **Isolated reruns:** `bun test --preload ../../tests/setup-node.ts ./<file> --parallel=1`
  from `apps/backend`: `design-service.test.ts` 10 passed (3.52 s),
  `web-annotation-payloads.bench.test.ts` 6 passed (0.59 s),
  `design-history.test.ts` 13 passed (1.07 s).
- **Evidence:** `/tmp/orkestrator-test-run.UxUv6S/` and `/tmp/orkestrator-test-run.vdLl4e/`.
- **Hypothesis:** host contention. Two of the cases exceeded their timeout and
  the third is a wall-clock benchmark. All three run SQLite-backed design or
  annotation storage introduced by #969. Not confirmed.

## Design parts resolved (2026-10-16)

The two design timeouts are fixed; the annotation bench stays open here, owned
by [web-annotation-qualification.md](../../todo/web-annotation-qualification.md).

- The design service replay case is [0218](0218-design-service-replay-aggregate-timeout.md),
  resolved by reaching the change-log bound in 12 commits instead of 260.
- The history entry-budget case made 55 sequential fsynced edits (about
  0.36 s alone). It now lowers `historyEntriesPerCanvas` to
  `PROTECTED_HISTORY_ENTRIES + 3` with `withDesignLimit` and makes 11 edits.
  A new in-memory case ("the shipped entry budget keeps exactly the newest
  entries") checks the shipped 50-entry bound through `appendEntry`. Neither
  case is an ordering bug, and no deadline was raised.

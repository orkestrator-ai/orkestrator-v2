# `ActionBar workflow tabs > allows ordinary review clicks after long-press suppression expires` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **ID:** 0090
- **Status:** resolved
- **Date observed:** 2026-08-10
- **Original command:** `bun run test` (workspace web group: `bun test src --parallel=2`); reproduced with `TURBO_FORCE=true ORKESTRATOR_TEST_WORKERS=2 turbo run test:workspace --cwd . --filter=@orkestrator/web --filter=@orkestrator/backend --filter=@orkestrator/web-public --filter=@orkestrator/protocol --concurrency=2 --cache-dir .turbo`
- **Worker configuration:** Two Bun workers per workspace package with Turbo workspace concurrency 2; the original run also overlapped the root, bridge, and protocol-lockfile groups.
- **Failure:** The synchronous dialog lookup failed after the test's 575 ms sleep because the 550 ms long-press callback had not committed its React update yet; failed duration 597.82 ms in the reproduced workspace run.
- **Suite counts:** Web package: 5,448 total, 5,446 passed, 1 skipped, 1 failed with 18,311 assertions.
- **Isolated rerun:** `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx` -> 147 passed, 0 failed with 542 assertions in 12.24 s; the target passed in 1,617.34 ms.
- **Root cause:** The test assumed that sleeping 25 ms past the long-press timer guaranteed both the timer callback and its React state update had completed. Under aggregate scheduling load, the sleep resolved before the dialog update was observable.
- **Fix:** Retain the real long-press gesture and timing, then use a bounded Testing Library wait for the dialog before measuring the one-second click-suppression window.
- **Verification:** `bun test --cwd apps/web src/components/layout/ActionBar.test.tsx --test-name-pattern 'allows ordinary review clicks after long-press suppression expires' --rerun-each 20` -> 20 passed, 0 failed; the exact test completed in 1,613.89-1,660.81 ms. The final `bun run test` aggregate on 2026-08-10 passed every workspace, root, bridge, protocol-lockfile, and iOS group.

# Linear board drag stalls before reaching the scroll target

- **ID:** 9991
- **Status:** open
- **Date observed:** 2026-11-18
- **Base:** `259e88d90c9cb3e6e24de95d8333dbc5a12cbef2` (merge base with `origin/main`)
- **Observed head:** `2d70c4fe0c3cce73985dae21fcbbf448773c660b`, with the new drag shadow test in the worktree.
- **Test:** `scrolling during drag keeps the pointer's before placement` in `e2e/LinearBoardDrag.spec.ts`, on both Chromium viewport projects.

## Symptom

The initial edge-scroll assertion timed out after 30 seconds waiting for
`scrollTop > 200`. It received 76 on mobile and 170 on desktop. Both failures
occurred before the test selected a drop target. The sibling after-placement
cases and the new shadow test passed on both viewports.

## Runs

Initial run, one worker and no retries in a private loopback network namespace:
4 passed, 2 failed in 95.6 seconds.

```sh
ORKESTRATOR_REVIEW_VALIDATION=1 env -u NODE_ENV mise run test:logged -- --name linear-drag-browser -- \
  bun scripts/loopback-network.ts --free-port ORKESTRATOR_E2E_PORT -- \
  bunx playwright test --config e2e/playwright.config.ts e2e/LinearBoardDrag.spec.ts \
  --workers=1 --retries=0 --output=output/playwright/linear-drag-review
```

An isolated rerun of the same file with the same worker, retry and network
settings passed all six cases in 35.8 seconds. It used log label
`linear-drag-browser-rerun` and output directory `output/playwright/linear-drag-review-rerun`.

## Hypothesis

The observed scroll offsets show that edge scrolling started, then stopped
before reaching the test's threshold. The cause of the stall is unconfirmed.

# Antigravity branch validation: component-browser failures not caused by the branch

- **ID:** 10016
- **Status:** open
- **Date observed:** 2026-11-23
- **Branch:** `implement-antigravity-9e7cf43c6d05-r1`, head `ba2775723`
  plus the test fixes committed with this case.
- **Base:** `307d193174299a7464d948bb4c49a8d975fd0f2b` (merge base with
  `origin/main`).
- **Host:** beelink2, Linux 7.2.15, 16 logical CPUs, Playwright 1.65.0
  Chromium, five workers.

## Original failures

Two `mise run test:browser` runs on the branch each failed cases whose
owning files the branch does not touch and which passed when rerun alone.

- `e2e/NativeChatShellDockNotice.spec.ts:119` "refresh moves between the
  pinned notice and footer as the reader returns to latest" (mobile):
  `session-refresh-shimmer-pinned` was not found for 30 s after the
  upward wheel at line 155. This run was stopped by SIGTERM at test
  699 of 2,174, after three failures.
- `e2e/CompactRepositoryPopover.spec.ts:86` "closing restores focus and
  makes the exiting rows inert" (desktop): `compact-repository-popover` was
  not found for 30 s while waiting for `data-state="closed"` at line 102.
  This run completed: 2,005 passed, 165 skipped, four failed in 26.2 min.

The other failures in those runs had other owners:

- `CoordinatorActivity.spec.ts:360` (bar) and `HoverWashes.spec.ts:71`:
  deterministic failures, also on `origin/main`, fixed in this change.
- `LinearBoardDrag.spec.ts:25`: recorded as a recurrence of
  [9991](../web-ui/9991-linear-board-drag-edge-scroll.md).
- `ToolGroupFold.spec.ts:127`: recorded as a recurrence of
  [1012](../web-ui/1012-live-tool-fold-threshold-gap.md).

## Isolated reruns

```sh
env -u NODE_ENV mise run test:logged -- --name browser-three-specs -- \
  bun scripts/loopback-network.ts --free-port ORKESTRATOR_E2E_PORT -- \
  bunx playwright test --config e2e/playwright.config.ts \
  e2e/CoordinatorActivity.spec.ts e2e/LinearBoardDrag.spec.ts \
  e2e/NativeChatShellDockNotice.spec.ts --repeat-each=3
```

Every `NativeChatShellDockNotice` case passed all three repeats on both
projects, and passed twice more in a later two-repeat run.

```sh
env -u NODE_ENV mise run test:logged -- --name browser-four -- \
  bun scripts/loopback-network.ts --free-port ORKESTRATOR_E2E_PORT -- \
  bunx playwright test --config e2e/playwright.config.ts \
  e2e/HoverWashes.spec.ts e2e/CompactRepositoryPopover.spec.ts \
  e2e/ToolGroupFold.spec.ts --repeat-each=2
```

Every `CompactRepositoryPopover` case passed both repeats on both projects.

## Hypothesis

Both are waits for an element that never appeared under a five-worker
suite. The cause is unconfirmed. Neither owner nor its fixture is changed
by the branch.

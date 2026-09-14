# Final validation

- **ID:** 0112
- **Status:** open
The `bun run test` verification runs recorded for the fixes above:

- 2026-08-12 (after resolving every entry that was still open) used
  `TURBO_FORCE=true bun run test` so Turbo could not satisfy any group from
  cache. The workspace group passed in 137.0 seconds, and the root, bridge,
  protocol-lockfile, and iOS groups also passed; iOS executed 40 tests with 0
  failures. The affected web and backend package typechecks passed separately.
- 2026-08-06 (after the `startWorktreeWatcher`, `at-most-once dispatch`, and second `InitializationLogs` fixes) exited 0:
  - workspace: passed in 168.6 seconds — web 5,337 passed / 1 skipped / 0 failed; backend 1,341 passed / 0 failed; web-public 26 passed / 0 failed; protocol 442 passed / 0 failed
  - root: 3,687 passed, 1 skipped, 0 failed across 142 files
  - bridges: 2,216 passed, 11 skipped, 0 failed across 64 files
  - Codex protocol lockfile: passed
  - iOS: 40 passed, 0 failed
  - None of the normal-suite flakes recurred, and the stress-only Codex readiness observation also did not recur in the normal web aggregate.
- The same run confirmed `bun run build:all` completed all 7 package builds, and web, desktop, backend, and Codex bridge typechecking all succeeded.

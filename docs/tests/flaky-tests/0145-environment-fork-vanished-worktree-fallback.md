# Vanished worktree fallback rejects in the aggregate suite

- **ID:** 0145
- **Status:** open
- **Date observed:** 2026-09-17
- **Test:** `fork_environment > falls back to the project checkout when a local
  worktree has vanished`
- **File:** `tests/unit/electron/commands-environment-fork.test.ts:661`
- **Original command:** `mise run test`
- **Worker configuration:** the repository runner's root and agent-support group,
  running concurrently with the workspace, bridges, and Codex protocol groups
- **Failure:** the `expect(...).resolves.toEqual(...)` assertion received a
  rejected promise and Bun reported it as an unhandled error between tests
  (the individual rejection reason was not retained; group duration: 111.0 s)
- **Suite counts:** 4,274 total, 4,271 passed, 2 skipped, 1 failed, 1 error
- **Isolated rerun:**
  `mise exec -- bun test tests/unit/electron/commands-environment-fork.test.ts`
  → 24 passed, 0 failed in 2.77 s
- **Hypothesis:** the failure is aggregate-only shared-state or teardown
  interference. The test uses the shared Electron command fixture's temporary
  Git repositories and globally imported command dependencies; its isolated
  rerun recreates the same repositories and fallback path successfully. The
  platform-version and provider-adapter changes do not touch this test or the
  environment-fork implementation, and the captured aggregate output did not
  retain enough of the rejection to identify which shared dependency changed.

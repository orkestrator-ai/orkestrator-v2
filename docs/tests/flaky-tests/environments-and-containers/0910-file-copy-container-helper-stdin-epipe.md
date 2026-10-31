# Container file-copy helper test fails on EPIPE in the aggregate

- **ID:** 0910
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `external workspace file copies > the container helper requires an existing directory and preserves collisions`
- **File:** `apps/backend/src/core/commands-file-copy.test.ts:144`
- **Original command:** `mise run test` on branch `todo-0014-cli-qualification-060fd6539163` (based on `00a0cb82`), macOS, shared host at load average 50 to 64.
- **Failure:** `error: EPIPE: broken pipe, write`, thrown from a stream `emitError` with no listener, after 78.72 ms. It was the only failure in the backend's 11,523 tests (11,433 passed, 89 skipped, 854.5 s); the other workspace packages, root and agent-support tests, bridges and the protocol lockfile group passed. The complete suite exited 1.
- **Isolated rerun:** `bun test src/core/commands-file-copy.test.ts` in `apps/backend`, three times: 6 of 6 passed each time.
- **Evidence:** `orkestrator-test-run.6DsaMR` below the host temporary directory (`summary.json` and the workspace group log).
- **Hypothesis:** the test spawns the helper and writes the base64 contents to its stdin. When the case under test makes the helper refuse (the missing directory), the helper can exit before that write lands, and the write to the closed pipe emits `EPIPE` on `child.stdin`, which has no `error` listener. Under load the ordering flips more often. Not confirmed; the branch does not touch file copies. A likely fix is an `error` listener on `child.stdin` in the test, asserting on the helper's exit status and stderr instead.

- **Recurrence (2026-10-31, MCP management review fixes):** On Linux, the corrected `mise run test` rerun on branch `todo-0039-mcp-management-d5f657bb2ee5` repeated the same unhandled stdin `EPIPE` at 54.85 ms. It was the only workspace test failure; root and agent-support tests, bridges, and the Codex protocol lockfile group passed. The prior missing pinned Codex test prerequisite had been repaired with an ignored `binaries/codex` symlink to the mise-installed 0.166.0 binary. Evidence: `/tmp/orkestrator-test-run.ZLU4d2/summary.json` and its compressed workspace log. `mise run test:logged -- --name file-copy-isolation -- bun test --cwd apps/backend ./src/core/commands-file-copy.test.ts --parallel=1 --only-failures` passed the complete unchanged owner in 0.5 s. No file-copy code or test was changed.

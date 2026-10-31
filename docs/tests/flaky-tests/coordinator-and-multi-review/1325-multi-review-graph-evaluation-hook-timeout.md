# Multi Review graph evaluation hook exceeds 5 s under aggregate load

- **ID:** 1325
- **Status:** open
- **Test:** an unnamed test whose `beforeEach`/`afterEach` hook timed out
- **File:** `apps/backend/src/core/multi-review-graph-evaluation.test.ts`

On 2026-10-31, `mise run test` on the Settings layout branch (renderer-only
change; nothing under `apps/backend` changed) reported `(fail) (unnamed)
[5000.55ms]` with `a beforeEach/afterEach hook timed out for this test` and
`killed 1 dangling process`. Backend totals were 11,630 passed and this one
failure; every other package passed. The host was shared with other worktrees'
test runs, which held the scheduler's exclusive resource for most of the wait.

The complete unchanged owner passed alone (exit 0, 2.5 s logged):

```sh
mise run test:logged -- --name multi-review-graph-eval-owner -- bun test --cwd apps/backend ./src/core/multi-review-graph-evaluation.test.ts --parallel=1 --only-failures
```

The same unnamed 5 s timeout was seen earlier, as one row of the aggregate
[1322](../aggregate-validation-runs/1322-git-fsmonitor-follow-ups-review-validation.md).
Load on the hook is a likely explanation, not a confirmed cause. No
implementation, assertion, timeout or skip changed.

Aggregate evidence:
`orkestrator-test-run.3gLWVy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the host temporary directory.

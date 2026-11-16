# Multi Review graph evaluation hook exceeds 5 s under aggregate load

- **ID:** 1325
- **Status:** resolved
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

## Usage-limit review recurrence — 2026-11-05

`mise run test:logged -- --name address-default-rerun -- mise run test`
repeated `The unnamed beforeEach/afterEach hook` at 5001.72 ms against the 5000 ms deadline.
The workspace group reserved six slots (backend up to four workers, web two)
beside the one-worker root and two-worker bridge groups on the shared Linux
host. The aggregate queued for about 740 s. The package reported 15256 passed, 132 skipped and one failed across 1027 backend files (601.71 s).

The unchanged owning file passed alone in 8.8 s (exit zero):

```sh
mise run test:logged -- --name address-graph-evaluation-rerun -- bun test --cwd apps/backend ./src/core/multi-review-graph-evaluation.test.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.NrGGXS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. Passing owner output was removed by the logged runner.
This confirms another aggregate-only occurrence; scheduling pressure remains a
hypothesis, not a proven cause. No assertion, timeout or skip was changed.

## Desktop relay address-stage recurrence — 2026-11-05

`mise run test:logged -- --name review-default-tests -- mise run test`
repeated the unnamed hook timeout at 5000.30 ms. A concurrent pending input
verification then reported `GraphAgentPromptError: Input package could not be
verified (missing): Graph artifact is missing` from the same owning file.
Backend totals: 16,123 passed and one failed. The workspace reserved six
worker slots after waiting 914 s beside the root and bridge groups.
Evidence: `/tmp/orkestrator-test-run.l79QN0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The complete unchanged owner passed alone, exit zero in 3.7 s:
`NODE_ENV=test mise run test:logged -- --name fix-multi-review-owner -- bun test --cwd apps/backend ./src/core/multi-review-graph-evaluation.test.ts --parallel=1 --only-failures`.
This establishes a recurrence, not its cause. No timeout or assertion was
changed, and the aggregate remains failed.

## Resolution (2026-11-15)

- **Class:** default test budget (A). `src/core/multi-review-graph-evaluation.test.ts` sets no budget of its own: no `setDefaultTimeout`, no third-argument or hook timeout, and no wall-clock wait deadline in the test or the helpers it uses. The timed-out hook is one of its two `beforeAll` fixtures (a real `git init`, SQLite storage and the corpus runs); the later `Graph artifact is missing` error in one recurrence is the cascade of tests running against a fixture whose hook was cut off.
- **Root cause:** the recorded failure was Bun's former 5 s default per-test/hook budget expiring while the host was loaded; the owner passes alone in a few seconds and nothing it asserts depends on elapsed time.
- **Fix:** none in this file. It now runs under `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets the default per-test and hook budget to 60 s as a hang watchdog.
- **Reproduced:** no. Under contention with the old budget forced (`mise run test:logged -- --name a1325 -- bun scripts/test-under-contention.ts --core <n> --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-graph-evaluation.test.ts --timeout=5000`) the owner passed (14.9 s), so six burners on one core did not recreate the aggregate's load.
- **Stress:** the same contention command with `--rerun-each=3` at the new default passed (31.1 s).

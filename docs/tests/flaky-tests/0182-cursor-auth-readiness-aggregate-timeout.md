# Cursor authenticated readiness times out in the aggregate

- **ID:** 0182
- **Status:** open

Observed: 2026-10-06 on macOS with Bun 1.4.2.

- Test: `authentication > reports an authenticated credential as ready`
- File: `bridges/cursor-bridge/src/http.test.ts:133`
- Failure: `this test timed out after 5000ms`, reported duration 5327.42 ms.
- Cursor package counts: 667 passed, 1 failed across 38 files.

The original command was:

```bash
PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" \
  mise run test:logged -- --name full-suite -- mise run test
```

The aggregate ran workspace, root, bridges and protocol groups concurrently,
with 2, 3, 2 and 1 worker slots respectively. Each bridge package used one Bun
worker, with two bridge package tasks active at once. The bridge group failed
in 62.5 seconds. The workspace and protocol groups passed.

The owning file then passed alone, exit status 0, in 2.1 seconds:

```bash
mise run test:logged -- --name cursor-auth-isolated -- \
  bun test ./bridges/cursor-bridge/src/http.test.ts \
  --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.WqBC12/bridges.log.gz` (aggregate) and the
logged `PASS cursor-auth-isolated` result. The passing log was removed by the
logged runner, as designed.

The test exercises a loopback HTTP session-status request with a test API key.
No assertion mismatch was reported. Aggregate scheduling or loopback delay is
possible, but not established; the isolated result alone does not identify the
cause. No timeout, assertion or skip was changed.

## Recurrence on 2026-10-07

On macOS with Bun 1.4.2, `mise run test:logged -- --name fix-suite-final --
mise run test` (using the GNU-tool PATH above) reported the same readiness test
as a beforeEach/afterEach hook timeout at 10004.37 ms. The following
`authentication > an attached agent is ready without reading credentials` also
failed at 2777.45 ms with undefined session state; an unhandled error was
reported between tests. Cursor counts were 666 passed, 2 failed and 1 error
across 38 files. Group worker allocations remained 2/3/2/1.

The owning file passed alone in 1.9 seconds, exit 0:

```bash
mise run test:logged -- --name cursor-http-alone -- \
  bun test ./bridges/cursor-bridge/src/http.test.ts \
  --preload ./tests/setup-node.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.8uQSSt/bridges.log.gz` and
`/tmp/orkestrator-test-run.8uQSSt/summary.json`. The readiness setup timeout
preceded both undefined-state errors, suggesting a cascading fixture failure;
the underlying timeout cause remains unproven. Assertions and timeouts were
left unchanged.

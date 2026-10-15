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

## Recurrence on 2026-10-12

The environment-move fix validation reproduced `authentication > reports an authenticated credential as ready` under
`mise run test:logged -- --name move-full-suite -- mise run test`, with the GNU
tool PATH documented in the testing guide. Group allocations were 2/3/2/1.
Cursor package: 667 passed, 1 failed and 1 error across 38 files; failure duration 5596.47 ms.

The owning file passed alone, exit 0, in 3.8 seconds:

```bash
mise run test:logged -- --name isolate-cursor-http -- bun test --cwd bridges/cursor-bridge ./src/http.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.tUZZDC/summary.json`
and its compressed group logs. Status remains open; the isolated pass confirms
recurrence but does not establish a root cause. No assertion, timeout or skip
was changed.

## Recurrence on 2026-10-15 during MCP removal validation

On macOS with Bun 1.4.3, the unchanged `src/http.test.ts` reported two
beforeEach/afterEach hook timeouts under:

```bash
mise run test:logged -- --name full-tests -- mise run test
```

- `authentication > reports an authenticated credential as ready`: 10004.15 ms.
- `authentication > an attached agent is ready without reading credentials`: 7364.10 ms.
- Cursor package: 719 passed, 2 failed, 6564 assertions across 39 files in 28.80 s.
- Group allocations: workspace 4 slots, root 1, bridges 2, protocol 1. The
  bridge packages each used one Bun worker. Turbo stopped sibling bridge
  tasks when Cursor failed, so those tasks do not provide completed evidence.

The owning file passed unchanged alone, exit 0, in 1.3 s:

```bash
mise run test:logged -- --name cursor-http-isolated -- \
  bun test --cwd bridges/cursor-bridge ./src/http.test.ts \
  --preload ../../tests/setup-node.ts --parallel=1
```

Evidence: `/private/tmp/orkestrator-test-run.sYaNWH/bridges.log.gz` and
`summary.json` from the aggregate, plus the logged isolated PASS. The passing
log is removed by the runner. The recurrence is consistent with the prior
HTTP fixture cleanup/setup timeouts under aggregate load; its root cause
remains unproven. No assertion, timeout or skip was changed.

The warm full-suite rerun (`full-tests-warm`) subsequently passed every bridge
package: Cursor 721 passed, 0 failed, and all five bridge tasks completed in
77.4 s. The run's only failure was the unrelated agent-account directory
assertion tracked in case 0238. Evidence:
`/private/tmp/orkestrator-test-run.HeXNK8/bridges.log.gz` and `summary.json`.

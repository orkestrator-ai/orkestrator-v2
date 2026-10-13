# Project-home branch switching encounters an index lock in the aggregate

- **ID:** 0183
- **Status:** open

Observed: 2026-10-07 on macOS with Bun 1.4.2.

- Test: `toolbar and external switches clear home PR identity before selection, refresh and merge`
- File: `apps/backend/src/core/commands-registry-project-home.test.ts:242`
- Failure: Git could not create the fixture checkout's `.git/index.lock`
  because it already existed; reported duration 167.69 ms.
- Backend counts: 5761 passed, 1 failed, 15 skipped across 322 files.

Original command:

```bash
PATH="/opt/homebrew/opt/bash/bin:/opt/homebrew/opt/coreutils/libexec/gnubin:/opt/homebrew/opt/findutils/libexec/gnubin:/opt/homebrew/opt/gnu-tar/libexec/gnubin:/opt/homebrew/opt/grep/libexec/gnubin:/opt/homebrew/opt/gnu-sed/libexec/gnubin:/opt/homebrew/bin:$PATH" \
  mise run test:logged -- --name fix-suite-final -- mise run test
```

Workspace/root/bridges/protocol groups ran concurrently with 2/3/2/1 worker
slots. Two workspace package tasks ran concurrently, each with one Bun worker.
The workspace group failed after 350.2 seconds. Its web package passed all 8130
executed tests; root/support and protocol groups also passed. Cursor's separate
failure is tracked in case 0182.

The owning file passed alone, exit 0, in 2.4 seconds with the same GNU-tool PATH:

```bash
mise run test:logged -- --name project-home-alone -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/commands-registry-project-home.test.ts --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.8uQSSt/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `/tmp/orkestrator-test-run.8uQSSt/summary.json`. Passing logs were removed by
the logged runner as designed.

The existing Git lock suggests an overlapping Git operation or a stale lock
inside the test fixture. The isolated pass establishes intermittent behavior,
but the available evidence does not identify the lock owner. No test assertion,
timeout or skip was changed.

## Recurrence on 2026-10-08

During capped file-tree validation, `mise run test:logged -- --name full-suite -- mise run test`
failed this same assertion in 121.94 ms with an existing Git index lock. The backend
package ran with one Bun worker alongside the web package; the aggregate groups used
2/3/2/1 worker slots. Backend totals were 5772 passed, 2 failed and 15 skipped.

The owning file passed alone in 2.2 seconds:

```bash
mise run test:logged -- --name project-home-rerun -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/commands-registry-project-home.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XzVEFK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No assertion, timeout or skip was changed.

## Recurrence on 2026-10-11

`mise run test:logged -- --name full-tests-final -- mise run test` encountered the same fixture `.git/index.lock` conflict at 169.25 ms (workspace packages used one Bun worker each). The aggregate ran beside isolated browser validation and was later interrupted after its superseding validation began.

The owning file passed alone (exit 0, 3.0 seconds): `mise run test:logged -- --name project-home-isolation -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-registry-project-home.test.ts --parallel=1 --only-failures`.

Evidence: `/tmp/orkestrator-test-run.DjXKcv/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No assertion or timeout was changed.

## Recurrence on 2026-10-12

`mise run test:logged -- --name backend-package-tests -- bun run --cwd apps/backend test:workspace`
failed the same Git index-lock assertion in 147.02 ms with two Bun workers.
Backend totals were 5801 passed, 2 failed and 15 skipped across 326 files.

The owning file passed alone (exit 0) in 9.5 seconds:

```bash
mise run test:logged -- --name project-home-alone -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/commands-registry-project-home.test.ts --parallel=1 --only-failures
```

Failure evidence: `orkestrator-test-run.wS9yy3/backend-package-tests.log.gz`
in the platform temporary directory. No assertion, timeout or skip was changed.

## Recurrence on 2026-10-13

During canonical worktree-location validation, the GNU-tool PATH command
`mise run test:logged -- --name full-suite -- mise run test` failed the same
Git index-lock assertion in 142.66 ms. The aggregate used 2/3/2/1 worker slots
for workspace/root/bridges/protocol; workspace packages each used one Bun
worker. Backend totals were 5849 passed, 23 failed and 15 skipped across 328
files in 275.02 seconds. The other 22 failures were environment-move cleanup
errors that reproduced alone on this host, where the `tmux` executable is
absent; they are not evidence of this flake.

With the same GNU-tool PATH, the unchanged owning file passed alone (exit 0)
in 2.1 seconds:

```bash
mise run test:logged -- --name project-home-isolated -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/commands-registry-project-home.test.ts --parallel=1 --only-failures
```

Failure evidence:
`/tmp/orkestrator-test-run.xZCLLJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
and `/tmp/orkestrator-test-run.xZCLLJ/summary.json`. The isolated pass again
supports intermittent fixture Git contention without identifying the lock
owner. No assertion, timeout or skip was changed.

## Recurrence on 2026-10-13 (project navigation validation)

The GNU-tool PATH command `mise run test:logged -- --name full-tests -- mise run test`
hit the same existing fixture `.git/index.lock` during branch switching at
259.22 ms. Workspace packages used one Bun worker each with two package tasks;
root, bridge and protocol groups ran alongside them.

Backend totals were 5,875 passed, 15 skipped and 27 failed across 329 files in
442.53 seconds. Twenty-two failures reproduced as tmux cleanup errors on this
host and are separate from the index-lock flake.

The unchanged owning file passed alone (exit 0) in 6.2 seconds with the same PATH:
`mise run test:logged -- --name project-home-rerun -- bun --cwd=apps/backend test ./src/core/commands-registry-project-home.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.

Evidence: `/tmp/orkestrator-test-run.TrudTm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The isolated pass supports the existing fixture-contention hypothesis; the lock
owner remains unknown. No assertion, timeout or skip was changed.

# 0187 — Workspace artifact Git excludes aggregate timeout

Status: open

## Observation — 2026-10-11

- Test: `Electron backend command registry > injects workspace artifact git excludes into local worktrees before status reads`.
- Owning file: `tests/unit/electron/commands-integration.test.ts`.
- Command: `mise run test:logged -- --name full-tests -- mise run test`, with the macOS GNU-tool PATH from the testing guide.
- Worker configuration: root group `--parallel=3`; workspace packages used `--parallel=1`, with two package tasks at a time. The default host-capacity runner admitted groups while an isolated browser profile and focused checks were also active.
- Failure: the test exceeded its 5000 ms deadline, reported at 5075.65 ms.
- Root group: 5004 passed, 24 skipped, 2 failed, 1 unhandled error across 253 files in 179.54 seconds. The other failure was the DOM-assertion scanner finding new assertions; those assertions were corrected. A pending Git-fixture command also rejected after its temporary executable had been removed.
- Isolated rerun: `mise run test:logged -- --name command-integration-rerun -- bun test ./tests/unit/electron/commands-integration.test.ts --parallel=1 --only-failures` passed (exit 0, 18.1 seconds).
- Aggregate evidence: `/tmp/orkestrator-test-run.RaLKCL/root-and-agent-support-tests.log.gz` and its `summary.json`.

## Hypothesis

The aggregate and browser workload delayed the real Git/worktree operations beyond the five-second per-test budget. The owning file passing alone supports a load-sensitive timeout; it does not establish a product failure. Timeout cleanup may also remove a fixture executable while an already-started command still needs it. No test was skipped, loosened, or changed to hide this failure.

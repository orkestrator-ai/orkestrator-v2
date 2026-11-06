# Joined manual image pull times out in the aggregate

- **ID:** 6614
- **Status:** open
- **Observed:** 2026-11-06 on macOS arm64, branch head `d0e8b097d`.
- **Owner:** `apps/backend/tests/commands-environment-image-download.test.ts`.
- **Test:** `a structured timeout from a joined manual pull persists the timeout classification`.

## Aggregate evidence

Command:

```sh
mise run test:logged -- --name review-default-tests -- mise run test
```

The default runner allocated six slots to workspace tasks, one to root tests,
two to bridges and one to the protocol check. The backend ran with four isolated
workers. The test exceeded its 5,000 ms budget (5,007.84 ms). The run also
reported two errors between tests: `SQLITE_IOERR_VNODE` from the host-maintenance store and a
late assertion receiving the image-download failure text instead of the expected
timeout text. The fixture cleanup and late continuation appear in the same
saved output; their causal order is not established.

Backend totals: 16,615 passed, 138 skipped, two failed and two errors across
1,110 files (451.27 s). The other failed test was the container-readiness
clipped-probe timing case. The root group also failed three separate checks;
bridges and the protocol lockfile passed. The entire command exited 1 after
1,196.7 s including capacity waits.

Evidence:

- `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.BvSnwu/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
- `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.BvSnwu/summary.json`

## Isolated owner

Without changing the owner or its implementation:

```sh
mise run test:logged -- --name findings-image-download-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/commands-environment-image-download.test.ts --parallel=1 --only-failures
```

Passed, exit 0, in 12.9 s. This establishes an aggregate-only recurrence for
this observation, not a root cause or a fix. No timeout or assertion was changed.

The readiness owner was also rerun separately and retained two different timing
failures (19 passed, two failed); it is not classified as a passing owner here.

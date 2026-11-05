# Integrate review validation intermittence

- **ID:** 5105
- **Status:** open
- **Observed:** 2026-11-05, Integrate branch at `d96a45c1c`.

The exact preparation rerun was `mise run test:logged -- --name review-default-tests -- mise run test`.
Workspace/root/bridge/protocol reservations were 6/1/2/1; the groups waited about
1,200 seconds for the shared exclusive resource. Final suite totals were not
available at the time these isolated reruns finished.

Two complete unchanged owners failed in the aggregate and passed alone:

| Test | Aggregate failure | Isolated rerun |
| --- | --- | --- |
| `the resumable session list > a timeout is reported, not an empty history, and stops the read`, `bridges/pi-bridge/src/session-list-cache.test.ts:165` | Expected `signal?.aborted` true, received undefined; 41.86 ms | `mise run test:logged -- --name pi-list-isolated -- bun test --cwd=bridges/pi-bridge --preload ./src/testing/test-isolation.ts ./src/session-list-cache.test.ts --parallel=1 --only-failures`: exit 0, 2.2 s |
| `what a renderer's console can place in the saved log > no renderer logger uses the area whose lines read as markers`, `apps/desktop/tests/renderer-diagnostics.test.ts` | Exceeded 5,000 ms at 6,260.38 ms | `mise run test:logged -- --name renderer-diagnostics-isolated -- bun test --cwd=apps/desktop --preload ../../tests/setup-node.ts ./tests/renderer-diagnostics.test.ts --parallel=1 --only-failures`: exit 0, 1.1 s |

Evidence: inner `bridges.log` and `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
in `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.tjKud0/`;
the outer run is `orkestrator-test-run.lBswTp/review-default-tests.log` in the same parent.
The logged runner compresses failing logs on completion. The Pi owner and its
implementation are unchanged by the branch. The diagnostics owner scans renderer
sources, including changed files; its isolated pass establishes intermittence,
not a proven root cause. Scheduling delay under host contention is a hypothesis.
No assertions, deadlines, or skips were changed.

The logging-shutdown recurrence is recorded in case 0712. The standalone installer
failure also reproduces alone and is **not** classified as a flake here.

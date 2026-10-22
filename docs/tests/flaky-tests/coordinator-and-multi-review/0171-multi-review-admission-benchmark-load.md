# Multi Review admission benchmark exceeds its limit under aggregate load

- **ID:** 0171
- **Status:** resolved
- **Date observed:** 2026-09-28
- **Test:** `Multi Review control-plane benchmark > one slow reviewer does not serialize the rest of the panel`
- **File:** `apps/backend/src/core/multi-review-efficiency.bench.test.ts:444`
- **Original command:** `mise run test`, while other worktrees were also testing on the host.
- **Failure:** `result.admissionMs` was 330 ms; the assertion required less than 310 ms.
- **Isolated rerun:** `mise run test:logged -- --name backend-multi-review-bench -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures` passed.
- **Second aggregate run:** `mise run test` passed all four groups, including the workspace group.

## Current assessment

The benchmark is sensitive to host load. The backend code did not change in this task. Investigate the timing budget and host contention before changing the limit.

## Recurrence (2026-10-01)

During validation of the design-prompt paste fixes on `140f6cb1` plus the
working changes, `mise run test` again failed this assertion: admission took
428 ms against the unchanged 310 ms limit (the case ran for 1514 ms).
The aggregate used workspace 2, root 3, bridges 2 and protocol 1 worker slots.
Its web package passed 8023 tests with 11 skipped and no failures; the aggregate
also had unrelated host/tooling failures.

The owning file passed unchanged when rerun with:

```bash
mise run test:logged -- --name backend-multi-review-bench -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures
```

The isolated run completed in 2.3 seconds. Aggregate failure evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.FrGJ2w/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
This supports the existing host-contention hypothesis; no benchmark assertion
or backend behavior was changed.


## Recurrence (2026-10-13)

During validation of the composer lock fixes at `d0885894`, the unchanged
benchmark's admission time was 322 ms against the 310 ms limit; the case took
1213.40 ms. The original command was `mise run test:logged -- --name
full-suite-final -- mise run test`, with GNU host utilities preferred in PATH.
The aggregate reserved workspace 2, root 3, bridges 2 and protocol 1 worker
slots; other worktrees were also validating on the host.

The backend group reported 5,879 passed, 23 failed and 15 skipped. Twenty-two
failures were in the unchanged environment-move suite, which also failed alone
with `claude-tmux cleanup incomplete`. The final root group passed 5,029 tests
with 24 skipped; the bridge and protocol groups passed.

The benchmark owning file passed unchanged when rerun alone:

```bash
mise run test:logged -- --name review-benchmark-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures
```

The logged rerun completed in 2.9 seconds. Aggregate failure evidence is in
`/tmp/orkestrator-test-run.OloPu3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
This supports the existing host-contention hypothesis; no benchmark assertion
or backend behavior was changed.

## Recurrence (2026-10-15, main merge validation)

- **Failure:** admission took 328 ms against the unchanged less-than-310 ms assertion; the case took 746.27 ms.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU host utilities preferred in PATH.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated Bun workers.
- **Aggregate counts:** backend reported 7,731 passed, 39 skipped and 3 failed across 424 files; the root, bridge and protocol groups passed. The shutdown cleanup failure also reproduced alone and is not classified as a flake.
- **Evidence:** `/tmp/orkestrator-test-run.yeOzQY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `mise run test:logged -- --name merge-review-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 2.1 seconds.
- **Assessment:** consistent with the existing host-contention hypothesis; no timing assertion or backend code was changed during conflict resolution.

## Recurrence on GitHub Actions (2026-10-15)

`main` run 38784461548 (`7ccb193e`, four-vCPU runner, one Bun worker per
package) failed the assertion with 630 ms against the 310 ms bound.

## Resolution (2026-10-15)

The wall-clock bound `admissionMs < 250 + 3 * setupDelayMs` only had 60 ms of
headroom over the slow setup, so any scheduling delay on a loaded host
failed it. It also proved less than its comment claimed. If the peers'
sessions were created concurrently but their dispatch waited for the slow
setup, admission would still have been about 252 ms and passed.

The benchmark now asserts the ordering directly. With `slowSetupAwaitsPeers`,
the slow reviewer's `createSession` also waits until every other reviewer's
turn has been dispatched (`send` returned). A five-second limit
(`PEER_DISPATCH_LIMIT_MS`) applies, so a regression fails instead of hanging.
The provider records how many turns were dispatched when that setup returned
(`dispatchedDuringSlowSetup`), and the case asserts it is 3. Report-only runs
(`MULTI_REVIEW_BENCH_REPORT_ONLY=1`) keep the plain 250 ms setup, so tables
from older builds stay comparable. No production code or budget changed.

Evidence: the owning file passed in 2.1 seconds with
`mise run test:logged -- --name review-bench -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/multi-review-efficiency.bench.test.ts --parallel=1`.
A temporary copy that forced serial admission
(`reviewFanoutConcurrency: { admission: 1, provider: 1 }`) failed with
`Expected: 3, Received: 0` after the 5 s limit, so the case still catches the
regression it guards.

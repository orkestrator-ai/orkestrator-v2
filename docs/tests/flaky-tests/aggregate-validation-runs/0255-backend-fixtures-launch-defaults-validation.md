# Backend fixture failures during coordinator launch-defaults validation

- **ID:** 0255
- **Status:** open
- **Date observed:** 2026-10-16
- **Tested change:** `0d254a3a`, branch `coordinator-launch-defaults`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots;
  backend used two isolated Bun workers. Other worktree validations and the
  isolated browser suite were also running on the host.
- **Aggregate result:** backend 8,106 passed, 40 skipped, 10 failed. Root,
  bridges and protocol passed; all other workspace packages passed. The full
  run took 667.3 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.ZFy0QQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  and `/tmp/orkestrator-test-run.FYRLfy/full-suite.log.gz`.

These three additional unchanged cases failed in the aggregate and passed when
rerunning their owning files separately:

| Test | Owning file under `apps/backend/` | Aggregate symptom |
| --- | --- | --- |
| `project coordinator > retention never removes an open conversation` | `src/core/coordinator-service.test.ts` | Five-second deadline, reported at 5196.81 ms; timeout teardown also reported `SQLITE_IOERR_VNODE`. |
| `continues merged environment cleanup when the remote head branch is already deleted` | `tests/commands-registry-environments.test.ts` | Five-second deadline, reported at 5234.80 ms. |
| `agent-test container mounts come from the isolated profile paths, not the host home` | `tests/commands-registry-environments-status.test.ts` | At 225.08 ms, the fake Docker log contained only image inspection, without the expected Claude config mount. |

The same aggregate reproduced existing cases [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md)
(5170.63 ms), [0218](../design-canvas-and-artifacts/0218-design-service-replay-aggregate-timeout.md)
(5029.84 ms), [0211](../environments-and-containers/0211-cleanup-retry-aggregate-timeout.md) (6045.05 ms),
[0220](../environments-and-containers/0220-local-server-deletion-aggregate-timeout.md) (8420.15 ms),
[0226](../environments-and-containers/0226-deletion-reap-failure-aggregate-timeout.md) (5043.07 ms), and
[0151](../environments-and-containers/0151-strict-lifecycle-missing-container-timeout.md) (7728.48 ms).

## Owning-file reruns

Each command was a separate invocation of the following form, with the owning
file as the only test path and `--parallel=1`:

```bash
mise run test:logged -- --name <name> -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts <path> --parallel=1 --only-failures
```

| Name | Path | Result |
| --- | --- | --- |
| `coordinator-owner` | `./src/core/coordinator-service.test.ts` | Passed, exit 0, 15.4 s |
| `design-owner` | `./src/core/design/service.test.ts` | Passed, exit 0, 3.4 s |
| `cleanup-owner` | `./tests/commands-integration.test.ts` | Passed, exit 0, 37.6 s |
| `environments-owner` | `./tests/commands-registry-environments.test.ts` | Passed, exit 0, 26.5 s |
| `environment-status-owner` | `./tests/commands-registry-environments-status.test.ts` | Passed, exit 0, 6.1 s |

Shared-host contention and asynchronous fixture work continuing after a timeout
are plausible contributors; these passes do not establish the cause. No owning
test, assertion, timeout, or skip was changed.

## Other validation limitations

The tenth backend failure is deterministic, rather than classified as a flake:
`agent-provider-boundaries.test.ts` requires provider files to contain at most
1,500 lines, while the unchanged `http-bridge-provider.ts` has 1,505 lines.
`git show 0d254a3a^:apps/backend/src/core/http-bridge-provider.ts | wc -l`
also reports 1,505. This change does not edit that provider.

Static checks (`mise run check`), the launch regression tests, the startup
reconciliation integration test and the renderer model-selection tests passed.
The browser observations and exact rerun commands are recorded in
[0224](../previews-annotations-and-gateway/0224-host-picker-narrow-tools-popover.md). Both disposable profiles were
stopped and reset; `dev:status --json` reported `missing` with no live processes.
Dedicated Docker, Electron and iOS scenario suites were omitted because their
implementation paths were unchanged; credentialed browser cases remained opt-in.

## Retention case resolved separately (2026-10-17)

`project coordinator > retention never removes an open conversation` recurred
in CI (run 38893136380, 5022.97 ms) and has been resolved as
[0266](../coordinator-and-multi-review/0266-coordinator-retention-open-conversation-timeout.md). It ran 128
sequential durable writes against the 5 s deadline, and the test now fills the
retention boundary in one mutation. The other cases in this
file remain open.

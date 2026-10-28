# Git fsmonitor scans exceed the aggregate test deadline

- **ID:** 1253
- **Status:** open
- **Date observed:** 2026-10-28
- **File:** `apps/backend/src/core/git-fsmonitor.test.ts`
- **Original command:** `mise run test` during review preparation at `05737aff0133f4d7a377ec30d1cfb37f514b71de`.
- **Worker configuration:** default concurrent workspace/root/bridges/protocol groups, with 6/1/2/1 reserved worker slots respectively.

Four `git fsmonitor` cases exceeded the 5,000 ms test deadline:

| Test | Reported duration |
| --- | --- |
| `a linked project-home scan preserves the user's setting and daemon` | 5,011.98 ms |
| `a scan retries migration after a transient rev-parse failure` | 5,006.85 ms |
| `a scan retries migration after a transient --get failure` | 5,007.89 ms |
| `a scan retries migration after a transient --unset failure` | 5,010.35 ms |

The backend reported 10,117 pass, 87 skip, 4 fail and 4 between-test errors
across 664 files (100.98 s). The errors included Git status/diff commands
terminated with SIGTERM after the test deadline. The other three aggregate
groups passed; the aggregate exited 1 after 155.6 s.

Preparation evidence is in `validation-05.stdout.txt` under
`.orkestrator/review-artifacts/review-validation-8de2a0fc-89bc-48db-8014-285a48ced97e/`.

The complete unchanged owner passed alone (exit 0, 8.3 s) with:

```sh
mise run test:logged -- --name git-fsmonitor-isolated -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

The aggregate-only recurrence is consistent with timing contention around real
Git processes, but the cause has not been established. No fsmonitor code,
assertions, timeouts or skips changed.

The exact original command then passed through the logging wrapper:

```sh
mise run test:logged -- --name default-tests-rerun -- mise run test
```

The wrapper exited 0 after 147.3 s. Keep the case open: a passing rerun does
not establish that the aggregate timing issue is fixed.

## Coordinator upstream-send review recurrence — 2026-10-28

Review preparation at `3f6fc3016ae881312ba3afde8145832603d59719` repeated
five-second timeouts in the linked project-home scan and the transient
`rev-parse` and `--get` migration scans. The aggregate exited 1 after 373.0 s;
its root, bridge and protocol-lockfile groups passed. Preparation evidence is
`.orkestrator/review-artifacts/review-validation-41f403c0-5bc8-4df1-8983-e2fdbef55ac5/validation-04.stdout.txt`.

The complete unchanged fsmonitor owner passed alone in 10.1 s (exit 0):

```sh
mise run test:logged -- --name git-fsmonitor-isolated -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

It also passed alongside the native-agent admission and image-download owners
with one Bun worker (99 tests, 14.5 s). No fsmonitor implementation, assertion,
clock or skip changed in this repair.

The exact aggregate rerun (`mise run test` through `test:logged`) passed the
fsmonitor cases and retained only the unrelated activity-batch timeout tracked
in [0247](../native-agents-and-transcripts/0247-activity-batch-sweep-no-requests.md).


## Queued-prompt keyboard review recurrence — 2026-10-28

Preparation at `91513d96d` repeated all four named five-second timeouts:
linked project-home scan (5,033.16 ms), transient `rev-parse` (5,013.48 ms),
`--get` (5,029.51 ms) and `--unset` (5,010.94 ms). `mise run test` used default
workspace/root/bridge/protocol reservations of 6/1/2/1 (backend four workers)
alongside the nine-worker browser suite. Backend reported 10,153 passed,
87 skipped and six failed, including the two source-store cases in 0932;
the aggregate failed its workspace group after 332.2 s. Evidence:
`.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-04.stdout.txt`.

The complete unchanged fsmonitor and source-store owners passed sequentially
with one Bun worker (exit 0, 9.8 s):

```sh
mise run test:logged -- --name recorded-backend-owners -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/git-fsmonitor.test.ts ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures
```

No fsmonitor implementation, assertion, timeout or skip changed. The passing
logged runner discarded detailed output; contention remains an unproven cause.

The exact original aggregate command then passed (exit 0, 274.7 s):

```sh
mise run test:logged -- --name review-repair-tests -- mise run test
```

The successful rerun does not establish a flake fix; this case remains open.


## Uniform app shortcuts review recurrence — 2026-10-28

Preparation at `c73f44755` repeated the four five-second scan deadlines
(linked project-home 5,012.92 ms; transient rev-parse 5,038.27 ms; --get
5,008.28 ms; --unset 5,024.25 ms), during `mise run test` with the default
workspace/root/bridges/protocol worker reservations of 6/1/2/1 alongside
component-browser validation. The complete unchanged owner passed alone:

```sh
mise run test:logged -- --name fsmonitor-owner -- bun test --cwd apps/backend ./src/core/git-fsmonitor.test.ts --parallel=1 --only-failures
```

Exit 0, 8.9 seconds. Preparation evidence:
`.orkestrator/review-artifacts/review-validation-b78694d3-cfea-4eae-8896-38cb77ce8e81/validation-04.stdout.txt`.
No implementation, assertion, timeout or skip changed; this remains an open
aggregate timing case.


After fixing an unsupported build option in the newly added minification
regression, the exact original repository command was rerun:
`mise run test:logged -- --name review-repair-tests -- mise run test`.
All four groups passed (exit 0, 204.1 seconds). The fsmonitor assertions and
timeouts remain unchanged.

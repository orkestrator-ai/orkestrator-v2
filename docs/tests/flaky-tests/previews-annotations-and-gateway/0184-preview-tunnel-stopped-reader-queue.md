# Stopped-reader tunnel queue exceeds its assertion under aggregate load

- **ID:** 0184
- **Status:** resolved
- **Date observed:** 2026-10-08
- **Test:** `PreviewTunnelServer > a stopped reader cannot grow the queue without bound`
- **File:** `apps/backend/src/preview-tunnel-server.test.ts:270`
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
- **Worker configuration:** Aggregate groups used 2/3/2/1 slots; backend had one Bun worker alongside the web package.
- **Failure:** Expected `aggregateQueuedBytes <= 557056`; received `721158` after the stopped-reader delay (309.24 ms).
- **Suite counts:** Backend package: 5772 passed, 2 failed, 15 skipped (5789 total).
- **Isolated rerun:** Passed the owning file in 0.8 seconds, exit 0:

```bash
mise run test:logged -- --name preview-tunnel-rerun -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.XzVEFK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

The assertion samples queue accounting 300 ms after pausing a real WebSocket
reader. The isolated pass establishes intermittent behavior. Scheduling or
transport buffering may affect the sampled queue, but the observed failure does
not establish a root cause. No assertion, timeout or skip was changed.

## Recurrence during merge validation (2026-10-12)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with the GNU-tool `PATH` prefix from the testing guide.
- **Worker configuration:** aggregate groups used 2/3/2/1 slots; backend had one isolated Bun worker alongside the web package.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `648578` after the stopped-reader delay (308.88 ms), at line 279.
- **Suite counts:** backend package: 5,789 total, 5,773 passed, 15 skipped, 1 failed.
- **Isolated rerun:** `mise run test:logged -- --name merge-preview-tunnel-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed in 0.7 seconds.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.zbwgoU/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** this repeats the existing intermittent queue-sampling failure. The isolated pass does not establish its root cause; the merge resolution changes only flake documentation.

## Recurrence during merge validation (2026-10-13)

- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, with the GNU-tool `PATH` prefix from the testing guide.
- **Worker configuration:** aggregate groups used 2/3/2/1 slots; backend had one Bun worker alongside the web package.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `565806` after the stopped-reader delay (314.43 ms), at line 279.
- **Suite counts:** backend package: 5,888 passed, 15 skipped and 23 failed across 329 files. The other 22 failures reported environment-move tmux cleanup errors on a host without `tmux`.
- **Isolated rerun:** `mise run test:logged -- --name merge-preview-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed unchanged in 0.8 seconds, exit 0.
- **Failure evidence:** `/tmp/orkestrator-test-run.UPNQcn/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; aggregate summary: `/tmp/orkestrator-test-run.UPNQcn/summary.json`.
- **Hypothesis:** this repeats the existing intermittent queue-sampling failure; the isolated pass does not establish a root cause. No assertion, timeout or skip was changed.

## Recurrence during dependency-review fixes (2026-10-13)

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`, with the GNU-tool `PATH` prefix from the testing guide.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots; backend used one isolated Bun worker alongside the web package.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `819474` at line 279 (307.70 ms).
- **Suite counts:** backend: 5,923 total, 5,906 passed, 15 skipped, 2 failed. Root/support, bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name preview-tunnel-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed, exit 0, in 0.8 seconds.
- **Evidence:** `orkestrator-test-run.lgjNH5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `summary.json` in the macOS temporary directory.
- **Hypothesis:** same intermittent queue-sampling failure as the previous observations. This run does not establish the root cause. No assertion, timeout or skip was changed.

## Recurrence during architecture-review fixes (2026-10-14)

- **Original command:** `CODEX_PROTOCOL_BINARY="$PWD/binaries/codex" mise run test:logged -- --name review-fixes-suite-pinned -- mise run test`, with the GNU-tool `PATH` prefix from the testing guide; macOS arm64, Bun 1.4.3.
- **Worker configuration:** workspace/root/bridges/protocol used 2/3/2/1 slots; backend used one isolated Bun worker alongside the web package.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `574002` at line 279 (309.50 ms).
- **Suite counts:** backend: 5,940 total, 5,924 passed, 15 skipped, 1 failed. Root/support, bridges and strict pinned-protocol verification passed. The 34 environment-move tests passed, including the stages after tmux quiesce.
- **Isolated rerun:** `mise run test:logged -- --name preview-tunnel-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.7 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.e8tyW1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `/tmp/orkestrator-test-run.e8tyW1/summary.json`.
- **Hypothesis:** this repeats the existing intermittent queue-sampling failure. The isolated pass does not establish its root cause. No assertion, timeout or skip was changed.

## Recurrence during terminal-input merge validation (2026-10-15)

- **Original command:** `mise run test:logged -- --name merge-tests-gnu -- mise run test`, with the GNU-tool `PATH` prefix from the testing guide; Bun 1.4.3.
- **Worker configuration:** workspace/root/bridges/protocol used 4/1/2/1 slots; workspace allowed two packages with two Bun workers each.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `557298` at line 279 (315.02 ms).
- **Suite counts:** backend: 7,859 total, 7,819 passed, 39 skipped, 1 failed. Root/support, bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name merge-preview-tunnel -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.7 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.eJf1X8/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `/tmp/orkestrator-test-run.eJf1X8/summary.json`.
- **Hypothesis:** this repeats the existing intermittent queue-sampling failure. The isolated pass does not establish its root cause. No assertion, timeout or skip was changed.

## Recurrence during supervisor-transcript merge validation (2026-10-15)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`; Bun 1.4.3.
- **Worker configuration:** workspace/root/bridges/protocol used 4/1/2/1 slots; workspace allowed two packages with two Bun workers each.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `606770` at line 279 (313.04 ms).
- **Suite counts:** backend: 8,036 total, 7,996 passed, 39 skipped, 1 failed across 436 files. Root/support, bridges and protocol passed; workspace reported 12 successful tasks out of 13.
- **Isolated rerun:** `mise run test:logged -- --name merge-preview-tunnel-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.7 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.LW4SBd/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `/tmp/orkestrator-test-run.LW4SBd/summary.json`; outer wrapper: `/tmp/orkestrator-test-run.dDf2wg/merge-tests.log.gz`.
- **Hypothesis:** this repeats the existing intermittent queue-sampling failure under aggregate load. The isolated pass does not establish its root cause. No assertion, timeout or skip was changed.

## Recurrence during coordinator research fixes (2026-10-16)

- **Original command:** `mise run test:logged -- --name stable-final-tests -- mise run test`; Bun 1.4.3, macOS arm64.
- **Worker configuration:** workspace/root/bridges/protocol used 4/1/2/1 slots; workspace allowed two packages with two Bun workers each.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `557298` at line 279 (311.33 ms).
- **Suite counts:** backend: 8,141 total, 8,099 passed, 40 skipped, 2 failed across 440 files, with 40,463 assertions in 255.40 seconds. The other failure was the pre-existing `http-bridge-provider.ts` 1,500-line boundary (1,505 lines). Root/support, bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name preview-isolated -- bun test --cwd apps/backend ./src/preview-tunnel-server.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.7 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.5JXfax/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer wrapper: `/tmp/orkestrator-test-run.nBYbNf/stable-final-tests.log.gz`.
- **Hypothesis:** same intermittent queue-sampling failure as the prior observations. No assertion, timeout, skip or tunnel behavior was changed.

## Recurrence during live coordinator suite main merge (2026-10-16)

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1
  slots; backend used two isolated Bun workers on a shared 18-slot host.
- **Suite counts:** backend 8,280 passed, 40 skipped, four failed and two
  between-tests errors across 441 files (452.96 seconds). The aggregate exited
  1 after 600.8 seconds. All other workspace packages and the bridge/protocol
  groups passed; root had the Pi staged-runtime timeout tracked as 0178.
- **Evidence:** `/tmp/orkestrator-test-run.3yIsw1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifact `/tmp/orkestrator-test-run.i4Amls/merge-tests.log.gz`.

- **Failure:** `PreviewTunnelServer > a stopped reader cannot grow the queue without bound`
  in `apps/backend/src/preview-tunnel-server.test.ts` expected queued bytes
  `<= 557056` but received `574286` at line 279 (325.80 ms).
- **Isolated rerun:** `mise run test:logged -- --name merge-preview-tunnel-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file in 2.1 seconds, exit 0.
- **Hypothesis:** this repeats the intermittent queue-sampling failure under
  aggregate load; its root cause remains unconfirmed. No test, timeout,
  assertion or skip was changed.

## Recurrence during Multi Review follow-up validation (2026-10-16)

- **Command:** `mise run test:logged -- --name full-suite -- mise run test`, with 4/1/2/1 workspace/root/bridge/protocol slots and two backend workers.
- **Failure:** the queue sample was 557298 bytes against the 557056-byte bound (323.02 ms test duration). No tunnel implementation changed.
- **Owning-file rerun:** `mise run test:logged -- --name preview-queue-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed unchanged in 0.8 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.1PZf4j/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No assertion, bound, timeout or skip changed; the root cause remains unconfirmed.

## Recurrence during execution-policy review fixes (2026-10-17)

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`; macOS arm64, Bun 1.4.3.
- **Worker configuration:** workspace/root/bridges/protocol used 4/1/2/1 slots; workspace allowed two packages with two isolated Bun workers each.
- **Failure:** expected `aggregateQueuedBytes <= 557056`; received `639542` at line 279 (314.53 ms).
- **Suite counts:** backend: 8,206 total, 8,164 passed, 40 skipped, 2 failed across 439 files. The other failure is the pre-existing provider-module size check: unchanged `http-bridge-provider.ts` has 1,505 lines at HEAD against a 1,500-line limit, and fails alone too. Root/support, bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name preview-tunnel-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.7 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.20GMqp/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `summary.json`; outer wrapper: `orkestrator-test-run.oXpWyb/full-tests.log.gz` in the same temporary directory.
- **Hypothesis:** this repeats the existing aggregate-load queue-sampling failure. The isolated pass establishes intermittent behavior without identifying the root cause. No assertion, timeout or skip was changed.

## Resolution (2026-10-17)

The bound was really exceeded, by the server rather than the sample.
`pumpToClient` framed a whole upstream `data` chunk and only then compared
`writableLength` with twice `tunnelQueueMaxBytesPerDirection`. Bun reads the
fixture's endless body 512 KiB at a time. A temporary trace of the unchanged
code on an isolated run showed the first chunk go straight to the kernel
(`chunk=524288 buffered=0 flushed=true`), so the upstream was never paused,
and the second push `writableLength` to 524,352 bytes and trip the capacity
close. Even passing runs closed the tunnel with only 32,704 bytes of headroom
against the test's bound. Under load part of the first chunk is still queued
when the second arrives, and the sample lands above the bound (557,298 to
819,474 bytes here).

`pumpToClient` now checks the queue before each frame and fails with
`capacity-exceeded` before a frame would take it past twice the per-direction
limit. The queue is now bounded by the limit rather than by the runtime's read
size. The test is unchanged apart from its comment.

- Stress, eight concurrent processes, each
  `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/preview-tunnel-server.test.ts -t "stopped reader" --rerun-each 20`,
  on a host with a load average of about 20: the old code failed 12 of 160
  (received 557,298, 581,350, 639,546, 648,951, 721,158 and 786,702), the
  fixed code passed 160 of 160.
- The owning file passed alone (11 tests), and with every preview file.
- A slow but still-reading client is still closed, not paused, by one large
  read. That was tracked as code item 4 in
  [0042-service-preview-rollout.md](../../../todo/previews-and-annotations/0042-service-preview-rollout.md).

## Follow-up (2026-10-17): pause instead of close

`pumpToClient` now pauses the upstream at the per-direction limit, before each
frame, and returns the rest of the read to the upstream with `unshift`. The
queue now stays within one frame of the limit, and a stopped reader keeps its
tunnel until the liveness ping closes it. This test now asserts that tighter
bound (`limit + frame + 14` header bytes) and that the tunnel is still open.
Before the change it failed with 435,072 queued bytes against 294,926.
`PreviewTunnelServer > one large upstream read to a slow reader pauses at the
queue bound instead of closing` replaces the test that expected the
`capacity-exceeded` close.

# Stopped-reader tunnel queue exceeds its assertion under aggregate load

- **ID:** 0184
- **Status:** open
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

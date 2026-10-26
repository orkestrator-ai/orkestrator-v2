# OpenCode coordinator research-server registration timeout

- **ID:** 0785
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `OpenCode coordinator research servers > registers a research server and allows exactly its tools`
- **Owning file:** `apps/backend/src/core/opencode-coordinator-research-live.test.ts`
- **Parents:** feature `2e7edbc161b60cb188437783168f8bc8135f5953` and main `95c9cb46ae0a2b12fbc10ff73fa7c0614b254a0d`.
- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23 mise run test:logged -- --name refresh-0043-suite -- mise run test`.
- **Worker configuration:** default 4/1/2/1 workspace/root/bridge/protocol reservations; two backend Bun workers, alongside browser and Electron checks.
- **Failure:** the case exceeded its 40-second outer deadline (40,001.72 ms), with one dangling process killed. It drives a real pinned `opencode serve` and local MCP fixtures without a model service.
- **Suite counts:** backend: 10,857 passed, 117 skipped and two failed across 650 files (572.16 s). The second failure was an unrelated tmux teardown assertion.
- **Complete unchanged owner:** `mise run test:logged -- --name refresh-0043-research-live-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` passed (exit 0, 1.5 s).
- **Evidence:** `orkestrator-test-run.fqu9cJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** an aggregate-specific timeout, confirmed by the unchanged complete owner pass. No narrower root cause has been established. No implementation, assertion, deadline or skip changed.

## Recurrence 2026-10-25 (scheduled jobs)

- **Run:** `mise run test` on the scheduled-jobs branch (parent main `ba7cc8d4`), workspace group.
- **Failure:** the same 40-second outer deadline (40,000.72 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name research-live-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` passed (1.9 s). Without the `setup-node.ts` preload the file also times out alone, so isolated reruns must use it.

Recurred again in the same branch's `mise run test` after rebasing onto main
`eda21487` (40,001.15 ms). One logged isolated rerun with the preload failed
immediately afterwards; the next isolated rerun with the same command passed
(1 of 1, 1.81 s). The isolated failure suggests a startup race in the live
`opencode serve` fixture rather than aggregate load alone.

## Recurrence — 2026-10-25

- Command: `mise run test:logged -- --name full-test-2 -- mise run test` on branch `todo-0054-design-a11y-findings-ec88681caf58` (`ba7cc8d4` plus the design-canvas accessibility working tree, which touches only `apps/web/src/components/design/`, its tests and two `e2e/` specs, not this test's code), macOS 27.0 arm64, default `mise run test` groups, host load average 55 to 66. The same suite's first run on this branch, an hour earlier, passed the workspace group.
- Failure: the case exceeded its 40-second outer deadline (40,000.38 ms). Backend: 10,457 passed, 79 skipped and 2 failed across 10,538 tests in 615 files (853.45 s); the other failure was the 0165 coordinator unborn-HEAD timeout.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MUtdn0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Complete unchanged owner: `mise run test:logged -- --name opencode-research-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` passed (exit 0, 6.2 s).
- Assessment: a second aggregate-only timeout under heavy load. Still open; no implementation, assertion, deadline or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** recurred on 2026-10-25 in [0801](../aggregate-validation-runs/0801-per-machine-accounts-validation.md) at 40,002.06 ms, and the owner passed alone. Two failures at exactly the 40 s deadline, against 1.5 s alone, suggest a hang during startup rather than slow work.
- **Next step:** on timeout, print the `opencode serve` output and the last registration step reached. Check whether the start waits on the shared OpenCode database lock (see [0723](../backend-services-and-tooling/0723-opencode-host-shutdown-retry-race.md)).

## Main-merge recurrence — 2026-10-25

- Merge parents: feature `7650912e87ff060ba5beeb6a5f7e29e26d9e49ea` and main `1d40fcf38a9845ede8a2645dce437a41eaa1587e`, on branch `false-worker-finished-notice-31ed23d5bb4d`, Linux x64. The sole source conflict was coordinator callback wiring in `apps/backend/src/core/index.ts`; this test was unchanged.
- Command: `mise run test:logged -- --name merge-suite -- mise run test`, using default reservations of 4 workspace, 1 root, 2 bridge and 1 protocol worker slots, with two backend Bun workers.
- Failure: the same case timed out at 40,000.69 ms, with one dangling process killed. Backend: 11,478 passed, 134 skipped, 1 failed across 11,613 tests in 688 files (399.97 s). All other workspace packages and the root, bridge and protocol groups passed; aggregate duration was 516.0 s.
- Complete unchanged owner: `mise run test:logged -- --name merge-opencode-research-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` passed (exit 0, 2.6 s).
- Evidence: `/tmp/orkestrator-test-run.BiI1L3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer logged-run summary: `/tmp/orkestrator-test-run.zPP21z/summary.json`.
- Assessment: another aggregate-only timeout. The cause remains unconfirmed; no implementation, assertion, timeout or skip changed.

## Fails alone on omarchy-hp — 2026-10-26

- Branch `todo-0058-legacy-migration-symlink-977645ad36e4` (todo 0058; changes only `docker/orkestrator-migrate.sh`, `tests/unit/migrate-copy.test.ts`, a live Docker test and docs), Arch Linux x64, 12 cores.
- Command: `mise run test:logged -- --name full-test -- mise run test`. The case timed out at 40,000.51 ms.
- Unlike earlier observations, the complete unchanged owner also timed out **alone**, three times at 40.0–40.9 s: `bun test --preload ../../tests/setup-node.ts src/core/opencode-coordinator-research-live.test.ts` from `apps/backend`, at load average 11–15 on 12 cores. It timed out the same way in a disposable worktree of clean `origin/main` (`a51045a4`), so the branch did not cause it. The binary is the pinned toolchain copy that `policyQualificationCli("opencode")` resolves from the host's data directory (read only).
- Assessment: on this host the hang is now deterministic rather than load-only, which supports the startup-hang hypothesis above. No implementation, assertion, timeout or skip changed.

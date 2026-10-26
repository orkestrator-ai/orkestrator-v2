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

## Remote host upgrades (0033) recurrence — 2026-10-26

- **Original command:** `mise run test` on branch `todo-0033-remote-host-upgrades-e94b3d6c2a08` (base `93018933`), Bun 1.4.4 on Arch Linux x64 (omarchy-hp), host load average 15–17 with other worktrees running suites. The diff touches no OpenCode, provider or coordinator code.
- **Failure:** the 40-second outer deadline (40,002.96 ms), one dangling process killed.
- **Isolated reruns:** both failed the same way. `bun test --preload ../../tests/setup-node.ts --parallel=1 src/core/opencode-coordinator-research-live.test.ts` from `apps/backend` (40,019.46 ms), then the documented `mise run test:logged -- --name research-live-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures` (40,013.44 ms; load average 10–15). Not yet confirmed as a flake on this host: no passing isolated run was obtained.
- **Evidence:** `/tmp/orkestrator-test-run.s0jA9M/…toolchain.log.gz` and `/tmp/orkestrator-test-run.LsRgok/` on omarchy-hp.
- **Assessment:** consistent with the earlier timeout under contention; a host-specific cause (the real `opencode serve` not reaching `connected` within 20 s at this load) is possible. No implementation, deadline or skip changed.
- **Again after rebasing onto `a51045a4`:** `mise run test` hit the same 40-second deadline (40,001.60 ms) as the backend's only failure (11,742 passed, 142 skipped, 1 failed).

## Desktop recovery validation — 2026-10-26

`mise run test:logged -- --name recovery-repository -- mise run test` on Linux
x64 repeated the 40-second registration timeout (40001.33 ms, two backend
workers). The complete unchanged owner also timed out with
`mise run test:logged -- --name unrelated-opencode-owner -- bun test --cwd apps/backend ./src/core/opencode-coordinator-research-live.test.ts --parallel=1 --only-failures`
(40032.56 ms; zero passed, one failed; 43.0 seconds logged). Both runs killed
one dangling fixture process. This observation is non-green in isolation and
does not establish a new aggregate-only flake. No OpenCode implementation,
assertion, timeout or skip changed. Evidence:
`/tmp/orkestrator-test-run.bTab6l/unrelated-opencode-owner.log.gz` and the aggregate
log in `/tmp/orkestrator-test-run.DpxCwj/` after completion.

## Recurrence — 2026-10-26

- Command: `mise run test` on branch `todo-0020-container-state-observation-fb5e330d3136` (`d3dcfd62b`: container image, entrypoint, e2e spec, CI workflow and docs; nothing near this test), macOS 27.0 arm64, default groups, host load average about 23 to 32 from other workers.
- Failure: the case timed out at 40,002.04 ms, the backend's only failure. The root group's other failure was flake 0887's missing register fields, fixed in the same change.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.gmkkKT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Complete unchanged owner: `mise run test:logged -- --name opencode-research-isolated -- bun test --cwd apps/backend ./src/core/opencode-coordinator-research-live.test.ts --parallel=1` passed (exit 0, 2.4 s).
- Assessment: another aggregate-only timeout at the 40 s deadline. Still open; nothing changed.

## Remote host upgrades main merge — 2026-10-26

The merged aggregate repeated the 40-second timeout (40003.45 ms). The complete unchanged owner also timed out (40015.45 ms, zero passed, one failed; one dangling fixture process killed). This remains non-green in isolation. Commands, workers, counts and evidence are recorded in [1009](../aggregate-validation-runs/1009-remote-host-main-merge-validation.md). No implementation, assertion, deadline or skip changed.

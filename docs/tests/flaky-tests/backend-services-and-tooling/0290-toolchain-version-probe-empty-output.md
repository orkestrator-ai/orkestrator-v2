# Toolchain version probe sometimes observes empty output

- **ID:** 0290
- **Status:** open
- **Date observed:** 2026-10-17

## Codex catalogue review validation — 2026-10-17

- **Test:** `pinned desktop toolchain cache > probes installed executables and
  rejects unexpected versions`, `packages/toolchain/src/manager.test.ts`.
- **Original command:** `mise run test:logged -- --name final-full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots; package suites use two isolated workers). Other worktrees
  shared the host; this workspace's credential-free browser run had completed.
- **Failure:** the expected successful executable probe rejected with
  `codex reported an unexpected version: no output` at 55.61 ms.
  Toolchain reported 90 passed and one failed across 91 tests in two files
  (6.00 seconds).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  (compressed when the aggregate completes).
- **Owning-file rerun:** `mise run test:logged -- --name toolchain-manager-rerun -- bun test --cwd packages/toolchain --preload ../../tests/setup-node.ts ./src/manager.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 7.5 seconds.
- **Hypothesis:** `probeExecutable` evaluates buffered stdout/stderr on the
  child's `exit` event. Stream delivery timing under load may explain the
  empty buffer, but this run does not establish the cause. Investigate stream
  completion separately; no toolchain implementation, assertion, timeout or
  skip changed in the catalogue fix.

Final aggregate totals: backend 8814 passed, 41 skipped, ten failed and three
between-tests errors across 8865 tests in 472 files (541.38 seconds).
Toolchain had 90 passed and one failed. Root, bridges, protocol and every
other workspace package passed; aggregate exit 1 after 852.0 seconds.

## Transcript-paging main merge — 2026-10-18

The GNU-tool PATH prefix followed by `mise run test:logged -- --name merge-tests -- mise run test` repeated the empty Codex version output at 223.50 ms. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; toolchain used two isolated workers alongside browser validation and other worktrees. `mise run test:logged -- --name merge-toolchain-owner -- bun test --cwd packages/toolchain --preload ../../tests/setup-node.ts ./src/manager.test.ts --parallel=1 --only-failures` passed the unchanged owner, exit 0, in 5.6 s. Evidence: `orkestrator-test-run.Yk2l1H/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. No source, assertion, timeout or skip changed.

Final aggregate counts: toolchain 90 passed and one failed across 91 tests in two files (6.48 s). The aggregate exited 1 after 1473.5 s including queue time; root also reported 0178/0482 and backend reported 0165/0211. All other workspace packages, bridges and protocol passed.


## Leaf grouping main merge — 2026-10-24

- `ORKESTRATOR_TEST_AREA_BASE=8454d18b8648d7482897c2544b538f0d915bc18c mise run test:logged -- --name merge-repository -- mise run test` repeated `codex reported an unexpected version: no output` after 163.04 ms. The toolchain package reported 90 passed and one failed across 91 tests (5.26 s), using two isolated workers alongside the other repository groups and nine component-browser workers on the shared macOS host, Bun 1.4.3.
- `mise run test:logged -- --name merge-toolchain-owner -- bun test --cwd packages/toolchain --preload ../../tests/setup-node.ts ./src/manager.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 5.2 s.
- Evidence: host temporary artifact `orkestrator-test-run.GCa83B/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. No implementation, assertion, timeout or skip changed; the original aggregate remains failed.

## 0247 consolidated-review fixes — 2026-10-27

- **Original command:** `mise run test:logged -- --name review-fix-suite -- mise run test`, standard 4/1/2/1 workspace/root/bridge/protocol reservations on the shared macOS host, Bun 1.4.4.
- **Observation:** the same unchanged case failed at 121.44 ms with `codex reported an unexpected version: no output`; toolchain reported 90 passed and one failed.
- **Owner rerun:** `mise run test:logged -- --name review-toolchain-owner -- bun test --cwd packages/toolchain ./src/manager.test.ts --parallel=1 --only-failures` passed unchanged in 2.5 s.
- **Evidence:** inner `orkestrator-test-run.S3DyLI/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`, outer `orkestrator-test-run.OHbyVm/review-fix-suite.log` under the host temporary directory (compressed on finalization).
- No toolchain implementation, assertion, timeout or skip changed; the aggregate remains failed.

# Toolchain version probe sometimes observes empty output

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

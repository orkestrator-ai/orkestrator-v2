# ACP package stops publishing output in the aggregate

- **ID:** 0262
- **Status:** open
- **Date observed:** 2026-10-16
- **Owner:** `bridges/acp-bridge` package suite (`test:bridge`); the aggregate output did not identify an individual active file.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` on `fix/coordinator-hosted-network-lockdown` while merging `origin/main`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on macOS arm64 with Bun 1.4.3. Each bridge used one isolated worker; a component browser suite also ran during the start of the aggregate.
- **Failure:** ACP printed the Bun test startup banner but no further output. After 300000 ms without bridge-group output, the no-progress watchdog terminated `acp-bridge#test:bridge`. The bridge group ended after 349.3 seconds, with four of five package tasks successful. The other four bridges reported zero failed tests. The aggregate exited 1 after 352.2 seconds; separate backend timeouts are recorded in 0162 and 0187. Root and protocol passed.
- **Isolated package rerun:** `mise run test:logged -- --name merge-acp-isolated -- bun run --cwd bridges/acp-bridge test:bridge` passed unchanged (exit 0) in 61.9 seconds, with the package script's default `--parallel=1`.
- **Evidence:** `/tmp/orkestrator-test-run.TpifY7/bridges.log.gz` and `summary.json`; outer artifact `/tmp/orkestrator-test-run.jvncxJ/merge-tests.log.gz`.
- **Assessment:** the unchanged package passing alone establishes an intermittent aggregate stall, but the absent file-level output does not establish its cause. No test, assertion, timeout, skip or production code changed.

- **Final aggregate rerun:** `mise run test:logged -- --name merge-tests-final -- mise run test` passed all four groups (exit 0, 277.5 seconds), including all five bridges (88.0 seconds). No tests, assertions, timeouts or skips changed.

## Merge-resolution prompt validation recurrence — 2026-10-22

- **Command:** `mise run test:logged -- --name merge-full -- mise run test`
  with the standard workspace/root/bridges/protocol allocation of 4/1/2/1 slots.
- **Failure:** ACP printed only its Bun startup banner. After 300000 ms without
  bridge-group output, the watchdog terminated `acp-bridge#test:bridge`.
  The bridge group ended after 385.2 seconds; the other four bridge packages
  passed. No active ACP owner file was identified in the output.
- **Isolated package rerun:** `mise run test:logged -- --name merge-acp-isolated -- bun run --cwd bridges/acp-bridge test:bridge`
  passed unchanged, exit 0 in 64.6 seconds, using the script's default
  `--parallel=1`.
- **Evidence:** `orkestrator-test-run.9S56xJ/bridges.log.gz` below the host
  temporary directory; outer artifact
  `orkestrator-test-run.JR9Bbt/merge-full.log.gz`.
- **Assessment:** recurrence of the recorded aggregate stall. Its cause remains
  unknown; no implementation, tests, assertions, timeouts or skips changed in
  the ACP package.
- **Confirmation:** `mise run test:logged -- --name merge-full-confirm -- mise run test`
  passed all four groups, exit 0 in 432.6 seconds; the bridge group passed
  in 109.2 seconds.

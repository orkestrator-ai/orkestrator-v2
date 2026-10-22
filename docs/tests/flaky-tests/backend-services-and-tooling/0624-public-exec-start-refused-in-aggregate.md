# Public exec start is refused in aggregate validation

- **ID:** 0624
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `environment.exec > reports the process's own exit status and keeps streams separate`
- **Owner:** `apps/backend/src/core/public-api/public-api-exec.test.ts:147`
- **Merge:** `origin/main` at `3cfc33fe` into `bf04abc7` on `qualify-preview-electron-remaining-cases-0a835a98d18e`.
- **Original command:** `mise run test`. Workspace/root/bridges/protocol groups reserved 4/1/2/1 workers; backend used two isolated Bun workers. Docker fixture and browser account checks also ran on the host.
- **Failure:** `started.ok` was false instead of true at line 147 (96.31 ms), before checking the command's output and exit code. The reason for the refusal is not established by this assertion.
- **Aggregate result:** exit 1 after 469.0 seconds. Backend reported 9,764 passed, 67 skipped, two failed and one between-test error across 9,833 tests in 551 files. The other failure was submodule recovery, recorded in [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md). Every other workspace package and the root, bridge and protocol groups passed.
- **Owning-file rerun:** `mise run test:logged -- --name preview-merge2-exec-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-exec.test.ts --parallel=1 --only-failures`.
- **Isolated result:** the entire unchanged owning file passed, exit 0 in 31.6 seconds. No assertion, timeout, skip or implementation changed.
- **Evidence:** `orkestrator-test-run.aIlmtw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Passing rerun retains its logged-runner summary only.
- **Assessment:** an intermittent aggregate failure is established; its cause remains unknown. Do not treat the owning-file pass as a passing aggregate.

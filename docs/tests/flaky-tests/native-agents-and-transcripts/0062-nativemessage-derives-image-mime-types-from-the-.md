# `NativeMessage > derives image mime types from the container attachment extension` (`tests/unit/components/NativeMessage.test.tsx`)

- **ID:** 0062
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group used four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The asynchronous two-preview case failed after 13,950.37 ms. Bun's retained failure payload expanded the React fiber/DOM object rather than preserving a concise matcher message.
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/components/NativeMessage.test.tsx 2>&1 | tee /tmp/orkestrator-native-message-isolated-acp-image-fixes.log` -> 93 passed, 0 failed, 296 assertions in 1.81 seconds; the affected case passed in 43.01 ms.
- **Hypothesis:** The case opens one asynchronous image preview, closes it through React, then opens a second. The same transitions completed immediately in a clean process, while the aggregate run was already experiencing severe process and renderer scheduling contention. The reviewed ACP fix changes bridge URL creation only; this root-level renderer test uses fixed `/workspace/...` paths and did not execute that code.

# OpenCode agent-tool background configuration timing

- **ID:** 0280
- **Status:** open

## Observation — 2026-10-17 (device-login main merge)

- **Test:** `OpenCode agent-tool configuration > reconciles in the background and memoizes a healthy generation`, in `apps/backend/src/core/commands-agent-tools.test.ts:174`.
- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test`, with system Python and the testing guide's GNU utilities preferred in PATH (Bun 1.4.3, macOS arm64).
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host. Backend used two isolated Bun workers.
- **Failure:** after the fixed 150 ms wait, `openCodeAgentToolsConfigurationCount()` was 1 instead of 0. The case took 166.45 ms.
- **Suite counts:** backend reported 8,840 passed, 41 skipped and one failed across 8,882 tests in 471 files (518.76 seconds). The workspace group finished with 12 successful tasks out of 13; root/support passed separately.
- **Owning-file rerun:** `mise run test:logged -- --name merge-agent-tools-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-agent-tools.test.ts --parallel=1 --only-failures`, with the same PATH preference, passed unchanged (exit 0) in 2.2 seconds while the bridge group was running.
- **Evidence:** `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YjH5CD/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer artifact `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.z4nMqJ/merge-tests.log.gz`.
- **Assessment:** the unchanged isolated pass establishes intermittence. The fixture delays its HTTP response by 75 ms and the assertion uses a fixed 150 ms wait; shared-host scheduling or HTTP latency is a plausible but unconfirmed cause. The merge conflicts were confined to flake documentation. No product code, assertion, timeout or skip was changed.

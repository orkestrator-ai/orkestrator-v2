# `download-claude.sh > downloads, extracts, probes, and cleans up on Darwin/x86_64` (`tests/unit/download-scripts.test.ts`)

- **ID:** 0061
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-full-tests-acp-image-fixes.log`
- **Worker configuration:** The root and agent-support group used four Bun workers while the workspace, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** `this test timed out after 15000ms` (duration: 15,772.04 ms).
- **Suite counts:** Root and agent-support group: 3,640 total, 3,632 passed, 1 skipped, 7 failed, and 2 between-test errors.
- **Isolated rerun:** `set -o pipefail; bun test ./tests/unit/download-scripts.test.ts 2>&1 | tee /tmp/orkestrator-download-scripts-isolated-acp-image-fixes.log` -> 33 passed, 0 failed, 158 assertions in 27.11 seconds; the affected case passed in 3,951.34 ms.
- **Hypothesis:** The case launches a shell download/extract/probe harness and exceeded only its outer wall-clock budget during a run with several other process-heavy groups. Its functional assertions completed more than eleven seconds inside that budget in isolation; no download or toolchain code changed in this work.

# `titles > a generated title is persisted for every tab sharing the thread` (`bridges/codex-bridge/src/app-server-runtime.test.ts`)

- **ID:** 0085
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log`
- **Worker configuration:** The bridge group ran `bun test bridges --parallel` while the workspace, root, and protocol-lockfile groups ran concurrently.
- **Failure:** The persisted session metadata assertion at `app-server-runtime.test.ts:6651` received additional current metadata fields instead of the expected partial object after the generated shared-thread title was written (duration: 76.07 ms).
- **Suite counts:** Bridge group: 2,383 total, 2,371 passed, 11 skipped, 1 failed across 67 files. Root/agent-support and the protocol lockfile passed; the backend workspace had two separate aggregate-only failures.
- **Isolated rerun:** `bun test ./src/app-server-runtime.test.ts --parallel` from `bridges/codex-bridge` -> 271 passed, 0 failed in 3.54 seconds; the target passed in 29.91 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-app-server-runtime.log`.
- **Hypothesis:** Another aggregate bridge test appears to have populated optional session metadata before this assertion read the shared persisted record. The isolated owner file preserves the expected partial state, but the available diff does not identify the cross-file writer, so no product assertion has been weakened.
- **Recurrence (ACP usage replay guard, 2026-08-16):** `bun run test:logged -- --name full-suite2 -- bun run test` failed it again at 146.22 ms; bridges group: 2,544 passed, 11 skipped, 1 failed. Isolated rerun `bun test bridges/codex-bridge/src/app-server-runtime.test.ts` -> passed in 4.2 s. The change under validation touches only `bridges/acp-bridge`, which shares no persisted metadata with the codex bridge, so the cross-file writer remains unidentified. Worth noting for the next investigation: the immediately preceding aggregate run of the same tree passed this file and failed an acp-bridge case instead, so which bridge test loses this race also varies between runs.

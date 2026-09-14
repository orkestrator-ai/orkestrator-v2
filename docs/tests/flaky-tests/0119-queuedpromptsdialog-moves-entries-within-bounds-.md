# `QueuedPromptsDialog > moves entries within bounds and removes by id` (`apps/web/src/components/chat/QueuedPromptsDialog.test.tsx`)

- **ID:** 0119
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun test --cwd apps/web src --parallel 2>&1 | tee /tmp/ork-fix-web-suite-final.log`
- **Worker configuration:** The web package ran `bun test src --parallel` (18 workers) while suites owned by other sessions ran concurrently in the same checkout.
- **Failure:** Reported as `(fail)` at 1,034.74 ms. Bun's buffered output for this run interleaved another file's `act(...)` warnings immediately after the failure line, so no matcher message was retained.
- **Suite counts:** Web package: 4,873 total, 4,870 passed, 1 skipped, 2 failed across 213 files in 132.19 seconds. The other failure is the deterministic `AgentNativeTab` case described in the entry above, which is not a flake.
- **Isolated rerun:** `bun test --cwd apps/web src/components/chat/QueuedPromptsDialog.test.tsx` -> 12 passed, 0 failed.
- **Pre-existing:** Unrelated to the reviewed PR-dialog change, which touches no prompt-queue code. The same file passed in the immediately preceding full run of the same tree.
- **Hypothesis:** No matcher message survived, so no cause is established. A recurrence should be captured with the owning file run alone under `--parallel` so the failure message is not interleaved, before any assertion is weakened.

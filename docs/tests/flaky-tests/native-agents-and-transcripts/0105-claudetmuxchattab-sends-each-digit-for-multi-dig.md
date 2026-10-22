# `ClaudeTmuxChatTab > sends each digit for multi-digit numbered confirmation options` (`tests/unit/components/ClaudeTmuxChatTab.test.tsx`)

- **ID:** 0105
- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun test tests --parallel=4`
- **Failure:** the expected `answerSelectionPrompt` call was not observed; React also reported updates outside `act` after the preceding prompt-restoration test timed out
- **Reproduction:** the exact test passed 20 of 20 isolated repetitions
- **Root cause:** no independent failure was reproduced. The failure occurred directly after the timed-out prompt-restoration test, whose unfinished work crossed the test boundary and contaminated the shared component mocks.
- **Fix:** the preceding test now completes deterministically and within tens of milliseconds. The multi-digit test remains independently covered and passes without changing its product assertion.
- **Verification:** the exact test passed 20 of 20 repetitions, the complete component file passed, and the root suite passed with zero failures.

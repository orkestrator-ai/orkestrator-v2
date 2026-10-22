# `ClaudeTmuxChatTab > restores a prompt when the backend re-observes it after key submission` (`tests/unit/components/ClaudeTmuxChatTab.test.tsx`)

- **ID:** 0104
- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun test tests --parallel=4`
- **Failure:** the test exceeded Bun's 5-second timeout
- **Reproduction:** 20 isolated repetitions passed, but each took approximately 3.5 to 4.3 seconds before the fix, leaving too little margin under parallel suite load
- **Root cause:** the test delivered the observation through an optional subscription handler without first proving that the subscription existed, then relied on a broad asynchronous DOM search to detect the result. That wait dominated the test and could outlive the test timeout under load.
- **Fix:** wait for the subscription explicitly, build the repeated observation before dispatch, require the handler to exist, dispatch synchronously inside `act`, and assert both the authoritative store snapshot and rendered prompt.
- **Verification:** 20 of 20 repetitions passed in approximately 22 to 92 ms; the complete component file passed 169 tests with 639 assertions.

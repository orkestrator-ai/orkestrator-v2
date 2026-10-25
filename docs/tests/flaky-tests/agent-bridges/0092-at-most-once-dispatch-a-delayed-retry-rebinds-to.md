# `at-most-once dispatch > a delayed retry rebinds to the replacement engine generation` (`bridges/codex-bridge/src/app-server-runtime.test.ts:3228`)

- **ID:** 0092
- **Status:** resolved
- **Date observed:** 2026-08-05, recurred 2026-08-06
- **Original command:** `bun test bridges --parallel` (aggregate bridge group: `bun test bridges --parallel=2`)
- **Suite counts:** 2,215 passed, 11 skipped, 1 failed
- **Failure:** the final transcript roles were expected to be `["user", "assistant"]` but were `[]`; failed duration 91.73 ms
- **Isolated rerun:** 260 passed, 0 failed with the target at 94.82 ms on the first attempt, but a later isolated run reproduced the failure directly (259 passed, 1 failed, the same assertion in 152.06 ms). This proved the flake was not merely cross-file contention.
- **Reproduction:** the exact test failed 8 of 20 runs before the fix.
- **Root cause:** The bridge appended an optimistic user/assistant exchange before dispatch. On the explicit `-32001` overload path `prompt()` awaited `journal.markRetryable()` and only then captured `context.messages`. A child restart during that await could detach the unmaterialized context, and detachment replaces `context.messages` with an empty array, so the replacement generation received an empty transcript even though the turn itself started once.
- **Fix:** Capture the optimistic message array before the first retry-path await, then wait again for generation recovery after the readiness-triggering re-attach and merge the retained messages into whichever replacement context became canonical. The regression test now gates the journal write and restarts the engine while it is stalled, deterministically exercising the generation race.
- **Verification:** `bun test bridges/codex-bridge/src/app-server-runtime.test.ts --test-name-pattern "a delayed retry rebinds to the replacement engine generation" --rerun-each 30` -> 30/30 passed; the complete runtime file passed 260 tests with 828 assertions.

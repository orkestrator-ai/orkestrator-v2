# `InitializationLogs > shows an initial failure and recovers on a later poll` (`apps/web/src/components/terminal/InitializationLogs.test.tsx:53`)

- **ID:** 0094
- **Status:** resolved
- **Date observed:** 2026-08-05, recurred 2026-08-06
- **Original command:** `bun run test` (workspace web group)
- **Suite counts:** 5,336 passed, 1 skipped, 1 failed across 216 files
- **Failure:** `TestingLibraryElementError: Unable to find an element with the text: container ready.` The component still showed `Waiting for container output...` at the one-second timeout; failed duration 1,023.55 ms
- **Isolated rerun:** `bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx` -> 7 passed, 0 failed; the target passed in 9.10 ms, and 33.76 ms when run by exact name
- **First root cause (2026-08-05):** the mock returned `"container ready"` for only one 5 ms polling cycle, so its default empty response could replace that transient state before Testing Library observed it. The exact test failed 1 of 20 runs.
- **First fix (2026-08-05):** keep returning `"container ready"` after the initial rejection, and restore the expected console-error spy in a `finally` block. 30 of 30 repeated runs passed afterwards.
- **Second root cause (2026-08-06):** the test still used a real five-millisecond interval and a one-second UI timeout to drive the recovery poll. Under aggregate load that timer was not a deterministic signal that the second mocked request had run and committed its React update.
- **Second fix (2026-08-06):** intercept only the component's five-millisecond interval, capture its poll callback, and invoke that callback inside `act`. Other timers, including Testing Library's own, continue using the real implementation.
- **Verification:** `bun test --cwd apps/web src/components/terminal/InitializationLogs.test.tsx --test-name-pattern "shows an initial failure and recovers on a later poll" --rerun-each 20` -> 20/20 passed; the owning file passed all 7 tests.

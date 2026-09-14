# `Electron backend command registry > starting a stopped environment resumes backend PR polling` (`tests/unit/electron/commands.test.ts`)

- **ID:** 0099
- **Status:** resolved
- **Date observed:** 2026-08-06
- **Original command:** `bun run test` (root group: `bun test tests --parallel=4`)
- **Failure:** `expect(received).toContain(expected)` on the resumed polling assertion; failed duration 472.36 ms
- **Isolated rerun:** `bun test tests/unit/electron/commands.test.ts` -> 362 passed, 0 failed, twice consecutively; the target also passed when run alone with `-t`
- **Root cause:** The assertion waited only for the fake `gh` log file to exist. Starting the environment can create that file with an earlier `pr list` discovery call, so the wait could return before the explicitly requested `pr view` check had appended its command; the immediate content assertion then raced the monitor.
- **Fix:** Wait for the exact `pr view <url> --json url,state,mergeable` line that the test is intended to prove rather than using file existence as a proxy.
- **Verification:** The resumed-poll test and the diff-cache test shared a 20-repetition owning-file stress command: 40 passed, 0 failed in 9.73 seconds. The resumed-poll case completed in 122-207 ms in the retained output.

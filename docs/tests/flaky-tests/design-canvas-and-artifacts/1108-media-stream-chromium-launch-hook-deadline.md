# Streamed media in Chromium: the browser-launch hook exceeds five seconds

- **ID:** 1108
- **Status:** open
- **Date observed:** 2026-10-25 (first, in [0825](../aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md)); owner case added 2026-10-27
- **Test:** `streamed media in Chromium > (unnamed)` — Bun's name for the suite's `beforeAll` hook, which launches headless Chromium with `chromium.launch`. The suite's one test, `an application page plays and seeks a ranged media capability on the content origin`, then does not run.
- **Owning file:** `apps/backend/src/core/transcript-artifacts/media-stream.browser.test.ts`
- **Earlier aggregate sightings (no owner case until now):**
  - [0694](../aggregate-validation-runs/0694-command-handover-validation.md): "Chromium hook exceeded five seconds"; not rerun.
  - [0801](../aggregate-validation-runs/0801-per-machine-accounts-validation.md): 5,007.24 ms; the owner passed alone.
  - [0825](../aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md): 5,004.69 ms in `mise run test` (backend 11,010 passed, 79 skipped, 5 failed); the owner passed alone with `--parallel=1`.
- **Latest sighting:** the 0247 acceptance verification (2026-10-27) ran `mise run test` on branch `test-temp-directory-4cd0548cf2b5-r1` at `90c9e205a`, macOS 27.0 arm64, Bun 1.4.4, checkout on an external volume, default group reservations. Its report gives the hook as timing out at 5,004 ms in the aggregate, and the owner passing alone on both the branch and `origin/main` at `863b57821`. Its artifact names were not handed over; the numbers here are as reported.
- **Isolated reruns (this record):** `mise run test:logged -- --name media-stream-owner-0247 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/transcript-artifacts/media-stream.browser.test.ts` at `90c9e205a` passed three times (`media-stream-owner-0247`, `-r2`, `-r3`: 1.5 s, 2.7 s, 1.6 s) at host load average 173 to 217, with other worktrees running suites. A plain `bun test` of the same file reported 1 pass, 14 `expect()` calls, so Chromium was found and the test ran rather than being skipped.
- **Hypothesis:** launching Chromium competes with the aggregate's other browser suites and Git-heavy fixtures on a contended host, and the launch sits under Bun's default five-second hook budget. Not established; the hook was never timed in a passing aggregate run.
- **Changes:** evidence only; no assertion, timeout or skip was changed. The branch does not change this test file or the launch; its only change nearby is `TranscriptMediaStreams.dispose()` awaiting its staging root (0247), which is teardown, after the hook. The hook timed out the same way on other branches in 0694, 0801 and 0825, before 0247 existed.
- **Next step:** if it recurs, time the `chromium.launch` call in the aggregate; an explicit launch budget like other Chromium suites use would be the fix to weigh, not a skip.

# DesignRenderer with real Chromium > a killed backend's browser profile is removed by the next startup sweep (0248)

- **ID:** 2403
- **Status:** resolved
- **Test:** `DesignRenderer with real Chromium > a killed backend's browser profile is removed by the next startup sweep (0248)`
- **File:** `apps/backend/src/core/design/renderer.test.ts`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test:slow, run alongside the Electron suite` after 12823.83 ms, with the host at a load average near 55. Failed under heavy load. The owner then passed alone (0 fail):

```sh
cd apps/backend && bun test ./src/core/design/renderer.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.

### Investigation — 2026-11-06

- The reported 12,823 ms equals a Chromium launch of about 2.8 s at load 55 plus the test's 10 s `waitFor(() => !processAlive(browserPid), 10_000)`. That suggests Chromium's own shutdown, after its launcher was SIGKILLed, outlasted the 10 s poll. Chromium's shutdown is not what the test is about. The poll is now 60 s, within the test's existing 120 s `COLD_START_MS` budget. `mise run test:logged -- --name n2403-renderer -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/renderer.test.ts -t "killed backend" --rerun-each=5` passed 5 of 5. The original failure message was not recorded, so the cause is not confirmed and the status stays open.

## Resolution (2026-11-15)

- **Class:** wall-clock poll on a real signal (B), fixed by the 2026-11-06 change above.
- **Root cause (inferred from the duration, as the investigation recorded):** about 2.8 s of Chromium launch plus the former 10 s `waitFor(() => !processAlive(browserPid), 10_000)`. Chromium's shutdown after its launcher was SIGKILLed outlasted the 10 s poll on a loaded host. That shutdown is not what the test checks.
- **Fix:** the wait is still for the real signal, the browser process gone. Its bound is 60 s, a hang watchdog inside the test's 120 s `COLD_START_MS`. The test waits for the fixture's `ready` line before reading the ledger, and the profile and sweep assertions are unchanged. The file sets no smaller default.
- **Reproduced:** no; the original message was not recorded.
- **Stress:** `mise run test:logged -- --name c2403 -- bun scripts/test-under-contention.ts --core 11 --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design/renderer.test.ts -t "killed backend" --rerun-each=5` passed (44.6 s).

## Recurrence (2026-11-19)

- **Where:** CI `main` push run 44532412670 at `5961e3a35` (#2471), job
  `Tests (backend)`, 847.20 ms. `mise run flaky:recurrence -- 2403 --base 5961e3a35`
  reported a real recurrence: the base contains the 2026-11-06 fix.
- **Failure:** `TypeError: The "paths[1]" property must be of type string, got undefined`
  at `renderer.test.ts:951`. The fixture had printed `ready`, but the ledger
  directory held no `.json` record, so `recordName` was undefined. This is a
  different mode from the original slow browser shutdown.
- **Isolated rerun:** the unchanged test passed alone on macOS.

## Resolution (2026-11-19)

- **Class:** test read before an asynchronous write it does not wait for.
- **Root cause:** `DesignRenderer` starts the profile ledger write
  (`gen.profileRecord = this.profiles?.record(...)`, `renderer.ts`) without
  awaiting it before the render completes; only termination awaits it. The
  fixture prints `ready` once `run()` resolves, so on a loaded host the test
  could list the ledger directory before the record's write and rename.
- **Reproduced:** with a temporary `await Bun.sleep(1500)` before the ledger's
  `writeFile` (`browser-profiles.ts`, reverted), the unchanged test failed
  with the same `TypeError` in 486 ms.
- **Fix:** the test waits up to 10 s for a `.json` record before reading it.
  With the same injected delay the fixed test passed. The product behaviour is
  unchanged: the ledger exists for a later backend's startup sweep, which does
  not depend on the record landing before the render answers.

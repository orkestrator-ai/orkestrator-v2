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

# OpenCode 2.x launch live test picks a port already in use

- **ID:** 9974
- **Status:** resolved
- **Date observed:** 2026-11-11
- **Base commit:** 498b68766f5c9f357a3a86782406d1e9e0977559, branch opencode-event-stream-a3166ed90bb0-r1.
- **Test:** a launched 2.x server loads only root's plugins, applies its start environment and hides its password.
- **File:** apps/backend/src/core/opencode2/opencode2-launch.live.test.ts (the same pattern in apps/backend/src/core/opencode2/opencode2-package-cache.live.test.ts).
- **Original command:** `RUN_LIVE_OPENCODE2=1 OPENCODE2_CLI_PATH=<copy of the pinned 2.2.6 linux-x64 binary> bun test src/core/opencode2/opencode2- --parallel=1` from `apps/backend` (the `verify:opencode2:live` set).
- **Worker configuration:** one worker; Linux x64 (beelink2), 2.2.6 binary, scripted loopback model, no credentials.
- **Failure:** `expect(ready).toBe(true)` received `false` after 30,250.97 ms. Suite counts: 32 pass, 1 fail, 33 tests across 14 files (94.64 s). An earlier run of the same set passed.
- **Isolated rerun:** the file alone, in four loops that each stopped at their first failure, failed on run 3, run 2, run 5 and run 8, so it is not caused by load from the rest of the set.
- **Root cause:** a test bug. The test chose `39_000 + Math.floor(Math.random() * 1_000)` as the server's port. With its stderr captured, the failing run showed `opencode serve` exiting with code 1: `Failed to start server. Is port 39886 in use?`. The port belonged to something else on the host. The readiness loop kept polling for its full 30 s budget after the server had already exited. The package-cache live test used the same pattern (`40_000 + random`).
- **Fix:** both tests start their server through `startOpenCode2OnFreePort` (`apps/backend/src/core/opencode2/live-server.test-support.ts`). It takes an OS-chosen port for each attempt, sends the server's stderr to a file, stops waiting as soon as the server exits, and wraps the whole start in `retryOnAddressInUse` (`@orkestrator/protocol/testing/ports`): a port taken between choosing and binding ("Is port N in use?" on stderr, put at the front of the error) costs a retry with a fresh port, and any other failure is reported at once with the end of stderr. `opencode serve` must be given its port, so the gap itself cannot be closed. A first version that only took an OS-chosen port was refused by the `released-port-rebind` source guard for exactly that gap. Product code is unchanged.
- **Verification:** both files together passed 10 of 10 runs with the OS-chosen port, then 8 of 8 with the retrying helper (`for i in $(seq 1 8); do RUN_LIVE_OPENCODE2=1 OPENCODE2_CLI_PATH=… bun test src/core/opencode2/opencode2-launch.live.test.ts src/core/opencode2/opencode2-package-cache.live.test.ts; done` from `apps/backend`). A port collision cannot be forced on demand; the retry trigger was checked by feeding the captured stderr through the error message to `isAddressInUseError`, which accepts it.
- **Disposition:** resolved.

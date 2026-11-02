# DesignRenderer with real Chromium > a killed backend's browser profile is removed by the next startup sweep (0248)

- **ID:** 2403
- **Status:** open
- **Test:** `DesignRenderer with real Chromium > a killed backend's browser profile is removed by the next startup sweep (0248)`
- **File:** `apps/backend/src/core/design/renderer.test.ts`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test:slow, run alongside the Electron suite` after 12823.83 ms, with the host at a load average near 55. Failed under heavy load. The owner then passed alone (0 fail):

```sh
cd apps/backend && bun test ./src/core/design/renderer.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.

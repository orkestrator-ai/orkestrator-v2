# Electron backend command registry > backend-owned diff statistics > serves the Files panel from the scan the badge already ran

- **ID:** 2404
- **Status:** open
- **Test:** `Electron backend command registry > backend-owned diff statistics > serves the Files panel from the scan the badge already ran`
- **File:** `apps/backend/tests/commands-integration.test.ts`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test:slow, run alongside the Electron suite` after 1228.22 ms, with the host at a load average near 55. Failed under heavy load. The owner then passed alone (0 fail):

```sh
cd apps/backend && bun test ./tests/commands-integration.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.

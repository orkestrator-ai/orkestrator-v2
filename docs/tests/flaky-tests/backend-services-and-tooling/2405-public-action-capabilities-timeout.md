# public_action contract > capabilities reports the package version without launcher metadata

- **ID:** 2405
- **Status:** open
- **Test:** `public_action contract > capabilities reports the package version without launcher metadata`
- **File:** `apps/backend/src/core/public-api/public-api-projects.test.ts`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test:slow, run alongside the Electron suite` after 5012.96 ms, with the host at a load average near 55. Hit the 5 s timeout under heavy load. The owner then passed alone (0 fail):

```sh
cd apps/backend && bun test ./src/core/public-api/public-api-projects.test.ts --preload ../../tests/setup-node.ts --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.

# root-change approval handles over-limit and still permits rejection

- **ID:** 2402
- **Status:** open
- **Test:** `root-change approval handles over-limit and still permits rejection`
- **File:** `apps/web/src/components/federation/node-action-requests.test.tsx`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test` after 6861.01 ms, with the host at a load average near 55. Exceeded its time in the workspace group. The owner then passed alone (12 pass, 0 fail):

```sh
cd apps/web && bun test src/components/federation/node-action-requests.test.tsx --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.

# Background read flags assertion races the capability check

- **ID:** 4963
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `useNativeAgentSession background read flags > a background read before any authoritative state still reports connecting`
- **File:** `apps/web/src/hooks/useNativeAgentSession.background-flags.test.tsx`
- **Original command:** the aggregate `mise run test` of the E2 measurement rows pipeline recorded this test as failing; the verification record names the failure and does not carry that run's worker configuration or suite counts.
- **Failure:** `expect(result.current.sessionStateRefreshing).toBe(true)` received `false` (5 to 20 ms), in focused reruns on a shared host: `/tmp/orkestrator-test-run.TmGz5N/rework-flags-test-1.log.gz` and `/tmp/orkestrator-test-run.CL9yU4/rework-flags-test-3.log.gz`, both from another worktree's pipeline on 2026-11-04.
- **Owning file rerun:** `NODE_ENV=test mise run test:logged -- --name e2-fix-flags -- bun --cwd=apps/web test ./src/hooks/useNativeAgentSession.background-flags.test.tsx --parallel=1 --only-failures` passed unchanged, seven times out of seven on 2026-11-05.

## Root cause and fix

`refresh` raises `isRefreshing` before `await nativeAgentProgressiveSupported()` and `sessionStateRefreshing` after it (`beginSessionStateRefresh`). The test waited for the first flag alone, and `isRefreshing` already starts `true` for an enabled session, so the wait could return before the capability check settled. The second assertion then read the flag too early. The hook behaved correctly; only the test's ordering was wrong.

The fix waits for both flags in the same `waitFor`. The read is still held open by its gate, so the test still proves both flags rise before any authoritative state exists.

## Verification

- A temporary copy whose capability read waited 60 ms failed the old assertion with the same `Expected: true`, `Received: false`, and passed with the fix. The copy was deleted.
- After the fix, the owner ran 20 times in rounds of four concurrent copies, each round alongside four concurrent runs of `machine-sign-in-routing.test.tsx`. All 40 runs passed.

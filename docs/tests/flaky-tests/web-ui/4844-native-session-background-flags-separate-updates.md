# Native session flag test reads the second flag too early

- **ID:** 4844
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `useNativeAgentSession background read flags > a background read before any authoritative state still reports connecting`
- **File:** `apps/web/src/hooks/useNativeAgentSession.background-flags.test.tsx`
- **Original command:** CI `mise run test:full`, the workspace shard, once on `main` at
  `fc92a2de9` (run 41877867440): line 396, `Expected: true`, `Received: false`, 16.46 ms.
- **Isolated rerun:** not run before the fix. With the fix, the file alone passed 8 of 8 on macOS.

## Cause

Inferred from the code; the failure was not reproduced locally. `isRefreshing` starts true
for an enabled session and `sessionStateRefreshing` is set separately, so `waitFor` on the
first could return before the second was set.

## Fix

On `investigate-ci-f07d88911341-r1`, one `waitFor` covers both flags. A gate holds the request in flight, so the
test still proves both are raised during the read.

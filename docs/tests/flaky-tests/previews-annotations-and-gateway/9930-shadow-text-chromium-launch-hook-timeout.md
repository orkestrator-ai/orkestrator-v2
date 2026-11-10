# Shadow-root text selections: Chromium launch hook timeout

- **ID:** 9930
- **Status:** open
- **Date observed:** 2026-11-10

Test: `text selections in an isolated world, in Chromium > (unnamed)` (the
suite's `beforeAll`) in
`apps/desktop/tests/browser-preview-shadow-text.integration.test.ts`.

No existing index entry matched this test; this records a new case, not a
counted recurrence.

## Observation

- **CI run:** 42811683701, job `Tests (workspace)` (129814554128), branch
  `archive-resume-picker-0a25d81b2fed-r1`, head `cbacc3f2`, merge base with
  `main` `57b944e3`.
- **Original command:** `mise run test:full` (the CI shard step, slow tier
  included; this file is slow by its `*.integration.test.ts` name).
- **Failure:** `Test "(unnamed)" timed out after 60000ms`, 60,000.61 ms. The
  hook launches Chromium, opens a page and a CDP session, under a 60 s budget.
  No test in the file ran. The only failing group in that run was the
  workspace group (891.6 s); the desktop package's per-test totals were not
  in the retained log and are not inferred.

## Isolated rerun

The unchanged owner passed alone on Linux at `2aad83a37`, exit 0, 6.3 s
(passing output removed; counts not retained):

```sh
mise run test:logged -- --name shadow-text -- bun --cwd=apps/desktop test ./tests/browser-preview-shadow-text.integration.test.ts --preload ../../tests/setup-node.ts --parallel=1
```

## Assessment

A one-off: the hook normally completes in a few seconds, so a 60 s stall
points at the launch or first navigation under aggregate load rather than at
the test's assertions. Cause unconfirmed. No budget, assertion or retry was
changed for this record.

## Next evidence

If it recurs, add content-free phase markers (launch, new page, route,
CDP session) to the hook to identify which step stalls before changing the
budget.

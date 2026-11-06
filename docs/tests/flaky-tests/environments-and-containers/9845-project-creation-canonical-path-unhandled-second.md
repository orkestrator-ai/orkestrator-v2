# Project creation by canonical path: the second request's rejection was unhandled

- **ID:** 9845
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `create_project_from_scratch > serializes two requests for the same canonical path`
- **File:** `apps/backend/src/core/commands-project-creation.test.ts:1644`
- **Original command:** the `Tests (backend)` shard of `CI` on `main`
  (`mise run test:full` with `ORKESTRATOR_TEST_GROUPS=backend`), run
  42226422192, job 127920967194, commit `fa06f5c1f`.

## Failure

The test failed after 106.73 ms at `await expect(first).resolves`, with
`A project already uses this local path: /tmp/…/alias/shared`. That path is the
second request's, not the first's. 1 failure in the 10 failing `main` CI runs
checked on 2026-11-06.

## Root cause and fix

The same as [case 3670](3670-add-project-same-path-clone-serialization.md):
`second` had no handler until after `first` settled, so its rejection could
arrive unhandled. The fix observes `second` as soon as it is created. See
case 3670 for the change and the local stress result, which did not reproduce
the failure on an idle host.

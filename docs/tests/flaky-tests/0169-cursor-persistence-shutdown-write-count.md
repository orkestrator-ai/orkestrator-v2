# Cursor persistence shutdown write count varies in the full suite

- **ID:** 0169
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `dispatch around the write queue > shutdown racing a settling run has one writer, no unhandled rejection and a valid final file`
- **File:** `bridges/cursor-bridge/src/persistence-durability.test.ts:501`
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test` on commit `6449cc3a`. The bridge is unchanged by this commit. Another checkout was running its repository suite on the same host.
- **Failure:** `expect(hold.writes()).toBe(2)` received `3`. The bridge group had 667 passing tests and this one failure; the workspace, root and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name cursor-persistence-isolated -- bun test ./bridges/cursor-bridge/src/persistence-durability.test.ts --parallel=1 --only-failures` passed.

## Current assessment

The shutdown test depends on the number of queued persistence writes observed after a run settles. The aggregate and isolated results differ. The bridge was not changed in this task; investigate the write scheduling and assertion before marking this resolved.

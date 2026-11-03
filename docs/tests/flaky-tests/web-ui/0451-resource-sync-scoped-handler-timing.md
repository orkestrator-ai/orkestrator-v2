# Scoped resource handler completion timing in the aggregate suite

- **ID:** 0451
- **Status:** open
- **Date observed:** 2026-10-18
- **Test:** `scoped resource reconciliation > delivers scoped changes and waits for asynchronous handlers`
- **File:** `apps/web/src/lib/resource-sync.test.ts:953`
- **Original command:** `mise run test:logged -- --name merge-full -- mise run test`, with the testing guide's GNU-tool PATH, on the design live-cycle branch merged with `origin/main` at `c85ab60a`.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 workers, alongside browser validation on the shared macOS host.
- **Failure:** after `tick(30)`, `completed` was `[]` instead of `["project-1"]`; the manifest loader had been called once. The case took 33.36 ms.
- **Owning-file rerun:** `mise run test:logged -- --name merge-unit-owner-resource-sync -- bun test --cwd apps/web ./src/lib/resource-sync.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 3.4 seconds logged.
- **Evidence:** `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent timing failure. The test waits a fixed 30 ms for a handler that itself waits 10 ms; shared-host scheduling contention is a hypothesis. No implementation, assertion, timeout or skip changed.

## Recurrence, 2026-11-03

`mise run test:logged -- --name full-default-2 -- mise run test` on branch
`debug-ci-failures-a629816c8619-r1` (16-core Linux host, queued behind another
worktree's aggregate run, so the workspace group took 1,019 s against about
245 s for the previous run that day) repeated this failure (44.43 ms). The unchanged
owner then passed alone: `bun --cwd=apps/web test src/lib/resource-sync.test.ts --parallel=1`.

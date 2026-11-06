# Background read flags before authoritative state under load

- **ID:** 5104
- **Status:** resolved
- **Date observed:** 2026-11-04
- **Test:** `useNativeAgentSession background read flags > a background read before any authoritative state still reports connecting`.
- **File:** `apps/web/src/hooks/useNativeAgentSession.background-flags.test.tsx:396`.
- **Original command:** `mise run test`, the default aggregate suite, on a host with a load average of about 40 from other agents' work.
- **Worker configuration:** the aggregate's default workspace worker allocation.
- **Failure:** `expect(result.current.sessionStateRefreshing).toBe(true)` received `false`, 13 ms into the test, straight after `waitFor` saw `isRefreshing` become true.
- **Suite counts:** web 12,386 passed, 3 failed; backend 14,982 passed, 2 failed.
- **Owning-file rerun:** `bun --cwd=apps/web test src/components/chat/rich/ArtifactPdf.test.tsx src/hooks/useNativeAgentSession.background-flags.test.tsx --parallel=2 --only-failures`, repeated six times under the same load: five passed, and one failed this same case with 14 passed. A file rerun alone is therefore not reliably green under load.
- **Evidence:** the aggregate log was not retained past the run; the excerpt above is its content.
- **Hypothesis:** the assertion reads the second flag once, immediately after waiting on the first, so it depends on both flags being observed in the same commit. Not confirmed. The change under test at the time (the static HTML presentation) does not touch this hook. It was not rerun against an unmodified baseline.

### Resolution — 2026-11-06

- **Stale:** already fixed by `55f5bcb64` (2026-11-05, `feat(change-tracking): add measurement rows (#1777)`). That commit moved the `sessionStateRefreshing` read into the same `waitFor` as `isRefreshing`, because the two flags are raised on either side of the capability check and can commit separately. `4f7ca8231` (#1789) then updated only the comment. Every recorded failure (2026-11-04) predates the fix.
- **Verification:** `mise run test:logged -- --name n5104-flags -- bun --cwd=apps/web test src/hooks/useNativeAgentSession.background-flags.test.tsx --rerun-each=30` passed 210 tests with 0 failures, at a load average of about 30. No change in this round.

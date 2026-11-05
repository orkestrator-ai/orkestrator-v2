# Background read flags before authoritative state under load

- **ID:** 5104
- **Status:** open
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

# Application logging shutdown deadline fails under load

- **ID:** 0712
- **Status:** open
- **Date observed:** 2026-10-23
- **Test:** `application logging shutdown > quits anyway when the flush outlives its deadline`
- **File:** `apps/desktop/electron/application-logging.test.ts`
- **Original command:** the workspace group of `mise run test` (`bunx turbo run build test:workspace … --concurrency=3`, `ORKESTRATOR_TEST_WORKERS=3`), run directly while other worktrees held the machine at a load average of about 70.
- **Failure:** failed after 68 ms; `fixture tree digest > names every class of change a coordinator could make` (0258) also timed out in the same run.
- **Isolated rerun:** `bun test ./electron/application-logging.test.ts` from `apps/desktop`: 25 pass, 0 fail.
- **Assessment:** a deadline-based test sensitive to scheduler delay; unconfirmed.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 1.4 s: `mise run test:logged -- --name design-links-owner-desktop-logging -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./electron/application-logging.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the cases use fixed sleeps: 60 ms for a 10 ms deadline at `application-logging.test.ts:450`, and 5 ms after resolving the stop at line 427. The sibling `holds the quit open until the flush completes, then quits once` failed in [0720](../aggregate-validation-runs/0720-mcp-environment-delivery-validation.md) (73.4 ms) and [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) (26.13 ms); this case covers both. The owner passed alone today (25/25, 5.2 s; Bun 1.4.4).
- **Next step:** poll (bounded) for `quitCount === 1` instead of the fixed sleeps.

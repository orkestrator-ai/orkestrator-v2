# Preview transport attachment release under aggregate load

- **ID:** 0790
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `PreviewTransportManager (desktop tunnel end to end) > hiding does not close the listener; the last release retires it and frees the attachment`
- **File:** `apps/desktop/tests/preview-transport-manager.test.ts`
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`
- **Failure:** After the 120 ms wait, services had retired but the invoke list still contained only `create_preview_attachment`; `release_preview_attachment` had not arrived.
- **Isolated rerun:** `mise run test:logged -- --name desktop-transport-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-transport-manager.test.ts --parallel=1 --only-failures` passed (1.0 s), with the owning file unchanged.
- **Context:** Tool-group folding validation; concurrent aggregate suites were active in other worktrees. This change does not modify the failing desktop code or tests.
- **Hypothesis:** A fixed timer wait can expire before asynchronous attachment release completes under shared host load. No assertions were weakened or skipped.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** recurred on 2026-10-25 in [0815](../aggregate-validation-runs/0815-container-rebuild-state-validation.md) (load 54 to 65). The owner passed alone there and today (20/20, 3.3 s; Bun 1.4.4). The fixed `Bun.sleep(120)` is still at `preview-transport-manager.test.ts:349`.
- **Next step:** poll (bounded) for `release_preview_attachment` instead of the fixed wait.


## OpenCode review-fix validation recurrence — 2026-10-26

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test` at `2015359f9`, standard 4/1/2/1 group reservations with two desktop workers.
- **Failure:** the invoke list still contained only `create_preview_attachment` at line 351 after the fixed wait; duration 295.42 ms.
- **Suite counts:** desktop 1,320 passed, 14 skipped, one failed across 91 files (41.42 seconds).
- **Unchanged owner rerun:** `mise run test:logged -- --name preview-owner-rerun -- bun test --cwd apps/desktop ./tests/preview-transport-manager.test.ts --parallel=1 --only-failures` passed, exit 0 in 1.1 seconds.
- **Evidence:** aggregate commands, worker context and artifact paths are in [0978](../aggregate-validation-runs/0978-opencode-undo-validation-backend-timeouts.md). The fixed wait under shared host contention remains the suspected cause; no preview implementation, assertions, waits or skips changed.

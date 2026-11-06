# Preview transport attachment release under aggregate load

- **ID:** 9887
- **Status:** resolved
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
- **Recurrence (2026-11-01):** in `mise run test` on branch `shared-logger-foundation-and-electron-r1-slice-1-2a438948d729` based on `066fcb497`, host load averages about 29 to 38: `expect(invoked).toContain("release_preview_attachment")` failed at `tests/preview-transport-manager.test.ts:351` with only `create_preview_attachment` recorded. The owner passed alone, and five more times beside the annotation script owner (`--parallel=2`).


## Task 1202 background-work review repair — 2026-11-02

The exact default-suite retry used `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1
mise run test:logged -- --name address-default-suite-concurrent -- mise run test`
with workspace/root/bridge/protocol grants of 6/1/2/1. The ordinary retry was
cancelled while queued behind another worktree; the documented concurrency
option admitted all groups. Original preparation artifacts were preserved.
Aggregate evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.WXZCOJ/`
(group logs; compressed on failure), outer log in `orkestrator-test-run.Vufyx3`.

The release invocation was absent after the fixed wait (312.09 ms).
`mise run test:logged -- --name address-desktop-preview-rerun -- bun test --cwd apps/desktop ./tests/preview-transport-manager.test.ts --parallel=1 --only-failures`
passed the unchanged owner (7.5 s). Detached main at `38d55ee14`, with its own
frozen install, passed 20 repeats (`address-main-preview`, 10.8 s). These passes
do not establish the failure's independence from the branch.

Final aggregate counts: desktop 1,580 pass / 16 skip / 2 fail; backend
13,138 pass / 97 skip / 3 fail; web 11,230 pass / 10 skip / 7 fail; root
3,418 pass / 3 fail. Bridges and Codex protocol verification passed.
The aggregate exited 1 after 1,152.1 seconds; no watchdog or output limit fired.

### Resolution — 2026-11-06

**Root cause.** A fixed `Bun.sleep(120)` raced asynchronous teardown.
`retire()` removes the service from `stats()` at once, then awaits
`closeGroup()` and only then invokes `release_preview_attachment`. On a loaded
host the 120 ms ran out between those steps, which is exactly the recorded
state (services 0, invoke list holding only `create_preview_attachment`).

**Reproduced.** A temporary copy of the unchanged test with the wait cut to
51 ms (just past the 50 ms retirement lease) failed 1 of 20 with the exact
recorded message (`Expected to contain: "release_preview_attachment"`,
received `[ "create_preview_attachment" ]`).

**Fix.** `apps/desktop/tests/preview-transport-manager.test.ts` polls (5 ms
steps, 3 s bound) until the release has been invoked and the access registry
reports no attachments, then keeps every original assertion. The earlier
80 ms wait after hiding one tab stays: it is a negative check that the
listener is not retired while another tab holds it.

**Verification.** `NODE_ENV=test mise run test:logged -- --name ptm-fix-rerun -- bun test --cwd apps/desktop --preload ../../tests/setup-node.ts ./tests/preview-transport-manager.test.ts -t "buffered ingress metrics|hiding does not close" --rerun-each=20`: PASS (40 of 40).

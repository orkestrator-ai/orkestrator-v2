# Pi default-model validation: backend and root timeout cluster

- **ID:** 0694
- **Status:** open
- **Date observed:** 2026-10-23.
- **Baseline:** `062971245`, with the 0054 Pi default-model change in the working tree (Pi bridge model resolution, `host-agent-credentials.ts` and their tests).
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Workers:** default aggregate allocation. The checkout is on an external volume (`/Volumes/Lexar`), and other worktrees were active on the host. Contention is a hypothesis, not an established cause.
- **Aggregate result:** exit 1 in 803.1 s. Workspace and root groups failed; bridges and the Codex protocol lockfile passed. Backend reported 9,559 passed and six failed; root reported 3,369 passed, two failed and one error. Web, desktop, protocol, toolchain, web-public and CLI packages had no failures.
- **Original evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.krCZIW/` (compressed group logs), outer `orkestrator-test-run.31zvsA`.

## Failures and complete owner reruns

None of the failing owner files, or the code they test, is touched by the change. Every failure was a test exceeding its five-second budget (5,002–6,496 ms), or, in `disk-report`, a child whose status was null.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/backend/src/core/public-api/public-api-projects.test.ts` | `settings > partial edits preserve unrelated fields and conflict on stale revisions` and `settings > rejects unknown keys, bad types and null-as-unset` timed out. | Passed (combined backend rerun below). |
| `apps/backend/src/core/storage-agent-mail.test.ts` | `refuses a mailbox whose 200-message backlog has no settled eviction candidate` timed out. | Passed. |
| `apps/backend/src/core/terminal-history.test.ts` | `pages fixed history backwards and rejects a cursor for another history` timed out. | Passed. |
| `apps/backend/src/core/environment-move.test.ts` | `a failed submodule re-link restores the original checkout` and `restart recovery re-links submodules of an adopted or abandoned copy` timed out. | Passed. |
| `tests/unit/runtime-env-wiring.test.ts` | `Grok setup copies portable inputs while leaving its runtime home writable` timed out. | Passed. |
| `tests/unit/disk-report.test.ts` | Child status was null and the case timed out. | Passed. |

The backend owners were rerun together with
`bun test --preload ../../tests/setup-node.ts <four files> --parallel=2` from `apps/backend`: 137 passed, 0 failed. The root owners passed under
`mise run test:logged -- --name rerun-root -- bun test tests/unit/runtime-env-wiring.test.ts tests/unit/disk-report.test.ts --parallel=2` (7.0 s). No timeout, assertion or skip was changed.

Existing related cases: [environment move 0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [disk report 0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md), [agent mail backlog 0661](../coordinator-and-multi-review/0661-agent-mail-backlog-aggregate-timeout.md), [terminal history 0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md), [backend deadline cluster 0442](../backend-services-and-tooling/0442-backend-aggregate-probe-and-deadline-cluster.md) and [sidebar validation 0692](0692-sidebar-collision-validation.md).

## Second observation: after the Multi Review fixes

- **Date observed:** 2026-10-23.
- **Baseline:** `369be1653` (the branch after the Multi Review fixes, clean tree).
- **Original command:** `mise run test:logged -- --name full-tests-3 -- mise run test`.
- **Aggregate result:** exit 1 in 988.7 s. Only the workspace group failed, and within it only backend (four failures). Root, bridges and the Codex protocol lockfile passed; web, desktop, protocol, toolchain, web-public and CLI had no failures.
- **Original evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.bxLcow/`, outer `orkestrator-test-run.GlEiqX`.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/backend/src/core/terminal-history.test.ts` | `normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages` timed out (5,009.71 ms). | Passed. |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | `executable document policy in firefox > popups, new-window links and top navigation reach the sink zero times` timed out (11,396.84 ms). | Passed. |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | `the external watchdog ends a blocked render within the deadline and the browser is gone` timed out (5,621.97 ms). | Passed. |
| `apps/backend/src/core/environment-move.test.ts` | `moves a worktree with nested submodules (same disk)` timed out (5,057.24 ms). | Passed. |

The four owners were rerun together from `apps/backend` with `bun test --preload ../../tests/setup-node.ts <four files> --parallel=1`: 114 passed, 0 failed (195.8 s). Related cases: [terminal history 0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md), [environment move 0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [Mermaid watchdog 0518](../design-canvas-and-artifacts/0518-mermaid-watchdog-aggregate-deadline.md) and [artifact engine 0507](../design-canvas-and-artifacts/0507-artifact-engine-chromium-hook-timeout.md).

These owner passes confirm intermittent aggregate failures for both observations. They do not make either original aggregate exit green.

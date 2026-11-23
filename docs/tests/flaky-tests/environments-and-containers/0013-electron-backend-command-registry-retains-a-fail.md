# `Electron backend command registry > retains a failed pending rename so a later backend start can retry it` (`apps/backend/tests/commands-environment.test.ts`)

- **ID:** 0013
- **Status:** resolved
  standalone command that reproduced it
- **Date observed:** 2026-09-02
- **Original command:** `bun run test`
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  the root group used six Bun workers.
- **Failure:** `Timed out waiting for failed pending rename to settle` (reported
  duration: 15.92 s).
- **Suite counts:** root group — 3,991 total, 3,985 passed, 1 skipped, 5 failed,
  and 2 between-test errors across 188 files in 97.17 s.
- **Isolated rerun:** `bun test apps/backend/tests/commands-environment.test.ts
  --only-failures` -> 8 passed, 0 failed in 0.78 s.
- **Hypothesis:** the polling deadline expired during the same aggregate run
  that starved several unrelated process-heavy tests. The isolated case settled
  promptly; no product-code relationship to transcript annotations was found.

## Resolution (2026-11-15)

- **Root cause:** The test waited for the failed rename with `waitForCondition`, a 10 s wall-clock poll (`ASYNC_TEST_WAIT_TIMEOUT_MS`), and for the retried rename the same way; a starved host could outrun the poll while the rename was still settling.
- **Fix:** `apps/backend/tests/commands-environment.test.ts` now waits on the completion signals themselves: the `rename.failed` log record (new additive `LogCapture.waitForRecord` in `packages/protocol/src/testing/log-capture.ts`) and a deferred resolved by the `environment-renamed` event. `tests/default-test-timeout.ts`, imported by both shared preloads (`tests/setup-node.ts`, `tests/setup.ts`), makes 60 s the default per-test and hook budget, a hang watchdog only.
- **Reproduced:** no — a 10 s poll overrun was not re-created; the case ran under the contention runner before and after (below) without failing.
- **Stress:** `mise run test:logged -- --name repro-be-after -- bash -c 'cd apps/backend && bun ../../scripts/test-under-contention.ts --burners 6 -- bun test --preload ../../tests/setup-node.ts ./tests/commands-environment.test.ts ./src/core/control-mcp/agent-voice-chat.test.ts ./src/core/containers/host-reachability.test.ts -t "pending rename|slow reply|cannot be written|remediation" --rerun-each=5 --parallel=1'` passed (every selected case 5 of 5) at host load about 80; the owners also passed in the wider contention runs of 2026-11-15.
- **Base:** `a8b89f154` (working tree; flake sweep of 2026-11-15).

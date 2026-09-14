# 2026-09-08 review validation preparation

- **ID:** 0005
- **Status:** open
- **Original command:** `mise exec -- bun run test:logged -- --name validation-full-suite -- bun run test`.
  Default eight-worker aggregate plan: four root workers, two bridge workers,
  one worker per workspace package with up to two workspace packages active.
  Backend: 2815 pass, 3 fail, 1 error across 123 files (196.21s).
  Evidence: `/tmp/orkestrator-test-run.iHe5wy/summary.json` and its compressed logs.
- **Known attachment timeout recurrence:** `initial prompt attachment command >
  accepts twenty attachments and rejects the twenty-first`, in
  `apps/backend/src/core/commands-state-sync.test.ts`, timed out at 5003.88ms.
  This is the same open case in the coordinator validation timeout cluster below.
- **Known packaged-reviewer recurrence:** `restarting a packaged reviewer
  re-verifies and reuses the read-only package prompt`, in
  `apps/backend/src/core/multi-review-service.test.ts`, expected `reviewing` but
  observed `consolidating` at 39.17ms. This supplies the previously missing
  assertion text for the 2026-09-07 entry below. The background controller can
  advance beyond the phase the assertion observes; no product failure is
  established by that transient-state expectation.
- **Owner rerun:**
  `mise exec -- bun run test:logged -- --name validation-aggregate-owners -- bun test --cwd apps/backend ./src/core/commands-state-sync.test.ts ./src/core/multi-review-service.test.ts --parallel=2 --only-failures`
  passed (17.5s). The packaged-reviewer case also passed the subsequent full
  aggregate run.

### Resolved: independent validation command startup ordering

- **Case:** `independent commands overlap, output stays in artifacts, and
  reconnect does not redispatch`, in
  `apps/backend/src/core/review-validation-worker.test.ts`.
- **Failure:** the original aggregate above observed `[passed, failed]` instead
  of `[passed, passed]` (397.65ms). The owning file passed in isolation with
  `mise exec -- bun run test:logged -- --name validation-worker-isolated-rerun -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts --parallel=2 --only-failures`
  (3.4s).
- **Root cause and fix:** both shells start independently, but the second
  checked the first shell's marker immediately. Only the first shell had an
  arrival barrier. This change adds the same bounded arrival barrier to the
  second shell; a sequential scheduler still cannot satisfy both barriers.
- **Verification:**
  `mise exec -- bun run test:logged -- --name validation-worker-stress -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/review-validation-service.test.ts ./src/core/review-validation-controllers.test.ts --parallel=2 --rerun-each=3 --only-failures`
  passed (29.8s) while the aggregate suite and typechecks ran. The subsequent
  full aggregate also passed this case. **Status: resolved in this change.**

### Subsequent aggregate recurrence

- **Command:** `mise exec -- bun run test:logged -- --name validation-full-suite-rerun -- bun run test`,
  same worker plan. Backend: 2816 pass, 2 fail, 2 errors (285.48s);
  root: 4094 pass, 3 skip, 2 fail (249.88s); bridges: 3456 pass, 16 skip,
  1 fail (257.32s). Protocol passed. Evidence:
  `/tmp/orkestrator-test-run.hgVYD0/summary.json`.
- The known attachment case timed out again (5005.46ms), as did
  `project coordinator > retention never removes an open conversation` in
  `apps/backend/src/core/coordinator-service.test.ts` (5169.03ms). The latter
  is also recorded in the coordinator timeout cluster below.
- `ACP bridge > reaps a session process when the creating HTTP client
  disconnects`, in `bridges/acp-bridge/src/acp-http.test.ts`, reported
  `Timed out waiting for ACP state: ""` (5456.03ms), matching that same cluster.
- `Electron backend command registry > deletes an environment only after all
  three local server kinds exit`, in `tests/unit/electron/commands-integration.test.ts`,
  timed out at 5238.87ms. The other root failure was the deterministic diagnostic
  guard finding two old DOM absence assertions; those assertions were corrected
  in this change and the diagnostic owner passed (21.1s). It is not a flake.
- **Owner reruns:** all passed; no timeout or assertion was loosened:
  - `mise exec -- bun run test:logged -- --name validation-final-backend-owners -- bun test --cwd apps/backend ./src/core/commands-state-sync.test.ts ./src/core/coordinator-service.test.ts ./src/core/multi-review-service.test.ts ./src/core/review-validation-service.test.ts ./src/core/build-pipeline-review-fanout.test.ts --parallel=1 --only-failures` (28.9s).
  - `mise exec -- bun run test:logged -- --name validation-root-timeout-owner -- bun test ./tests/unit/electron/commands-integration.test.ts --parallel=1 --only-failures` (19.6s).
  - `mise exec -- bun run test:logged -- --name validation-acp-timeout-owner -- bun test ./bridges/acp-bridge/src/acp-http.test.ts --parallel=1 --only-failures` (2.6s).
  The root server-shutdown case remains open alongside the existing timeout
  cluster. Host contention is a hypothesis; an isolated pass does not establish
  its cause.

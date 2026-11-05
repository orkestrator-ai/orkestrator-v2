# Incremental Markdown streaming timeout during aggregate validation

- **ID:** 6194
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `a live streaming render matches a full render at every update`
- **File:** `apps/web/src/components/chat/MessageMarkdown.incremental.test.tsx`
- **Original command:** `mise run test:logged -- --name address-aggregate -- mise run test`
- **Workers:** workspace reservation of six slots; web package `--parallel=2`; root suite concurrently active. Other worktrees also held host slots.
- **Failure:** timed out after 5000 ms (5029.36 ms reported).
- **Evidence:** aggregate workspace log under `/tmp/orkestrator-test-run.kVHf90/`; final aggregate result and artifacts are reported by the logged runner.
- **Owning-file rerun:** `env -u NODE_ENV mise run test:logged -- --name streaming-isolated-test-env -- bun test --cwd apps/web ./src/components/chat/MessageMarkdown.incremental.test.tsx --parallel=1 --only-failures` passed in 3.9 seconds. The owner contains four tests. Passing raw output was removed by the logged runner.
- **Invocation correction:** an initial isolated run inherited production-mode React and failed all four tests with `React.act is not a function`; its evidence is `/tmp/orkestrator-test-run.E3hNeN/streaming-isolated.log.gz`. Clearing inherited `NODE_ENV` matches the aggregate runner's sanitization and fixes that invocation.

The unchanged owner passes alone. Concurrent load may contribute to the timeout, but the underlying cause is unconfirmed. No Markdown behavior or timeout was changed. This branch changes terminal archive code, which the renderer test does not exercise.

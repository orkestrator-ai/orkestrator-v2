# Incremental Markdown streaming timeout during aggregate validation

- **ID:** 6194
- **Status:** resolved
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

## Coordinator unavailable-platform review — 2026-11-06

The live streaming/full-render equivalence case exceeded the 5 s budget at 5859.50 ms.

The default aggregate used two web workers. Web totals: 13,051 passed, 10 skipped, five failed and one error across 13,066 cases in 860 files (874.91 s). Original command: `mise run test:logged -- --name review-default-tests -- mise run test`.

The unchanged complete owner passed alone, exit 0, in 4.7 s:

```sh
mise run test:logged -- --name review-markdown-stream-owner -- bun --cwd=apps/web test src/components/chat/MessageMarkdown.incremental.test.tsx --parallel=1 --only-failures
```

Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.Mv0c3i/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. Passing
output was deleted by the logged runner, so individual rerun counts were not
retained. This establishes intermittence, not its cause. No assertion, timeout
or implementation was changed to hide the failure; the broad check remains
non-green.

### Resolution — 2026-11-06

**Root cause.** The case is synchronous, CPU-bound work with nothing to wait
for: about a hundred streamed prefixes, each rendered three times (live,
non-live and a fresh uncached reference), roughly 300 complete Markdown passes.
Timed alone through a JUnit report it took 2.93 s (load average about 5);
instrumented, the live, non-live, fresh and comparison phases took 0.84, 0.90,
1.59 and 0.23 s. Bun's five-second default left too little headroom once the
aggregate slowed the host by about 2x, which matches the 5029 and 5859 ms
failures. No race or hidden wait was found.

**Fix.** `apps/web/src/components/chat/MessageMarkdown.incremental.test.tsx`:
the case carries an explicit `STREAMING_EQUIVALENCE_BUDGET_MS` (30 s), with a
comment giving the work it does. No assertion, step size or prefix changed.

**Verification.** `env -u NODE_ENV mise exec -- bun --cwd=apps/web test src/components/chat/MessageMarkdown.incremental.test.tsx`
passed (4 pass), and so did the combined
`mise run test:logged -- --name web-ui-flake-fixes-combined -- bun --cwd=apps/web test <ten owners> --parallel=3`
run (exit 0). The timeout was not reproduced under load; the fix rests on the
measured cost.

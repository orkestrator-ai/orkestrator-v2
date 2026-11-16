# Coordinator tools list test times out under load

- **ID:** 1651
- **Status:** resolved
- **Date observed:** 2026-11-01
- **Test:** `what a coordinator is offered > the main coordinator has the tools and a side agent does not`
- **File:** `apps/backend/src/core/control-mcp/coordinator-goals.test.ts`
- **Original command:** `bun test --preload ../../tests/setup-node.ts --parallel=4 --only-failures <110 backend files>` from `apps/backend`, on branch `select-soonest-reset-76510e6abff6-r1` (macOS arm64, Bun 1.4.4), with the worktree on an external volume, beside other work on the host.
- **Failure:** exceeded the default 5,000 ms (5,090 ms). Its `tools/list` then failed with `ECONNRESET` between tests, because the fixture had closed the server under the late call.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/build-pipeline-transcript-checkpoints.test.ts src/core/build-pipeline-transcript-store.test.ts src/core/control-mcp/coordinator-goals.test.ts --parallel=1` from `apps/backend`: 59 pass, 0 fail.
- **Assessment:** load on a slow disk rather than a defect in the change that saw it, which does not touch these paths. Open until it is seen again or a run on a local disk stays clean.

## Worktree-watcher review recurrence — 2026-11-10

Observed in `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=7200000 mise run test:logged -- --name coverage-full-final -- mise run test` at `310f4fd7ae6d64395d5f5bc3e3548485489be2f0`, base `08d3da4a23cfe2ecc34fba663ca27e765f7924a9`, macOS arm64/Bun 1.4.4. The workspace reserved six slots (web two, backend four), root one, bridges two and protocol one. The aggregate exited 1 after 2468.77 s; backend has no final counts because the workspace no-progress watchdog fired. Root reported 4274 pass/25 skip/4 fail; web 14336 pass/10 skip/2 fail; Pi 706 pass/1 skip/2 fail.

- `apps/backend/src/core/control-mcp/coordinator-goals.test.ts` — `what a coordinator is offered > the main coordinator has the tools and a side agent does not`: Test deadline 5,000 ms exceeded. Observed 5030.13ms. Complete unchanged owner: 21 pass, 0 fail, 0 skip in 6.51 s at `8948619686981e7b237f879192ac6ffc86b227c6`.

```sh
mise run test:logged -- --name watcher-triage-coordinator-goals -- bun test --cwd apps/backend ./src/core/control-mcp/coordinator-goals.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures --reporter=junit --reporter-outfile=/private/tmp/ork-watcher-failure-triage.0oarZv/coordinator-goals.xml
```

`mise run flaky:recurrence -- 1651 --base 08d3da4a23cfe2ecc34fba663ca27e765f7924a9 --registry-ref origin/main` reported the case open; this records a recurrence.

Evidence: `/private/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.dH765N/` (compressed group logs); JUnit under `/private/tmp/ork-watcher-failure-triage.0oarZv/`. [The complete report](../../../development/worktree-watcher-validation.md) contains the exact group outcomes, commands and non-green isolated owners. Passing alone establishes intermittence, not a cause or a fix. No related assertion, timeout, skip or implementation changed.

## Resolution (2026-11-15)

- **Class:** default test budget (A). `src/core/control-mcp/coordinator-goals.test.ts` sets no budget of its own: no `setDefaultTimeout`, no third-argument or hook timeout, and no wall-clock wait deadline in the test or the helpers it uses. The `ECONNRESET` between tests was the timed-out test's late `tools/list` reaching a server the fixture had already closed, a consequence of the timeout rather than a product race.
- **Root cause:** the recorded failure was Bun's former 5 s default per-test/hook budget expiring while the host was loaded; the owner passes alone in a few seconds and nothing it asserts depends on elapsed time.
- **Fix:** none in this file. It now runs under `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets the default per-test and hook budget to 60 s as a hang watchdog.
- **Reproduced:** no. Under contention with the old budget forced (`mise run test:logged -- --name a1651 -- bun scripts/test-under-contention.ts --core <n> --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/control-mcp/coordinator-goals.test.ts --timeout=5000`) the owner passed (26.3 s), so six burners on one core did not recreate the aggregate's load.
- **Stress:** the same contention command with `--rerun-each=3` at the new default passed (54.2 s).

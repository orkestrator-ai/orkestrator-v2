# Control MCP port recovery fixture hook timeout

- **ID:** 9928
- **Status:** resolved
- **Date observed:** 2026-11-10
- **Base:** `c98b20e6f6332895320b84b8edfd1f3cc9542ba0`.
- **Observed head:** `895a58dc220b5d610980f9ea52eae80b5d48685f`.
- **File:** `apps/backend/src/core/control-mcp/port.test.ts`.
- **Test:** `a fixed Control MCP port held by another process > recovery preserves and authenticates credentials; existing=%s`.
- **Failure:** `a beforeEach/afterEach hook timed out for this test.`,
  10,002.40 ms. The runner did not identify which hook phase timed out or
  report a failed credential/authentication assertion.
- **Original command:** `mise run test:logged -- --name recorded-default-tests -- mise run test`.
  Backend: 18,134 passed, 180 skipped, one failed. Every other aggregate group
  passed. The default command exited 1 in 262.0 s.
- **Evidence:** `orkestrator-test-run.MPR2a6/recorded-default-tests.log.gz`
  under the host temporary directory; group artifacts in
  `orkestrator-test-run.3gZotY/`.

## Unchanged owner and bounded diagnostics

The complete unchanged owner passed, exit 0, in 1.1 s. Passing counts were
not retained and are not inferred:

```sh
mise run test:logged -- --name recorded-control-owner -- bun test --cwd apps/backend ./src/core/control-mcp/port.test.ts --parallel=1 --only-failures
```

A temporary detached checkout added content-free beforeEach/afterEach phase
markers for directory creation, port bind, server stop, port release and
directory removal. The complete owner passed 20 repeats (exit 0, 15.2 s;
per-test counts not retained):

```sh
mise run test:logged -- --name mcp-port-hook-stress -- bun --cwd=output/review-mcp-cleanup-worktree/apps/backend test ./src/core/control-mcp/port.test.ts --rerun-each=20 --parallel=1 --only-failures
```

The full default backend package also passed with those markers, two workers,
exit 0, 845.2 s (counts not retained), at local diagnostic head
`e90c94dd125b1250b6455f494d92342b53bca1e0`:

```sh
ORKESTRATOR_BACKEND_TEST_WORKERS=2 mise run test:logged -- --name mcp-instrumented-backend -- bun --cwd=output/review-mcp-cleanup-worktree/apps/backend run test:workspace
```

That local diagnostic commit is not part of the feature branch. The temporary
checkout and its linked dependencies were removed after its commands exited.
The instrumentation reproduced no hook stall and was not applied to product
or committed test code on the feature branch.

A separate connected-port probe completed release in about 30 ms; its added
no-reset expectation instead received `ECONNRESET`. It therefore did not
reproduce a cleanup hang, and the idle-connection hypothesis was rejected.
No fixture fix based on that hypothesis was retained.

## Assessment and next evidence

The unchanged owner and repeated/package diagnostics establish intermittence,
not a cause or branch attribution. The failing aggregate remains failed;
those passes do not replace it. Credential behavior, assertions, retries and
hook/test deadlines are unchanged.

Capture the exact hook phase in a failing complete default run before changing
server cleanup or increasing its deadline. Neither a credential defect nor an
environmental exemption has been established.

## Resolution (2026-11-15)

- **Root cause:** not pinned to a hook phase. The hooks (`mkdtemp`, a loopback listen, `server.stop()`, port release, `rm`) are fast alone and have no deadline of their own, so the recorded 10 s hook timeout is the runner's budget exhausted under aggregate load. The file also had two wall-clock checks: a 120 ms sleep standing in for "several retries failed" and a 150 ms sleep before the negative assertion in `stop() cancels the retry`.
- **Fix:** the default per-test and hook budget is now a 60 s hang watchdog (`tests/default-test-timeout.ts`, preloaded by `tests/setup-node.ts`). `apps/backend/src/core/control-mcp/port.test.ts`: the retry test waits for three failure notifications instead of sleeping; `stop() cancels the retry` captures the 20 ms bind retry with `installControlledTimeout`, asserts it was armed and then cleared by `stop()`, and advancing runs nothing; `waitFor`'s deadline is a 60 s watchdog on a real condition.
- **Reproduced:** no — the hook stall was not re-created; the budget part is weaker evidence, and a recurrence should still capture the hook phase.
- **Stress:** `mise run test:logged -- --name f2-cont-port -- bun scripts/test-under-contention.ts --burners 6 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/control-mcp/port.test.ts --rerun-each=3` passed (209 s).

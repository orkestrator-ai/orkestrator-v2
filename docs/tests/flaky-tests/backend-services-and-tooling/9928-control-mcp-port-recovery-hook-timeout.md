# Control MCP port recovery fixture hook timeout

- **ID:** 9928
- **Status:** open
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

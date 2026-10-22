# Concurrent MCP retries report a request conflict

- **ID:** 0222
- **Status:** resolved
- **Observed:** 2026-10-15
- **Test:** `McpManagementService — writes > simultaneous retries share the one saved operation`
- **Owner:** `apps/backend/src/core/mcp-management/service.test.ts`

The OpenCode model-selection validation aggregate rejected a concurrent retry
with `request-conflict` after 9.16 ms. The MCP implementation and its owning
test were unchanged. The unchanged owning file passed alone in 1.2 seconds:

```bash
mise run test:logged -- --name mcp-management-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/mcp-management/service.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The cause is not established; no assertions or production behavior were changed.

Recurred on 2026-10-15 in `mise run test` for the sign-in readiness change
(bridges, backend provider and renderer; no MCP code touched): the same
`request-conflict` after 4.74 ms, 1 failure in the backend workspace group,
every other group passing. The unchanged owning file then passed alone three
times in a row (23 pass each):

```bash
bun test src/core/mcp-management/service.test.ts --preload ../../tests/setup-node.ts --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.wdZIQN/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Recurrence during Claude interaction validation

On 2026-10-15, `mise run test:logged -- --name root-tests -- mise run test`
failed the same unchanged case with `request-conflict` after 7.98 ms. The
backend group reported 8022 passed, 39 skipped and one failed; root, bridge and
protocol-lockfile groups passed. The owning file passed alone in 0.1 seconds:

```bash
mise run test:logged -- --name mcp-service-rerun -- bun test --cwd apps/backend ./src/core/mcp-management/service.test.ts --parallel=1 --preload ../../tests/setup-node.ts
```

Evidence: `/tmp/orkestrator-test-run.y8jiqm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The Claude changes do not touch MCP operation admission; no test was weakened
or skipped.

## Recurrence and resolution on the apply-path gaps branch

On 2026-10-16, `mise run test` for the MCP apply-path gaps change failed the
same case with `request-conflict` after 8.34 ms (backend workspace group; root
and bridge groups passed). The owning file passed alone three times (23 pass
each).

**Cause.** The request fingerprint is a keyed digest, and the key is created
on first use by `McpSourceStore.secretKey()`. The test's two concurrent
`mutate` calls are the store's first two key reads. Both found no key file;
the first created it (`writeFile` with `wx`) and the second, failing with
`EEXIST`, could read the file before the first had written the bytes, and so
get a short or empty key. The two fingerprints then differed, and the second request was
refused as a different change. A standalone race of two first calls on fresh
stores disagreed in 2 of 200 rounds.

**Fix.** Concurrent `secretKey()` calls now share one in-flight load, so every
caller of one store gets the same key. `source-store.test.ts` ("concurrent
first uses agree on one key") races 50 fresh stores; it failed one of three
runs against the old code and passes every run with the fix, and the
standalone race showed 0 of 200 disagreements. Two separate backends creating
the key at the same instant can still race the same way; that needs two
processes' very first MCP write in the same few milliseconds and is not what
this test exercised.

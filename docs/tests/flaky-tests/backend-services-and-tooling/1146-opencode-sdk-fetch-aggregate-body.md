# openCodeSdkFetch read another body in the aggregate

- **ID:** 1146
- **Status:** open
- **Observed:** 2026-10-27, todo 0223 branch validation
- **Test:** `openCodeSdkFetch > charges one provider request per call to the job that made it`
- **File:** `apps/backend/src/core/opencode-sdk-fetch.test.ts:19`

Failed once in the second `mise run test` of the 0223 branch (9.58 ms): the
response text from the test's own `Bun.serve` fixture was expected to be `ok`
but was `{}`, as if the request reached another handler or a replaced global
`fetch`. The 0223 change does not touch `opencode-sdk-fetch.ts` or the OpenCode
provider's transport.

The complete unchanged owner passed alone on the branch and on a detached
worktree of its base `863b57821` (5 passed each):

```sh
bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/opencode-sdk-fetch.test.ts
```

A sibling file's global `fetch` stub leaking into this worker is a hypothesis;
nothing here establishes it. No assertion, skip or implementation changed.
Aggregate evidence: `orkestrator-test-run.38P3gc` under the host temporary
directory.

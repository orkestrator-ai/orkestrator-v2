# http1Request: slow upload against the headers timeout

- **ID:** 2413
- **Status:** open
- **Test:** `http1Request > a slow upload does not count against the headers timeout`
- **File:** `packages/protocol/src/node/preview-http1.test.ts`

On 2026-11-02, during the shared-logger backend migration, this failed once in `mise run test`
after 304.60 ms (protocol: 4,326 pass, 1 fail), and passed in the run before it.

```sh
cd packages/protocol && bun test ./src/node/preview-http1.test.ts --only-failures
```

Alone it passes: 19 pass, 0 fail. The branch does not touch this module.

Hypothesis, not proven: the test's real timers slip under the aggregate's load.

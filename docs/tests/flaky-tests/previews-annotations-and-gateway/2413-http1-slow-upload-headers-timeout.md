# http1Request: slow upload against the headers timeout

- **ID:** 2413
- **Status:** resolved
- **Test:** `http1Request > a slow upload does not count against the headers timeout`
- **File:** `packages/protocol/src/node/preview-http1.test.ts`

On 2026-11-02, during the shared-logger backend migration, this failed once in `mise run test`
after 304.60 ms (protocol: 4,326 pass, 1 fail), and passed in the run before it.

```sh
cd packages/protocol && bun test ./src/node/preview-http1.test.ts --only-failures
```

Alone it passes: 19 pass, 0 fail. The branch does not touch this module.

Hypothesis, not proven: the test's real timers slip under the aggregate's load.

### Resolution — 2026-11-06

**Root cause.** The test raced the real headers timer it meant to exclude.
`http1Request` arms the headers timer only once the request body is written,
so the upload itself was never the problem; but with `headersTimeoutMs: 60`
the upstream's own processing after the 160 ms upload had to answer within
60 ms of real time, and a stalled worker let that timer expire.

**Reproduced.** A temporary copy of the unchanged test whose server
busy-waits 80 ms before answering failed with `headers-timeout` in 281.56 ms
(the recorded failure took 304.60 ms).

**Fix.** `packages/protocol/src/node/preview-http1.test.ts` observes the
arming directly: it wraps `setTimeout` for the duration of the test, records
how many body chunks had been handed over each time a timer with the test's
distinctive headers delay (4,321 ms) was armed, and asserts it was armed once,
after all four chunks (`[4]`). Arming at request start, the regression the
test exists to catch, now fails it deterministically. Status and body
assertions unchanged.

**Verification.**
- `NODE_ENV=test mise run test:logged -- --name http1-fix -- bun test --cwd packages/protocol ./src/node/preview-http1.test.ts --rerun-each=20`: PASS.
- The fixed test with the same 80 ms server stall: 5 of 5 passed.

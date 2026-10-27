# Claude execution policy network qualification timeout

- **ID:** 1201
- **Status:** open
- **Date observed:** 2026-10-27
- **Test:** `Claude CLI execution policy qualification > network`
- **File:** `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts`

During coordinator worker-surface review-fix validation, `mise run test`
failed the network case at 17,008.89 ms because its abort controller fired.
This fixture uses the pinned CLI and a scripted local model endpoint; no live
model service is involved. The complete unchanged owning file passed alone
(4 tests, 25.2 s):

```sh
mise run test:logged -- --name bridge-policy-owner -- bun test --cwd bridges/claude-bridge ./src/conformance-execution-policy-live.test.ts --parallel=1 --only-failures
```

The aggregate log is `orkestrator-test-run.2JIWtv/bridges.log` in the host
temporary directory. This is a confirmed aggregate-only timing failure.
No timeout, assertion, skip, or bridge implementation was changed.

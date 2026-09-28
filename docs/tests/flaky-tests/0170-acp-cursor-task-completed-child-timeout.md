# ACP completed child request times out in the aggregate

- **ID:** 0170
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `ACP bridge > answers Cursor's cursor/task request for a completed child and settles it`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:389`
- **Original command:** `mise run test` on branch tip `754bca31` while merging `origin/main`. The bridge group ran one worker per package alongside the workspace and root groups.
- **Failure:** The five-second `waitFor` expired with `Timed out waiting for ACP state: {"error":"Unauthorized"} (last error: ConnectionRefused)`. The ACP package reported 464 pass, 3 skip and 1 fail.
- **Isolated rerun:** `mise run test:logged -- --name acp-context-isolated -- bun test ./bridges/acp-bridge/src/acp-context.test.ts --parallel=1 --only-failures` passed.

## Current assessment

The aggregate and isolated results differ. The bridge did not change during this merge. The Unauthorized response followed by a refused connection suggests a transient harness startup or session routing issue under concurrent load; this needs a targeted reproduction before changing the assertion or timeout.

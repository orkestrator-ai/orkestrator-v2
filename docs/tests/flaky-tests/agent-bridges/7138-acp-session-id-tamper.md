# ACP resumable session ID tamper assertion

- **ID:** 7138
- **Status:** open
- **Date observed:** 2026-11-06
- **Test:** `ACP bridge > lists and resumes provider-owned grok sessions`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:193`
- **Original command:** `mise run test:logged -- --name fix-full-rerun -- mise run test:full` on `79dbd1ff6`; concurrent all-tier workspace, root and bridge groups, bridge group allocated two worker slots.
- **Failure:** Expected resume HTTP 404 after changing the final encoded session-ID character, received 201 (461.64 ms). ACP package: 814 pass, 17 skip, 1 fail, 832 tests across 60 files.
- **Isolated rerun:** `NODE_ENV=test mise run test:logged -- --name fix-triage-acp-context -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --parallel=1 --only-failures` passed in 19.0 seconds.
- **Evidence:** Aggregate bridge log `/tmp/orkestrator-test-run.c7DYyd/bridges.log` (compressed on aggregate finalization).

## Current assessment

The owning file passes alone; no ACP source or test changed in this branch.
The test changes only the last character of a signed encoded ID. One hypothesis
is that the replacement occasionally changes unused encoding bits without
changing decoded bytes; this has not been reproduced or confirmed.
Do not weaken the assertion or change session admission without a reproduction.

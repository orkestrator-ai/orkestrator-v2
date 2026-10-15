# Design operation replay sees an extra event

- **ID:** 0212
- **Status:** open
- **Observed:** 2026-10-15
- **Test:** `design operations: prepare, execute, status and cancel > a lost execute response is answered by status and a repeated execute changes nothing`
- **Owner:** `apps/backend/src/core/design-operations.test.ts:268`

`mise run test:logged -- --name repository-tests -- mise run test` failed
with an event count of 4 instead of 3, after 42.95 ms. The owning source and
test were unchanged by the OpenCode model-selection fixes.

The unchanged owning file passed alone in 7.4 seconds with:

```bash
mise run test:logged -- --name design-operations-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/design-operations.test.ts --parallel=1 --only-failures
```

Aggregate evidence: `/tmp/orkestrator-test-run.lhp1N0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The extra event's source is not established. No assertions, timeouts, or
production behavior were changed to hide this failure.

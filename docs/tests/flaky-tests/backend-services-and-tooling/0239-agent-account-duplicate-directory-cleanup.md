# Duplicate agent-account login leaves an extra directory in the aggregate

- **ID:** 0239
- **Status:** open
- **Observed:** 2026-10-15, macOS, Bun 1.4.3.
- **Test:** `agent accounts > the same login cannot be added twice`.
- **File:** `apps/backend/src/core/agent-accounts.test.ts:713`.

The warm full-suite run failed the directory assertion after the duplicate
login had already been reported failed with the expected `already added`
message. The account directory contained two UUID entries instead of just the
first account's ID. The test took 128.13 ms.

```bash
mise run test:logged -- --name full-tests-warm -- mise run test
```

The backend package reported 7908 passed, 39 skipped, 1 failed and 39515
assertions across 433 files in 269.77 s. The complete workspace group took
282.7 s. Group allocations were workspace 4 slots, root 1, bridges 2 and
protocol 1; workspace package tests used two Bun workers. Root, all five
bridges, and the protocol lockfile group passed. The preceding full run had
passed all 7909 backend tests; its only failures were the Cursor HTTP fixture
timeouts tracked in case 0182.

The unchanged owning file passed alone, exit 0, in 2.0 s:

```bash
mise run test:logged -- --name agent-accounts-isolated -- \
  bun test --cwd apps/backend ./src/core/agent-accounts.test.ts \
  --preload ../../tests/setup-node.ts --parallel=1
```

Evidence: `/private/tmp/orkestrator-test-run.HeXNK8/summary.json` and
`workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`,
plus the logged isolated PASS. Passing output is deleted by the runner.

The extra directory after failed progress suggests a cleanup/publication
ordering race under aggregate load, but the root cause has not been proved.
No assertion, timeout, production account behavior or skip was changed.

## Recurrence during the remaining real-Electron preview cases (2026-10-21)

- **Command:** `mise run test:logged -- --name full-tests-0a835 -- mise run test`
  on branch `qualify-preview-electron-remaining-cases-0a835a98d18e` (no
  backend change), load average 16 to 36.
- **Failure:** line 796, `codexAccounts` held a second account id after the
  rejected duplicate (122.22 ms), the same symptom.
- **Alone:** `bun test --preload ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts --parallel=1`
  in `apps/backend`: 37 passed (4.55 s) at load 36.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.txKi1Z/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

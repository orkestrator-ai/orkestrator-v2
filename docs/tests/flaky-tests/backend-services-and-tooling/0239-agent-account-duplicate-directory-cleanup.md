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

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 6.4 s: `mise run test:logged -- --name design-links-owner-agent-accounts -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Coordinator adapter review — 2026-10-24

The aggregate repeated this case during coordinator adapter validation. Exact
commands, timing, owner rerun results and evidence are recorded in
[0725](../aggregate-validation-runs/0725-coordinator-adapter-review-validation.md).
The owning implementation, assertions, timeouts and skips were unchanged.


## Bun gate and preview coverage review — 2026-10-24

- **Original command:** `mise run test:logged -- --name review-default-suite -- mise run test`, Bun 1.4.4 on macOS arm64, workspace/root/bridges/protocol reservations 4/1/2/1. The backend package used two Bun workers while other worktrees shared the host.
- **Failure:** `agent accounts > the same login cannot be added twice` at `apps/backend/src/core/agent-accounts.test.ts:811` observed two account directories instead of the accepted account's one directory after the duplicate was rejected (301.05 ms).
- **Unchanged owner:** `mise run test:logged -- --name review-agent-accounts-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agent-accounts.test.ts --parallel=1` passed the complete owning file (exit 0, 4.0 seconds logged).
- **Suite counts:** backend reported 11013 passed, 79 skipped and one failed across 11093 tests in 660 files (687.40 seconds). Twelve of thirteen workspace build/test tasks passed. The full aggregate completed with this failure and the Codex timeout in case 0210; root/support and protocol-lockfile groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.2BemPO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate finalization; outer run `orkestrator-test-run.LLUEZq`.
- **Assessment:** confirmed intermittent recurrence of the cleanup/publication ordering symptom. No account implementation, assertion, timeout or skip changed.

## Federated dialog readiness validation — 2026-10-25

- Original command: `mise run test:logged -- --name repo-tests -- mise run test`,
  Bun 1.4.4, workspace/root/bridges/protocol reservations 4/1/2/1, with other
  worktrees validating concurrently. The backend used two Bun workers.
- The same duplicate-login case at `apps/backend/src/core/agent-accounts.test.ts:811`
  observed a second account directory after rejection (190.66 ms).
- The complete unchanged owner passed alone in 11.0 seconds (exit 0):
  `mise run test:logged -- --name account-owner-rerun -- bun test --cwd apps/backend ./src/core/agent-accounts.test.ts --parallel=1 --only-failures`.
  The logged runner removed passing output; individual test counts were not retained.
- Evidence: `orkestrator-test-run.DHlEAe/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  after aggregate finalization; the outer run is `orkestrator-test-run.Jjipx9`.
  Backend counts: 10457 passed, 79 skipped, two failed, one error in 585.85
  seconds across 615 files. The other failure was terminal-history pagination
  (see 0213).
  The account implementation and tests were unchanged. The existing intermittent
  cleanup/publication ordering symptom remains open.

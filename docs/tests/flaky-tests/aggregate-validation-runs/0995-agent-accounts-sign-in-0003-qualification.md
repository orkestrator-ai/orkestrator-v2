# Agent accounts and sign-in (0003) qualification validation

- **ID:** 0995
- **Status:** environmental
- **Date observed:** 2026-10-26, node mbp3
- **Scope:** todo 0003 branch (`todo-0003-agent-accounts-sign-in-7ea5f29c4c61`) on `main` at `93018933`, after the live qualification fixes.

## Non-iOS repository suite

`mise run test` exited 1 after 811.5 s, at host load averages of 20 to 40
(`uptime` during the reruns: 20.28 23.37 40.79). Bridges (codex 2414, cursor
796, claude 1646, pi 631 and acp 698 tests) and the Codex protocol lockfile
passed. Web 9833 passed, 10 skipped; backend 11729 passed, 135 skipped;
protocol 1881, web-public 41, toolchain 91 and CLI 324 tests passed. Desktop
had 1317 passed, 14 skipped and 4 failed; root and agent-support 3470 passed
and 2 failed.

| Owner | Failure | Complete owner rerun |
| --- | --- | --- |
| `apps/desktop/scripts/dev/isolated-browser.test.ts` | Three `isolated browser overrides an inherited live … opt-in` cases hit Bun's five-second budget (5002 to 5012 ms). | Passed alone (9.0 s). Recurrence of [0163](../electron-and-desktop/0163-desktop-isolated-browser-aggregate-timeout.md). |
| `apps/desktop/tests/backend-process.test.ts` | `Electron backend process supervisor > adopts and removes an owned Serve route after an ungraceful backend restart` failed a `toMatchObject` after 12,657 ms. | Passed alone (15.5 s). The branch does not touch the desktop backend supervisor. |
| `tests/unit/firewall-policy.test.ts` | `the root entrypoint runs the firewall itself and records the outcome per mode` timed out (5291 ms, `exitCode` `null`). | Failed alone too (32 passed, 2 failed at ~5,005 ms each): the host-load condition of [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md) and [0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md), which `main` shares. Not classified as a new flake. |
| `tests/unit/flaky-tests-index.test.ts` | `environments-and-containers index lists every case file and stores a status for each row`: case 0887 had no `- **ID:**` / `- **Status:**` lines. | A deterministic defect already on `main` (from `c55807f96`); this branch gives 0887 the metadata lines and the owner passes (11 passed). |

Owner rerun commands, from the repository root:

```sh
mise run test:logged -- --name isolated-browser -- bun --cwd=apps/desktop test scripts/dev/isolated-browser.test.ts --parallel=1 --only-failures
mise run test:logged -- --name backend-process -- bun --cwd=apps/desktop test tests/backend-process.test.ts --parallel=1 --only-failures
bun test ./tests/unit/firewall-policy.test.ts
bun test ./tests/unit/flaky-tests-index.test.ts
```

Aggregate artifacts below the host temporary directory:
`orkestrator-test-run.6lQsB5/root-and-agent-support-tests.log.gz` and
`orkestrator-test-run.6lQsB5/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

No test was disabled, no deadline was increased, and no Git hook was bypassed.


## Shared-state and stored-login review fixes — 2026-10-26

Implementation commit `74841142b` addresses the dispatch-journal and evidence-spool upgrade paths, stored-login notice recovery, child/coordinator environment isolation, and the requested regression coverage.

### Passing focused and static checks

- `mise run check` through `test:logged` passed formatting, lint and all package typechecks. The final static run took 11.9 s.
- `codex-storage-final`: the new shared-state upgrade suite plus existing dispatch-journal and change-evidence owners passed (0.8 s).
- `codex-auth-launch`: the stored-account runtime and process-supervisor owners passed (0.4 s). `backend-launch`, run with `bun test --cwd apps/backend ./src/core/commands-servers-coordinator.test.ts --parallel=1 --only-failures`, passed separately (8.1 s).
- `codex-auth-component-final`: the complete native-tab component owner passed after changing two new DOM absence assertions to the repository's bounded boolean convention (58.4 s). `codex-auth-diagnostic-bounds` passed (25.4 s). The original aggregate's diagnostic failure names that earlier assertion form and is fixed in the implementation commit.

### Component browser suite

`ORKESTRATOR_E2E_PORT=49385 ORKESTRATOR_PUBLIC_E2E_PORT=49386 mise run test:logged -- --name browser-isolated-ports -- mise run test:browser` used nine workers and ended with **744 passed, 102 skipped, 12 failed** (978.1 s). The initial default-port attempt refused another checkout's fixture server, which was left untouched. Because the component suite failed, the chained public-site smoke suite did not execute; public-site code is unchanged.

Complete unchanged owner reruns used `ORKESTRATOR_E2E_PORT=62459 mise run test:logged -- --name codex-auth-owner-<owner> -- bunx playwright test --config e2e/playwright.config.ts e2e/<Owner>.spec.ts --workers=1 --output output/playwright/codex-auth-owner-<owner>`, one file per invocation:

| Owner | Result |
| --- | --- |
| `AgentUsage` | Four passed, 69.3 s; recurrence of [0749](../web-ui/0749-agent-usage-browser-startup-timeout.md). |
| `DesignCanvas` | Both viewport cases passed, 60.6 s; [0174](../design-canvas-and-artifacts/0174-design-canvas-parallel-browser-timeout.md) reopened for the post-fix recurrence. |
| `NativeHeldSend` | All six passed, 40.6 s. Used log name `codex-auth-held-send-owner` and matching output directory. |
| `SetupRecovery` | All four passed, 15.3 s. |
| `VirtuosoFollow` | Passed, 5.0 s; used port 62460. |
| `KeyboardShortcuts` | 27 passed, one failed, 81.7 s. The mobile Monaco editor still missed its attachment deadline; this rerun does not establish a new flake. |
| `PaneBreakpoint` | Eight passed, one skipped, one failed, 38.8 s. The startup condition recovered, but the mobile moveBefore case retained a scroll-anchor mismatch (message 35 vs 36). The whole owner is not green. |
| `CloseRetention` | 19 passed, 20 skipped, one failed, 135.2 s. The desktop Cursor steering case again reported no running turn; this is not newly classified as flaky. |

The confirmed renderer fixture recurrences are retained in [0382](../web-ui/0382-component-browser-parallel-load.md). No owner implementation, assertion, timeout or skip changed between these runs. The original log is `orkestrator-test-run.2DAvia/browser-isolated-ports.log.gz` below the host temporary directory; retained owner failures are in `orkestrator-test-run.Zk8eln`, `orkestrator-test-run.sxFGfn`, and `orkestrator-test-run.AkT6Kq`.

### Isolated real-stack browser validation

`mise run test:agent:browser:isolated` created credential-free Codex profile `qa-browser-b41e3a65-738`. The browser suite reported **34 passed, 67 opt-in skips, two failed** (13.4 min; complete lifecycle 823.87 s). Account switching, unavailable-account recovery, and signed-out Codex recovery across reload/environment switching passed. The failures were:

- Desktop SSH socket picker: Select file remained disabled. A complete unchanged gateway-owner run in fresh profile `codex-auth-review-7ea5` passed both picker viewports, but retained separate fixture-project visibility, agent-mail navigation, and narrow maintenance failures (11 passed, ten skipped, three failed, 431.2 s). See [0494](../previews-annotations-and-gateway/0494-gateway-picker-diff-and-fixture-visibility.md) for the exact command and evidence.
- Annotation evidence filename: `web-annotations-gateway.spec.ts:650` expected the raw request id in the materialized filename, but received its hash. This unchanged annotation assertion was not loosened or classified as flaky.

Both profiles were stopped and reset. Their state directories were removed; sanitized browser artifacts remain under `output/agent-testing/<profile>/browser/`. Docker/live-provider cases were skipped by the credential-free one-shot configuration; iOS/Electron-specific scenario suites were outside the change's scope.

### Non-iOS aggregate observations

`mise run test:logged -- --name repository-tests -- mise run test` reserved worker slots 4/1/2/1 for workspace/root/bridges/protocol. Bridges and the protocol lockfile group passed. Root and agent-support reported three failures: firewall's root-entrypoint deadline (5005.35 ms), disk-report's five-second deadline, and the new unbounded DOM absence assertions subsequently corrected and independently verified above.

`mise run test:logged -- --name codex-auth-firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (51.5 s), recorded in [0632](../environments-and-containers/0632-firewall-policy-probe-budget.md). `mise run test:logged -- --name codex-auth-disk-owner -- bun test ./tests/unit/disk-report.test.ts --parallel=1 --only-failures` retained its deadline (five passed, one failed, one error, 6.4 s; `orkestrator-test-run.TNGlTG`); no new disk-report flake is claimed.

The workspace group also reported unchanged backend lifecycle/move/Claude-reuse timeouts and a change-tracking inventory timeout followed by a closed-database failure in the next case. These are outside the implementation's edited tests; they are not classified as new flakes without passing owner reruns. Aggregate logs are retained below the host temporary directory in `orkestrator-test-run.F4Cfq3` (wrapper) and `orkestrator-test-run.4yydbQ` (individual groups).


The complete non-iOS command finished with exit 1 after 1257.6 s. Package results: web 9,835 passed/ten skipped; backend 11,724 passed/135 skipped/five failed; desktop 1,321 passed/14 skipped; protocol 1,881 passed; web-public 41 passed; toolchain 91 passed; CLI 323 passed/one skipped. Root reported 3,469 passed/three failed (including the corrected absence-assertion finding). Bridges and the Codex protocol lockfile passed. The remaining backend/root failures were not hidden, skipped or assigned a new flaky classification without the evidence described above. The failure logs are now compressed (`*.log.gz`) in the recorded artifact directories. The flake-register consistency owner passed after these registry updates, and final formatting passed.

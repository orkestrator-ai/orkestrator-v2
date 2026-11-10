# Transcript repair browser validation: intermittent owner failures

- **ID:** 7272
- **Status:** open
- **Date observed:** 2026-11-06
- **Original command:** `ORKESTRATOR_E2E_PORT=14827 mise run test:logged -- --name browser -- mise run test:browser`
- **Worker configuration:** Playwright config defaults, both Chromium viewport projects; isolated owner commands used separate fixture ports and artifact directories.
- **Aggregate counts:** 1,510 passed, 135 skipped, nine failed in 1,403.5 s. Public-site checks after the component suite were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hIh8H2/browser.log.gz`.

## Failures whose complete owning file passed alone

| Owning file and exact test | Aggregate failure | Isolated owner result |
| --- | --- | --- |
| `e2e/PullRequestTranscriptPane.spec.ts:117`: delayed failure retains a user-activated browser escape after a blocked popup | Desktop: Open on GitHub button missing after 15 s | Exit 0, 25.0 s |
| `e2e/ReadCoordinator.spec.ts:25`: hidden documents stop coordinated reads and resume reconciles critical reads first | Desktop: session reconciliation order differed | Exit 0, 16.8 s |
| `e2e/RemoteMachineTree.spec.ts:30`: drag optimistically reorders within a project, preserves home slots, and reconciles with the summary | Desktop: environment row order differed after 5 s | Exit 0, 39.4 s |
| `e2e/RemoteMachineTree.spec.ts:60`: Unknown rolls back the drag and names the command in the notice | Desktop: environment row order differed after 5 s | Same complete owner pass |
| `e2e/SidebarMotion.spec.ts:26`: real panels restore width, bound reversal pins and release once | Desktop: three content sizes instead of the bound of two | Exit 0, 38.1 s |

Each owning file ran separately with both viewport projects, using:

```sh
ORKESTRATOR_E2E_PORT=<port> mise run test:logged -- --name repair-<owner>-alone -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-<owner>-alone e2e/<owner>.spec.ts
```

Owners/ports were `PullRequestTranscriptPane`/14842, `ReadCoordinator`/14843,
`RemoteMachineTree`/14844 and `SidebarMotion`/14845. Passing logs were deleted
by the logged runner. No spec, assertion, timeout or skip changed. The cause
is unconfirmed; the prior network-change case 4291 is not this assertion.

The other intermittent failures update their existing records:
[1310](../previews-annotations-and-gateway/1310-data-saving-gateway-browser-timeout.md)
and [4350](4350-suborks-branch-browser-validation.md). `TabLaunchOverride`
failed both viewports in the aggregate and again in the seven-owner rerun
(54 passed, two failed in 1.1 min); it is not classified as a flake. That
failure is left to the verifier rather than changing unrelated launch UI.

## Auto-pipeline address validation — 2026-11-10

Observed on `autopipeline-text-boxes-7182fc46ef5e-r1` at `944b37af1`, based on
`8d0ae2764e0a5875144d15ee0f526608e6c1c1e8`. The reviewed commit `02f72782c` remains in history.

- **Original command:** `ORKESTRATOR_E2E_PORT=15182 ORKESTRATOR_PUBLIC_E2E_PORT=15183 mise run test:logged -- --name browser -- mise run test:browser`.
- **Aggregate result:** incomplete at the 1,800 s runner deadline; 69 named failures,
  last progress 1,194/1,814, with no final pass/skip totals. Public-site tests were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pcV7xY/browser.log.gz`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=15186 mise run test:logged -- --name address-remote-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-remote-alone e2e/RemoteMachineTree.spec.ts`; exit 0, 147.9 s, one worker and both viewport projects.
- **Recurrence check:** `mise run flaky:recurrence -- 7272 --base 8d0ae2764e0a5875144d15ee0f526608e6c1c1e8 --registry-ref origin/main` reported `open`.

| Project | Location | Exact test |
| --- | --- | --- |
| mobile-chromium | `e2e/RemoteMachineTree.spec.ts:157` | remote failed deletion shows one complete failure message and a Retry action |
| mobile-chromium | `e2e/RemoteMachineTree.spec.ts:174` | a slow remote delete says how long it has run and which step it is on |

The owning spec and its implementation were unchanged. No assertion, deadline,
retry or skip was changed. This establishes intermittency, not its cause.
The full run and remaining undetermined failures are recorded in
[9924](9924-auto-pipeline-fix-browser-owners.md).

## Effect adoption validation recurrence — 2026-11-10

Observing branch base: `04639b12b71d4326a3b8941485367aca197f4966`;
reviewed head: `c6b3ce9792c064bcac5e9eb7a287675fcbe73118`.
`mise run flaky:recurrence -- 7272` reported open.
`mise run test:logged -- --name browser -- mise run test:browser` (eight workers)
repeated the SidebarMotion line 47 assertion on mobile: three content widths
instead of at most two.

The complete unchanged owner passed alone in 114.3 s:
`mise run test:logged -- --name address-sidebar-owner -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/SidebarMotion.spec.ts --workers=1 --output=output/playwright/address-sidebar-owner`.
Passing test totals are unavailable because the logged runner deleted its output.
No assertion, timeout or sidebar implementation changed. Intermittence is
established; the cause and independence from this branch remain unproved.
Aggregate evidence and final counts are also recorded in the Address Findings
result for this validation attempt.

Aggregate outcome: terminated at the 1,800 s deadline after starting 1,584 of
1,810 cases, with 14 reported failures; no final pass/skip totals and no
public-site execution. Evidence: `/tmp/orkestrator-test-run.HLOvBh/browser.log.gz`.

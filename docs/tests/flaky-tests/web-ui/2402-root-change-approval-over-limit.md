# root-change approval handles over-limit and still permits rejection

- **ID:** 2402
- **Status:** open
- **Test:** `root-change approval handles over-limit and still permits rejection`
- **File:** `apps/web/src/components/federation/node-action-requests.test.tsx`

On 2026-11-02, during the shared-logger bridge migration, this failed once in `mise run test` after 6861.01 ms, with the host at a load average near 55. Exceeded its time in the workspace group. The owner then passed alone (12 pass, 0 fail):

```sh
cd apps/web && bun test src/components/federation/node-action-requests.test.tsx --only-failures
```

That change does not touch this test's code. This records the intermittency; no cause is established.


## Task 1202 review repair — 2026-11-02

Original command: `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test:logged -- --name address-default-suite-concurrent -- mise run test`, workspace/root/bridge/protocol grants 6/1/2/1.
Group evidence: `orkestrator-test-run.WXZCOJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`.

Aggregate timeout 6,836.46 ms; complete owner failed alone (11 pass/1 fail/1 error, 11.3 s). Detached main at 38d55ee14 reproduced the same timeout (6,766.15 ms; 11 pass/1 fail/1 error, 13.6 s), with independently installed dependencies. Branch artifact ZiXadV; main g7Z7WA.

The complete owner was rerun with `mise run test:logged -- --name address-root-change-rerun -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures`. No implementation, assertion, wait, timeout or skip was changed. This recurrence remains open.

Final aggregate counts: desktop 1,580 pass / 16 skip / 2 fail; backend
13,138 pass / 97 skip / 3 fail; web 11,230 pass / 10 skip / 7 fail; root
3,418 pass / 3 fail. Bridges and Codex protocol verification passed.
The aggregate exited 1 after 1,152.1 seconds; no watchdog or output limit fired.

## Usage-limit review recurrence — 2026-11-05

`mise run test:logged -- --name address-default-rerun -- mise run test`
repeated `root-change approval handles over-limit and still permits rejection` at 5359.63 ms against the 5000 ms deadline.
The workspace group reserved six slots (backend up to four workers, web two)
beside the one-worker root and two-worker bridge groups on the shared Linux
host. The aggregate queued for about 740 s. The package reported 12496 passed, 10 skipped and one failed across 833 web files (754.86 s).

The unchanged owning file passed alone in 8.1 s (exit zero):

```sh
mise run test:logged -- --name address-node-requests-rerun -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.NrGGXS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. Passing owner output was removed by the logged runner.
This confirms another aggregate-only occurrence; scheduling pressure remains a
hypothesis, not a proven cause. No assertion, timeout or skip was changed.

## Static Find repair aggregate, 2026-11-05

`mise run test` after commit `c4448a5ad` timed out `root-change approval handles over-limit and still permits rejection` at 7424.08 ms (5000 ms limit). Web totals: 12590 pass, 10 skip, 1 fail. Evidence: `/tmp/orkestrator-test-run.PpclE3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. Complete unchanged owner rerun: `mise run test:logged -- --name approval-alone -- bun --cwd=apps/web test ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures`, passed, exit 0, 2.0 s. No cause established; no assertion changed.

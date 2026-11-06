# root-change approval handles over-limit and still permits rejection

- **ID:** 2402
- **Status:** resolved
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

## Pipe capture move recurrence — 2026-11-05

Review preparation of `76136cdb7` on `move-pipe-captures-c7893f496669-r1`, based
on `af2e566e5`, reported this test timing out at 7024.18 ms in `mise run test`.
That branch changes nothing under `apps/web` or `packages/`.

Unlike the earlier occurrences, the owning file also timed out alone, three
times out of three (5857 to 7751 ms), at a host load average of 33 to 37 on 12
cores. The first of those ran beside three other owner reruns:

```sh
mise run test:logged -- --name own-node-actions -- bun --cwd=apps/web test src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
```

The timed-out test then left an unhandled `TestingLibraryElementError` between
tests. Adding `--timeout=60000` on the command line, for diagnosis only, the test
filtered with `-t over-limit` passed in 14.8 s at a load average of 39, so it was
slow rather than stalled. No idle-host rerun was possible. No assertion, timeout
or skip was changed.

## Static Find repair aggregate, 2026-11-05

`mise run test` after commit `c4448a5ad` timed out `root-change approval handles over-limit and still permits rejection` at 7424.08 ms (5000 ms limit). Web totals: 12590 pass, 10 skip, 1 fail. Evidence: `/tmp/orkestrator-test-run.PpclE3/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`. Complete unchanged owner rerun: `mise run test:logged -- --name approval-alone -- bun --cwd=apps/web test ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures`, passed, exit 0, 2.0 s. No cause established; no assertion changed.


## Mail envelope review recurrence — 2026-11-05

Preparation at `c394083df` repeated `root-change approval handles over-limit and still permits rejection` in `apps/web/src/components/federation/node-action-requests.test.tsx`: 5373.35 ms against the 5000 ms deadline. Original command: `mise run test:logged -- --name review-default-tests -- mise run test`. The supplied package does not record the worker grants; visible summaries total 33,391 tests (33,236 passed, 5 failed, 150 skipped). Evidence is `.orkestrator/review-artifacts/review-validation-66eeef27-a031-4c68-a36b-f870e73b9c33/validation-04.stderr.txt`.

The unchanged owning file passed alone (exit 0, 3.1 s) with `NODE_ENV=test mise run test:logged -- --name root-approval-alone -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures`. The logged runner removed passing output, so its test count was not retained. A two-owner diagnostic run also passed this test while repeating three fork failures in the other owner (`/tmp/orkestrator-test-run.8u8Xff/federation-focused.log.gz`, 109 passed, 3 failed). No assertion, timeout or production code for this case changed; no cause is established.

## Work panel merge — 2026-11-06

`mise run test:logged -- --name merge-tests -- mise run test` repeated the
over-limit case deadline at 5164.36 ms (workspace six slots; web two Bun
workers; concurrent validation). The complete unchanged owner passed alone,
exit 0 in 6.5 s:

```sh
mise run test:logged -- --name merge-node-action-owner -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
```

Evidence: `/tmp/orkestrator-test-run.nqin2k/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No assertion or implementation changed. The cause remains unestablished.

### Resolution — 2026-11-06

**Root cause.** The over-limit case renders 501 rows, each a Radix checkbox,
three times (listing, Select all, Clear). Instrumented alone at a load average
of about 26, it took: `findByRole("checkbox", { name: "file-500.ts" })` 2.15 s,
Select all 1.20 s, Clear 1.06 s, the rest under 0.6 s. The whole case took
4.998 s, at the default deadline. Each `*ByRole` evaluation computes the
accessible name and visibility of all 501 checkboxes (about 350 ms per
`getByRole("checkbox", …)`), so polling `findByRole` alone cost over two
seconds. Rendering and re-rendering 501 rows is inherent to the over-limit
scenario.

**Reproduction.** A copy of the unchanged owner with
`-t over-limit --rerun-each=6` failed one of six at 5708 ms ("this test timed
out after 5000ms"), at a load average of about 22.

**Fix.** `apps/web/src/components/federation/node-action-requests.test.tsx`:
the test waits for the last row with `findByLabelText("file-500.ts")`, then
asserts that element's `role` is `checkbox` (about 1 s cheaper). The
over-limit case also gets an explicit 30 s budget (`OVER_LIMIT_BUDGET_MS`) for
its synchronous render work. The other states keep the default budget. No
assertion was removed.

**Verification.** The owner passed alone (15 pass; the over-limit case took
4.13 s at load about 20). Then
`mise run test:logged -- --name web-2402-fixed-stress -- bun --cwd=apps/web test src/components/federation/node-action-requests.test.tsx --rerun-each=6`
passed (exit 0, 28.1 s) at a load average of about 22.

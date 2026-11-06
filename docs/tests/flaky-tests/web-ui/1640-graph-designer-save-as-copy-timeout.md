# Graph designer "Save as copy" test hit the 5000 ms timeout in a parallel subset

- **ID:** 1640
- **Status:** open
- **Date observed:** 2026-11-01
- **Test:** `GraphDesignerTab editing > saves with compare-and-swap; a lost race keeps the draft and offers Save as copy`
- **File:** `apps/web/src/components/graph-designer/GraphDesignerEditing.test.tsx`
- **Original command:** `mise run test:logged -- --name web-launch -- bun --cwd=apps/web test src/components/review src/components/build src/components/environments src/components/launch src/components/graph-launch src/components/graph-designer src/components/settings src/components/layout src/components/kanban src/hooks/useBuildPipeline.test.tsx src/hooks/useBuildLaunchOptions.test.ts src/lib/agent-launch.test.ts src/lib/review-launch-options.test.ts src/lib/build-pipeline-persistence.test.ts src/lib/feature-build-launch.test.ts src/lib/create-environment-agent-defaults.test.ts src/components/build-pipeline --parallel=2 --only-failures`. Host load at the time was not measured.
- **Failure:** timed out after 5000 ms (5230.48 ms). The unhandled error between tests was at line 294, `TypeError: undefined is not an object (evaluating 'imported[1]')`: no `graph_template_import` call had been recorded when the late assertion ran. Suite counts: 2781 pass, 10 skip, 2 fail, 1 error, across 173 files. The other failure was an unrelated stale assertion, fixed in the same change.
- **Isolated rerun:** `bun --cwd=apps/web test src/components/graph-designer/GraphDesignerEditing.test.tsx --only-failures` passed: 5 pass, 42 expect() calls, 10.56 s.
- **Hypothesis:** load, unproven. The whole file takes over 10 s alone across five tests, so a single case may have little margin under a 5000 ms limit. The change under test edited no file in `graph-designer/`, though it did change `lib/agent-launch.ts`, which other components in that folder import. Next recurrence: time this case alone and in parallel.

## Recurrence — 2026-11-01 (throttled logger review)

Preparation's `mise run test` failed this unchanged owner (5363.50 ms; isolated owner passed in 3.1 s).
The aggregate runs bounded concurrent workspace, root, bridge and protocol groups;
its exact granted worker counts were not included in the review package.
The captured cross-suite totals are lower bounds: 31,617 passes, seven failures
(including four browser failures), and 310 not run. No timeout was changed.

`mise run test:logged -- --name recorded-graph-owner -- bun test --cwd apps/web ./src/components/graph-designer/GraphDesignerEditing.test.tsx --parallel=1 --only-failures` passed unchanged. The same owner also passed
alone on detached `origin/main` at `9eca79311b06e624e8799feb069052a7009eeeef`.
This isolated pass confirms intermittency, not a load-related root cause.
Original failure evidence: `.orkestrator/review-artifacts/review-validation-2b4eea63-cf5c-4639-ad6f-82564be561bf/validation-04.stdout.txt`.


## Task 1202 review repair — 2026-11-02

Original command: `ORKESTRATOR_TEST_ALLOW_CONCURRENT=1 mise run test:logged -- --name address-default-suite-concurrent -- mise run test`, workspace/root/bridge/protocol grants 6/1/2/1.
Group evidence: `orkestrator-test-run.WXZCOJ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`.

Aggregate timeout 6,305.63 ms. Complete branch owner failed (3 pass/2 fail/2 errors, 26.6 s); complete detached-main owner reproduced Save as copy timeout (5,287.79 ms; 4 pass/1 fail/1 error, 26.2 s). Main at 38d55ee14 used its own frozen dependency install. Branch artifact qbCR5s; main B5hJ0n.

The complete owner was rerun with `mise run test:logged -- --name address-graph-editing-rerun -- bun test --cwd apps/web ./src/components/graph-designer/GraphDesignerEditing.test.tsx --parallel=1 --only-failures`. No implementation, assertion, wait, timeout or skip was changed. This recurrence remains open.

Final aggregate counts: desktop 1,580 pass / 16 skip / 2 fail; backend
13,138 pass / 97 skip / 3 fail; web 11,230 pass / 10 skip / 7 fail; root
3,418 pass / 3 fail. Bridges and Codex protocol verification passed.
The aggregate exited 1 after 1,152.1 seconds; no watchdog or output limit fired.

## Investigation — 2026-11-06

Not fixed, still open. A JUnit-timed run of the unchanged owner alone took
0.55–0.73 s per case; this case took 0.73 s. The whole file took about 3.3 s at
a load average of about 20. The case is driven by synchronous `act()` calls on
mocked backend invokes, with no fixed sleep or timer wait. The late
`imported[1]` TypeError in the original report came after the timeout, not
before it. No race was found. Timing out needs about a sevenfold slowdown,
which matches the 26 s whole-file runs recorded on 2026-11-02. Next step:
profile `openForEditing` (the React Flow mount) under load before choosing
between less render work and an explicit budget.

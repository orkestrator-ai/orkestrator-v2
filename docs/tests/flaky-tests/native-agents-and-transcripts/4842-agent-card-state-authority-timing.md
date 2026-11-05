# Agent card state authority timing

- **ID:** 4842
- **Status:** open
- **Observed:** 2026-11-05
- **Test:** `AgentNativeTab progressive controller > keeps Claude agent-card position through unavailable-state until authority returns`
- **File:** `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx`

Preparation's `mise run test` at cd5b0142 reported this assertion after 1058.59 ms: the Stop Investigate rendering button was still present when absence was expected (line 676). The recorded aggregate had ten named failures and errors outside tests; the package does not provide a reliable combined test total. Worker allocation was controlled by the aggregate runner, not supplied explicitly on its command line.

The owning file passed alone on the repair branch with:

```sh
mise run test:logged -- --name recorded-agent-card -- bun --cwd=apps/web test src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures
```

The complete file passed in 8.5 seconds (114 output bytes; passing log removed by the logged runner). No assertion was weakened or skipped. The original failure remains in `.orkestrator/review-artifacts/review-validation-6e251f8d-c76b-469b-b389-d7b80e76ea49/validation-04.stdout.txt` around lines 1509–1522. The test waits for transcript text before checking state authority, while those reads run independently; ordering under aggregate load needs further investigation. This is a hypothesis, not an established cause.

On 2026-11-05, preparation at `366fa15c7` again reported the same Stop-button
assertion (1099.35 ms, line 676). The aggregate reported three failures (31,842
passed, 150 not run); worker allocation was controlled by the aggregate runner.
Evidence: `.orkestrator/review-artifacts/review-validation-4565b97a-56f2-49c1-85c0-4e153180ac69/validation-04.stderr.txt`, lines 568–580.
The complete owner passed alone in 15.6 s with
`NODE_ENV=test mise run test:logged -- --name recorded-agent-card -- bash -c 'cd apps/web && bun test ./src/components/native-agent/AgentNativeTab.progressive.test.tsx --parallel=1 --only-failures'`.
An initial invocation without `NODE_ENV=test` loaded production React and failed
with `React.act is not a function` (artifact `/tmp/orkestrator-test-run.FAgmsw`);
that invocation did not exercise the assertion. No test or renderer behavior
was changed. The existing independent-read ordering hypothesis remains unproven.

The failure does not depend on the E5 storage branch (`database-upkeep-ac99b5b934a3-r1`).
Its first recorded occurrence, at `cd5b0142`, is on the E8 branch, which is
neither an ancestor of nor a descendant of the E5 work. `git diff --stat
origin/main...HEAD -- apps/web` on the E5 branch is empty, so the branch
changes no renderer code, test or mock that this file loads. One possible
cause, not yet proven: after the `unavailable` read, the test's state mock answers
`unchanged` (`state-unscripted`) until `stateUpdates` is reassigned. A poll in
that window could restore Stop before the held state is installed.
